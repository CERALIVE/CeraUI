import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { evidencePath, navigateTo } from "./helpers";

/**
 * T2 — dev-only reboot disconnect simulation, @functional.
 *
 * Proves the DisconnectedBanner reconnect UX end-to-end against the REAL
 * frontend stack. On a real device `system.reboot` returns `{success:true}`,
 * the frontend latches "rebooting", then the host goes down and the socket
 * drops; the device boots, the client reconnects + re-authenticates, and the
 * banner clears. In dev the OS spawn is gated off (T1), so the backend instead
 * calls `simulateDevReboot()` (T2), which drops the authenticated sockets to
 * reproduce that sequence.
 *
 * ── Why this drives the disconnect page-locally ──────────────────────────────
 * `simulateDevReboot()` closes EVERY authenticated socket on the shared dev
 * backend by design (a reboot takes the whole device down). Invoking it for
 * real here would drop the sockets of OTHER Playwright workers mid-test. So,
 * exactly like field-lock.spec.ts lifecycle 3, this spec reproduces the device
 * going down by closing only ITS OWN socket, after drop+faking the reboot reply
 * (`{success:true}`) so the real PowerDialog → markRebooting → banner flow runs
 * deterministically. The backend's all-socket teardown + prod no-op is proven
 * separately by the unit test (apps/backend/src/tests/dev-reboot-disconnect).
 *
 * Flow asserted:
 *   1. Reboot via the REAL PowerDialog → markRebooting → banner "rebooting".
 *   2. The socket drops (device down); the transport auto-reconnects and the
 *      harness re-authenticates (token rewrite) — no token is force-invalidated.
 *   3. On reconnect the banner CLEARS and an authed surface renders, proving the
 *      reconnect + re-auth completed (the app never falls back to login).
 *
 * Prereq: backend on :3002 (NODE_ENV=development, MOCK_SCENARIO=multi-modem-wifi);
 * frontend started by playwright.config webServer.
 */

const POWER_DIALOG = "Reboot / Power";
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

/**
 * Browser-side WebSocket harness. Serialized into the page via addInitScript;
 * must be fully self-contained (no outer-scope references except its `token`).
 * Rewrites every `auth.login` (initial AND post-reconnect re-auth) to the token,
 * and drop+fakes any RPC armed in `_fake` so its result is deterministic.
 */
function installWsHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		// Map<path, result>: a matched RPC never reaches the backend; it resolves
		// locally with this result so the reboot reply is deterministic without
		// the real backend closing every authed socket.
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
	// Non-empty marker makes the app auto-login on load AND on every reconnect;
	// the harness rewrites that login frame to the token.
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

async function openSettingsDialog(page: Page, name: RegExp): Promise<void> {
	await page.locator("header").first().waitFor({ state: "visible", timeout: 30_000 });
	await navigateTo(page, "settings");
	await page.getByRole("button", { name }).first().click();
}

test.describe(
	"dev reboot disconnect — rebooting banner then reconnect + re-auth",
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
				"T2 — dev reboot disconnect simulation: functional E2E evidence",
				"Driver: real frontend (PowerDialog → rpc.system.reboot → markRebooting →",
				"        DisconnectedBanner + connection-ux store). Reboot reply drop+faked",
				"        {success:true}; the device-down disconnect is reproduced page-locally",
				"        (own socket closed) to avoid dropping other workers' sockets — the",
				"        backend all-socket teardown is proven by the backend unit test.",
				`Generated: ${new Date().toISOString()}`,
				"",
			];
			fs.writeFileSync(
				evidencePath("task-2-dev-reboot-disconnect.txt"),
				[...header, ...evidence, ""].join("\n"),
				"utf8",
			);
		});

		test("reboot in dev → rebooting banner → clears on reconnect + re-auth", async ({
			page,
		}) => {
			record("── dev reboot disconnect ──");

			// Baseline: authed shell up, no banner.
			await navigateTo(page, "settings");
			await expect(page.locator(ANY_BANNER)).toHaveCount(0);
			record("authed shell up, no disconnect banner");

			// Drive the REAL reboot flow; drop+fake the reply so markRebooting fires
			// deterministically (mirrors the dev backend's {success:true}).
			await armFake(page, "system.reboot", { success: true });
			await openSettingsDialog(page, /Reboot \/ Power/);
			const power = page.getByRole("dialog", { name: POWER_DIALOG });
			await expect(power).toBeVisible();
			await power.getByRole("button", { name: "Reboot", exact: true }).click();
			const confirm = page.getByRole("dialog", { name: "Are you sure?" });
			await expect(confirm).toBeVisible();
			await confirm.getByRole("button", { name: "Reboot", exact: true }).click();
			record("confirmed reboot → markRebooting()");

			// markRebooting latched → the banner shows the "rebooting" treatment.
			await expect(page.locator(REBOOTING_BANNER)).toBeVisible({ timeout: 15_000 });
			record('DisconnectedBanner showing "rebooting" state ✓');

			// Device goes down: drop the socket (page-local, like simulateDevReboot
			// would on hardware). The latch holds "rebooting" across the drop.
			await page.evaluate(() => (window as any).__cera.dropSocket());
			await expect(page.locator(REBOOTING_BANNER)).toBeVisible();
			record("socket dropped (device down) → banner held at rebooting ✓");

			// The transport auto-reconnects and the harness re-authenticates; the
			// reconnect "connected" clears the rebooting latch → banner disappears.
			await expect(page.locator(ANY_BANNER)).toHaveCount(0, { timeout: 30_000 });
			record("socket reconnected → banner CLEARED ✓");

			// Re-auth proof: the app never routed to the login screen and the authed
			// settings surface renders again (the backend only serves device state to
			// an authenticated socket, so this surface proves re-auth succeeded and no
			// token was force-invalidated).
			await expect(page.locator("#password")).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: /Reboot \/ Power/ }),
			).toBeVisible({ timeout: 15_000 });
			record("re-authenticated (no login screen) + authed surface rendered ✓");
		});
	},
);
