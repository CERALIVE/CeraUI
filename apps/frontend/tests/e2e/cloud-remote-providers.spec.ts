import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "./fixtures/index.js";

import { evidencePath, navigateTo } from "./helpers";

/**
 * Task 18 — Cloud-provider selector in CloudRemoteDialog, end-to-end.
 *
 * Proves the dialog's provider selector is POPULATED FROM THE BACKEND
 * (system.getCloudProviders) — not a hardcoded list — and that a selection is
 * persisted (applied) through the existing remote-config flow
 * (system.setRemoteConfig → backend persists → broadcasts the authoritative
 * `config`). Also proves the custom-provider escape hatch: selecting "Custom
 * Provider" reveals the manual endpoint field, which gates Save until a host is
 * entered.
 *
 * Harness (addInitScript): the app socket is wrapped so the test can
 *   1. authenticate without the device password (auth.login frame rewritten to a
 *      valid persistent token read from the backend's auth_tokens.json), and
 *   2. observe RPC frames the dialog sends — recording whether
 *      `system.getCloudProviders` was requested and the last
 *      `system.setRemoteConfig` input. Frames are NOT dropped: the real dev
 *      backend processes setRemoteConfig and broadcasts the applied config, so
 *      "applied" is verified against the real reconnect/seed path.
 *
 * Prereq (playwright.config webServer): frontend (Vite :6173) + real dev backend
 * (:3002, NODE_ENV=development, MOCK_SCENARIO=multi-modem-wifi).
 */

const TOKEN: string = (() => {
	const tokensPath = path.resolve(
		import.meta.dirname,
		"../../../backend/auth_tokens.json",
	);
	const tokens = Object.keys(
		JSON.parse(fs.readFileSync(tokensPath, "utf8")) as Record<string, true>,
	);
	if (tokens.length === 0) {
		throw new Error(
			`No persistent auth tokens in ${tokensPath}; cannot authenticate e2e socket.`,
		);
	}
	return tokens[0];
})();

/**
 * Browser-side WebSocket harness. Serialized into the page via addInitScript;
 * must be self-contained (no outer-scope refs except its `token` argument).
 */
function installWsHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		getCloudProvidersCalled: false,
		lastSetRemoteConfig: null as unknown,
	};

	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			w.__cera.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
		}

		// biome-ignore lint/suspicious/noExplicitAny: WebSocket.send payload union.
		send(data: any) {
			try {
				const msg = JSON.parse(data);
				const p = Array.isArray(msg.path) ? msg.path.join(".") : null;

				// Auth without the device password: rewrite to a valid token.
				if (p === "auth.login") {
					msg.input = { token, persistent_token: true };
					return this.__realSend(JSON.stringify(msg));
				}

				// Observe (do NOT drop) the dialog's provider-related RPC frames.
				if (p === "system.getCloudProviders") {
					w.__cera.getCloudProvidersCalled = true;
				}
				if (p === "system.setRemoteConfig") {
					w.__cera.lastSetRemoteConfig = msg.input ?? null;
				}
			} catch {
				/* not an RPC frame (e.g. keepalive) */
			}
			return this.__realSend(data);
		}
	}

	w.WebSocket = HookedWS;
	// Non-empty value makes Layout attempt auto-login on load; the harness
	// rewrites that login frame to the token. Survives reconnect re-auth too.
	try {
		localStorage.setItem("auth", "e2e-token-marker");
	} catch {
		/* localStorage unavailable */
	}
}

function writeEvidence(fileName: string, lines: string[]): void {
	const file = evidencePath(fileName);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		[
			"Task 18 — Cloud-provider selector in CloudRemoteDialog",
			`Generated: ${new Date().toISOString()}`,
			"",
			...lines,
			"",
		].join("\n"),
		"utf8",
	);
}

const DIALOG = "Cloud Remote Server";

async function openCloudRemote(page: Page) {
	await navigateTo(page, "settings");
	await page.getByRole("button", { name: DIALOG }).click();
	await expect(page.getByRole("dialog", { name: DIALOG })).toBeVisible();
}


