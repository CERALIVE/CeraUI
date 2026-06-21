import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { evidencePath, navigateTo } from "./helpers";

/**
 * T14 — reboot countdown + failure recovery, @functional.
 *
 * Builds on the T2 dev-reboot-disconnect harness. The PowerDialog now runs an
 * in-dialog countdown over the reconnect window after a confirmed reboot:
 *
 *   • Countdown → reconnect (the happy path): the dialog shows the countdown and
 *     the DisconnectedBanner shows "rebooting"; when the device goes down and the
 *     socket reconnects, the rebooting latch clears, the banner disappears, and
 *     the dialog closes — handing the screen back to the authed settings surface.
 *
 *   • Still-reachable → recovery (the failure path): a reboot that returns
 *     {success:true} but never takes the device down leaves the socket connected.
 *     When the countdown elapses while STILL connected, the reboot never happened,
 *     so the dialog clears the misleading "rebooting" banner and surfaces a calm
 *     recovery hint with a retry — instead of the banner lying "rebooting" forever.
 *
 * Like T2 this reproduces the device-down disconnect PAGE-LOCALLY (closing only
 * the page's own socket) so it never drops other Playwright workers' sockets, and
 * drop+fakes the reboot reply {success:true} so the real PowerDialog flow runs
 * deterministically. The reconnect window is shrunk per-test via the
 * `__ceraRebootCountdownSeconds` override so the recovery path needs no 45s wait.
 */

const POWER_DIALOG = "Reboot / Power";
const COUNTING = '[data-reboot-phase="counting"]';
const RECOVERY = '[data-reboot-phase="recovery"]';
const REBOOTING_BANNER = '[data-disconnect-banner="rebooting"]';
const ANY_BANNER = "[data-disconnect-banner]";

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

const evidence: string[] = [];
function record(line: string): void {
	evidence.push(line);
}

