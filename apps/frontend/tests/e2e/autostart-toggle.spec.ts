import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { evidencePath, navigateTo } from "./helpers";

/**
 * Task 17 — Autostart streaming toggle (applied-state contract), end-to-end.
 *
 * Proves the Settings autostart switch against the REAL dev backend:
 *   - toggle ON  → backend persists + returns { applied: { autostart: true } };
 *     the switch locks to `applied` (aria-checked=true).
 *   - toggle OFF → returns { applied: { autostart: false } }; switch → false.
 *   - backend failure → error toast surfaces and the switch reverts (the
 *     AsyncSwitch is pessimistic, so a rejected call never flips the position).
 *
 * The WebSocket harness (installWsHarness, addInitScript) lets the test:
 *   1. Authenticate without the device password — the `auth.login` frame is
 *      rewritten to a valid persistent token read from `auth_tokens.json`.
 *   2. Capture the `applied.autostart` value from the real `system.setAutostart`
 *      response (success path) — proving the lock target, not the intent.
 *   3. Drop the `system.setAutostart` frame and reply with an error (failure
 *      path) so the toast + revert is deterministic.
 *
 * Prereq: backend on :3002 with NODE_ENV=development and the dev default
 * MOCK_SCENARIO. Frontend (Vite :6173) is started by playwright.config.
 */

const FAKE_ERR = "drop+fake: simulated setAutostart failure";

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

function installWsHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;
	const FAILURE_MESSAGE = "drop+fake: simulated setAutostart failure";

	w.__cera = {
		socket: null,
		_failAutostart: false,
		lastAutostartApplied: undefined,
		_pendingAutostartIds: {} as Record<string, true>,
	};

	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			w.__cera.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
			this.addEventListener("message", (ev: MessageEvent) => {
				try {
					const o = JSON.parse(ev.data);
					if (o && o.id && w.__cera._pendingAutostartIds[o.id]) {
						delete w.__cera._pendingAutostartIds[o.id];
						if (o.result && o.result.applied) {
							w.__cera.lastAutostartApplied = o.result.applied.autostart;
						}
					}
				} catch {
					/* non-JSON frame */
				}
			});
		}

		// biome-ignore lint/suspicious/noExplicitAny: WebSocket.send payload union.
		send(data: any) {
			try {
				const msg = JSON.parse(data);
				const p = Array.isArray(msg.path) ? msg.path.join(".") : null;

				if (p === "auth.login") {
					msg.input = { token, persistent_token: true };
					return this.__realSend(JSON.stringify(msg));
				}

				if (p === "system.setAutostart") {
					if (w.__cera._failAutostart) {
						const id = msg.id;
						setTimeout(() => {
							this.dispatchEvent(
								new MessageEvent("message", {
									data: JSON.stringify({
										id,
										error: { code: -32000, message: FAILURE_MESSAGE },
									}),
								}),
							);
						}, 0);
						return undefined;
					}
					w.__cera._pendingAutostartIds[msg.id] = true;
				}
			} catch {
				/* not an RPC frame (e.g. keepalive) */
			}
			return this.__realSend(data);
		}
	}

	w.WebSocket = HookedWS;
	try {
		localStorage.setItem("auth", "e2e-token-marker");
	} catch {
		/* localStorage unavailable */
	}
}

function autostartSwitch(page: Page) {
	return page.getByTestId("settings-autostart").getByRole("switch");
}

function appliedValue(page: Page): Promise<unknown> {
	// biome-ignore lint/suspicious/noExplicitAny: harness bridge.
	return page.evaluate(() => (window as any).__cera.lastAutostartApplied);
}

/** Normalise to a known OFF baseline via the real backend before asserting. */
async function ensureOff(page: Page): Promise<void> {
	const toggle = autostartSwitch(page);
	await expect(toggle).toBeVisible({ timeout: 10000 });
	if ((await toggle.getAttribute("aria-checked")) === "true") {
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false", {
			timeout: 10000,
		});
	}
}

function writeEvidence(fileName: string, lines: string[]): void {
	const file = evidencePath(fileName);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		[
			"Task 17 — Autostart streaming toggle (applied-state)",
			`Generated: ${new Date().toISOString()}`,
			"",
			...lines,
			"",
		].join("\n"),
		"utf8",
	);
}

test.describe.configure({ mode: "serial" });

test.describe("autostart toggle (applied-state)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser integration proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the settings toggle",
		);
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
		await navigateTo(page, "settings");
	});

	test("toggle ON → applied=true; toggle OFF → applied=false", async ({
		page,
	}) => {
		await ensureOff(page);
		const toggle = autostartSwitch(page);
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		// Toggle ON → real backend persists, returns applied:{autostart:true}.
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true", {
			timeout: 10000,
		});
		await expect
			.poll(() => appliedValue(page), {
				timeout: 5000,
				message: "setAutostart(true) should return applied.autostart=true",
			})
			.toBe(true);

		// Toggle OFF → applied:{autostart:false}.
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false", {
			timeout: 10000,
		});
		await expect
			.poll(() => appliedValue(page), {
				timeout: 5000,
				message: "setAutostart(false) should return applied.autostart=false",
			})
			.toBe(false);

		writeEvidence("task-17-autostart.txt", [
			"Scenario: real dev backend, applied-state lock.",
			"Located the Settings → Streaming → Autostart switch (data-testid=settings-autostart).",
			"Toggle ON  → switch aria-checked=true; RPC returned applied.autostart=true.",
			"Toggle OFF → switch aria-checked=false; RPC returned applied.autostart=false.",
			"Switch is locked to result.applied (post-persist value), not the intended click.",
			"Result: PASS",
		]);
	});

	test("backend failure → error toast + switch reverts", async ({ page }) => {
		await ensureOff(page);
		const toggle = autostartSwitch(page);
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		// Drop the next setAutostart frame and reply with an error.
		await page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: harness bridge.
			(window as any).__cera._failAutostart = true;
		});
		await toggle.click();

		await expect(page.getByText(FAKE_ERR)).toBeVisible();
		// Pessimistic AsyncSwitch: a rejected call never flips the position.
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		await page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: harness bridge.
			(window as any).__cera._failAutostart = false;
		});

		writeEvidence("task-17-autostart-fail.txt", [
			"Scenario: __cera._failAutostart = true (setAutostart frame dropped + error reply).",
			"Clicked the Autostart switch from OFF.",
			`Error toast surfaced: "${FAKE_ERR}"`,
			"Switch reverted/held at aria-checked=false (no optimistic flip; lock untouched).",
			"Result: PASS",
		]);
	});
});