test.describe("Cloud-provider selector (Task 18)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser integration proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the dialog selector",
		);
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
		// Auto-login (localStorage 'auth' → token rewrite) lands the authed shell.
		await navigateTo(page, "settings");
	});

	test.afterEach(async ({ page }) => {
		// Restore remote_provider to 'ceralive' after each test to prevent
		// subsequent tests from seeing a stale 'custom' provider in the config.
		// The custom provider test persists provider: 'custom' to the backend;
		// this cleanup ensures the next test starts with a clean state.
		await page.evaluate(async () => {
			const w = window as any;
			if (w.__cera?.socket) {
				return new Promise<void>((resolve) => {
					const id = Math.random();
					const msg = {
						id,
						path: ["system", "setRemoteConfig"],
						input: {
							remote_key: "mock-pairing-key",
							provider: "ceralive",
						},
					};

					// Listen for the response to this specific RPC call.
					const originalOnMessage = w.__cera.socket.onmessage;
					w.__cera.socket.onmessage = (event: MessageEvent) => {
						try {
							const response = JSON.parse(event.data);
							if (response.id === id) {
								// Got the response to our cleanup RPC; restore the original handler.
								w.__cera.socket.onmessage = originalOnMessage;
								resolve();
								return;
							}
						} catch {
							/* not JSON */
						}
						// Pass through to the original handler.
						if (originalOnMessage) {
							originalOnMessage(event);
						}
					};

					w.__cera.socket.send(JSON.stringify(msg));
				});
			}
		});
	});

	test("selector is populated from getCloudProviders(); pick CeraLive → saved (applied)", async ({
		page,
	}) => {
		await openCloudRemote(page);
		const dialog = page.getByRole("dialog", { name: DIALOG });

		// 1) The dialog requested the provider list from the backend (not hardcoded).
		await expect
			.poll(
				() => page.evaluate(() => (window as any).__cera.getCloudProvidersCalled),
				{
					timeout: 8000,
					message: "dialog should call system.getCloudProviders on open",
				},
			)
			.toBe(true);

		// 2) The selector lists the backend providers + the custom escape hatch.
		const trigger = dialog.locator("#cloud-provider");
		await trigger.click();
		await expect(page.getByRole("option", { name: "CeraLive Cloud" })).toBeVisible();
		await expect(page.getByRole("option", { name: "BELABOX Cloud" })).toBeVisible();
		await expect(page.getByRole("option", { name: "Custom Provider" })).toBeVisible();

		// 3) Pick CeraLive Cloud → trigger reflects the choice.
		await page.getByRole("option", { name: "CeraLive Cloud" }).click();
		await expect(trigger).toContainText("CeraLive Cloud");

		// 4) Save → setRemoteConfig fires with provider 'ceralive'.
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect
			.poll(
				() =>
					page.evaluate(
						() => (window as any).__cera.lastSetRemoteConfig?.provider ?? null,
					),
				{ timeout: 8000, message: "Save should send setRemoteConfig(provider)" },
			)
			.toBe("ceralive");

		// Dialog closes on a successful save.
		await expect(dialog).toBeHidden();

		// 5) APPLIED: reopen → the selector is seeded from the backend-persisted
		//    config (broadcast `config.remote_provider`), proving the choice stuck.
		await page.getByRole("button", { name: DIALOG }).click();
		await expect(dialog).toBeVisible();
		await expect(dialog.locator("#cloud-provider")).toContainText("CeraLive Cloud");

		const sent = (await page.evaluate(
			() => (window as any).__cera.lastSetRemoteConfig,
		)) as { provider?: string };
		writeEvidence("task-18-providers.txt", [
			"Scenario: provider selector sourced from system.getCloudProviders()",
			"",
			"1. Dialog opened → system.getCloudProviders requested over the socket",
			"   (window.__cera.getCloudProvidersCalled === true). NOT a hardcoded list.",
			"2. Selector options rendered: CeraLive Cloud, BELABOX Cloud (backend",
			"   CLOUD_PROVIDERS) + Custom Provider (i18n custom escape hatch).",
			"3. Picked 'CeraLive Cloud'.",
			`4. Save → system.setRemoteConfig input: ${JSON.stringify(sent)}`,
			"   provider === 'ceralive'. Dialog closed on success.",
			"5. APPLIED: reopened dialog; selector seeded from backend-persisted",
			"   config.remote_provider → trigger shows 'CeraLive Cloud'.",
			"Result: PASS",
		]);
	});

	test("custom provider → manual endpoint field appears and validates Save", async ({
		page,
	}) => {
		await openCloudRemote(page);
		const dialog = page.getByRole("dialog", { name: DIALOG });

		// Select the custom escape hatch.
		await dialog.locator("#cloud-provider").click();
		await page.getByRole("option", { name: "Custom Provider" }).click();

		// Manual endpoint fields are revealed ONLY for custom.
		const host = dialog.locator("#custom-host");
		await expect(dialog.locator("#custom-name")).toBeVisible();
		await expect(host).toBeVisible();

		// Validation: Save is disabled until a host is entered.
		const save = dialog.getByRole("button", { name: "Save" });
		await expect(save).toBeDisabled();

		await host.fill("remote.example.com");
		await expect(save).toBeEnabled();

		// Persist → setRemoteConfig carries the custom provider host.
		await save.click();
		await expect
			.poll(
				() =>
					page.evaluate(
						() => (window as any).__cera.lastSetRemoteConfig?.provider ?? null,
					),
				{ timeout: 8000, message: "Save should send setRemoteConfig(custom)" },
			)
			.toBe("custom");
		await expect(dialog).toBeHidden();

		const sent = (await page.evaluate(
			() => (window as any).__cera.lastSetRemoteConfig,
		)) as { provider?: string; custom_provider?: { host?: string } };
		expect(sent.custom_provider?.host).toBe("remote.example.com");

		writeEvidence("task-18-custom.txt", [
			"Scenario: custom-provider escape hatch + manual-endpoint validation",
			"",
			"1. Selected 'Custom Provider' from the selector.",
			"2. Manual endpoint fields revealed (#custom-name, #custom-host) —",
			"   shown ONLY for the custom provider.",
			"3. VALIDATION: Save disabled while host empty; enabled after entering",
			"   'remote.example.com'.",
			`4. Save → system.setRemoteConfig input: ${JSON.stringify(sent)}`,
			"   provider === 'custom', custom_provider.host === 'remote.example.com'.",
			"Result: PASS",
		]);
	});
});