// Browser-side WebSocket harness — serialized into the page via addInitScript;
// fully self-contained except its `token`. Rewrites every `auth.login` to the
// token and drop+fakes any RPC armed in `_fake`, so the reboot reply is
// deterministic without the backend closing every authed socket. (Mirrors T2.)
function installWsHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		_fake: {} as Record<string, unknown>,
		dropSocket() {
			const s = w.__cera.socket;
			if (s) s.close();
		},
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

				if (p === "auth.login") {
					msg.input = { token, persistent_token: true };
					return this.__realSend(JSON.stringify(msg));
				}

				if (p && Object.prototype.hasOwnProperty.call(w.__cera._fake, p)) {
					const result = w.__cera._fake[p];
					const id = msg.id;
					setTimeout(
						() =>
							this.dispatchEvent(
								new MessageEvent("message", {
									data: JSON.stringify({ id, result }),
								}),
							),
						0,
					);
					return undefined;
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

function armFake(page: Page, rpcPath: string, result: unknown): Promise<void> {
	return page.evaluate(
		([pth, res]) => {
			(window as any).__cera._fake[pth] = res;
		},
		[rpcPath, result] as const,
	);
}

function setCountdownSeconds(page: Page, seconds: number): Promise<void> {
	return page.evaluate((s) => {
		(window as any).__ceraRebootCountdownSeconds = s;
	}, seconds);
}

async function openPowerDialog(page: Page): Promise<void> {
	await page.locator("header").first().waitFor({ state: "visible", timeout: 30_000 });
	await navigateTo(page, "settings");
	await page.getByRole("button", { name: /Reboot \/ Power/ }).first().click();
}

async function confirmReboot(page: Page): Promise<void> {
	const power = page.getByRole("dialog", { name: POWER_DIALOG });
	await expect(power).toBeVisible();
	await power.getByRole("button", { name: "Reboot", exact: true }).click();
	const confirm = page.getByRole("dialog", { name: "Are you sure?" });
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Reboot", exact: true }).click();
}

test.describe(
	"reboot countdown + failure recovery",
	{ tag: "@functional" },
	() => {
		test.skip(
			({ browserName }) => browserName !== "chromium",
			"single-browser integration proof",
		);

		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"desktop layout drives the settings dialogs",
			);
			await page.addInitScript(installWsHarness, TOKEN);
			await page.goto("/");
			await page
				.waitForFunction(() => (window as any).__ceraAppMounted === true, undefined, {
					timeout: 60_000,
				})
				.catch(() => undefined);
			await page.evaluate(() => document.getElementById("js-failed")?.remove());
		});

		test.afterAll(async () => {
			const header = [
				"T14 — reboot countdown + failure recovery: functional E2E evidence",
				"Driver: real frontend (PowerDialog countdown state machine + connection-ux",
				"        store + DisconnectedBanner). Reboot reply drop+faked {success:true};",
				"        device-down disconnect reproduced page-locally (own socket closed).",
				"        Reconnect window shrunk via __ceraRebootCountdownSeconds override.",
				`Generated: ${new Date().toISOString()}`,
				"",
			];
			fs.writeFileSync(
				evidencePath("task-14-reboot-countdown-recovery.txt"),
				[...header, ...evidence, ""].join("\n"),
				"utf8",
			);
		});

		test("countdown shows, banner shows, then both clear on reconnect", async ({
			page,
		}) => {
			record("── countdown → reconnect ──");

			await navigateTo(page, "settings");
			await expect(page.locator(ANY_BANNER)).toHaveCount(0);
			record("authed shell up, no disconnect banner");

			await armFake(page, "system.reboot", { success: true });
			// Long window so the reconnect (not the timeout) is what ends the flow.
			await setCountdownSeconds(page, 30);
			await openPowerDialog(page);
			await confirmReboot(page);
			record("confirmed reboot → markRebooting() + countdown");

			// The dialog shows the countdown AND the banner shows "rebooting".
			await expect(page.locator(COUNTING)).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(REBOOTING_BANNER)).toBeVisible();
			record("countdown shown in dialog + banner showing rebooting ✓");

			// Device goes down: drop the page's own socket; the rebooting latch
			// holds across the drop.
			await page.evaluate(() => (window as any).__cera.dropSocket());
			await expect(page.locator(REBOOTING_BANNER)).toBeVisible();
			record("socket dropped (device down) → banner held at rebooting ✓");

			// Transport reconnects + re-auths → latch clears → banner gone AND the
			// countdown dialog closes (handing the screen back to the settings UI).
			await expect(page.locator(ANY_BANNER)).toHaveCount(0, { timeout: 30_000 });
			await expect(page.locator(COUNTING)).toHaveCount(0);
			record("reconnected → banner CLEARED + countdown dialog closed ✓");

			await expect(page.locator("#password")).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: /Reboot \/ Power/ }),
			).toBeVisible({ timeout: 15_000 });
			record("re-authenticated (no login screen) + authed surface rendered ✓");
		});

		test("still-reachable after the window → calm recovery hint, banner cleared", async ({
			page,
		}) => {
			record("── still-reachable → recovery ──");

			await navigateTo(page, "settings");
			await expect(page.locator(ANY_BANNER)).toHaveCount(0);

			await armFake(page, "system.reboot", { success: true });
			// Short window; the socket is NEVER dropped, so it elapses while still
			// connected → the reboot is judged to have failed.
			await setCountdownSeconds(page, 2);
			await openPowerDialog(page);
			await confirmReboot(page);
			record("confirmed reboot → countdown, socket left connected");

			await expect(page.locator(COUNTING)).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(REBOOTING_BANNER)).toBeVisible();
			record("countdown shown + rebooting banner showing ✓");

			// Window elapses while still reachable → recovery hint, and the
			// misleading "rebooting" banner is cleared.
			await expect(page.locator(RECOVERY)).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(ANY_BANNER)).toHaveCount(0);
			record("recovery hint shown + rebooting banner cleared ✓");

			// The recovery hint offers a retry and a dismiss; dismiss closes it and
			// leaves the operator on a working, reachable device.
			const recovery = page.locator(RECOVERY);
			await expect(
				recovery.getByRole("button", { name: "Reboot again" }),
			).toBeVisible();
			await recovery.getByRole("button", { name: "Dismiss" }).click();
			await expect(page.locator(RECOVERY)).toHaveCount(0);
			await expect(page.locator(ANY_BANNER)).toHaveCount(0);
			record("dismissed recovery → dialog closed, no banner ✓");
		});

		test("reboot stays blocked while streaming", async ({ page }) => {
			record("── streaming block preserved ──");

			// Force the device into a streaming state at the WS level so the backend
			// guard reflects in the dialog (mirrors the PowerDialog blocked-reason).
			await page.evaluate(() => {
				const w = window as any;
				const s = w.__cera?.socket;
				if (s)
					s.dispatchEvent(
						new MessageEvent("message", {
							data: JSON.stringify({ status: { is_streaming: true } }),
						}),
					);
			});

			await openPowerDialog(page);
			const power = page.getByRole("dialog", { name: POWER_DIALOG });
			await expect(power).toBeVisible();
			await expect(
				power.getByRole("button", { name: "Reboot", exact: true }),
			).toBeDisabled();
			await expect(page.locator(COUNTING)).toHaveCount(0);
			record("reboot button disabled while streaming, no countdown reachable ✓");
		});
	},
);
