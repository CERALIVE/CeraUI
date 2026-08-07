import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "./fixtures/index.js";

import { evidencePath, navigateTo } from "./helpers";

/**
 * Reconnect-banner grace period, @functional.
 *
 * The "Connection lost" banner used to appear the INSTANT `isConnected` flipped
 * false, so every heartbeat-triggered re-dial — including the ones that healed in
 * under a second — flashed a scary banner at the operator and read as sustained
 * instability. `deriveConnectionUx` now gates that treatment on the drop having
 * PERSISTED for `RECONNECT_BANNER_GRACE_MS`.
 *
 * Two halves, both driven against the REAL frontend stack:
 *   1. A drop that heals quickly is completely silent.
 *   2. A drop that persists surfaces the banner — but only after the grace.
 *
 * ── Why the assertion is a DELAY, not a presence check ───────────────────────
 * "The banner never appeared" would be hostage to how fast the transport happens
 * to reconnect on the day. The page records WHEN the banner first appeared
 * relative to the drop instead, so a slow environment that legitimately outlasts
 * the grace still passes, while the regression this guards (a banner at ~0 ms)
 * always fails. No sleeps, per the PLAYBOOK.
 *
 * Topology: local Vite dev on :6173 uses `__ceraSocketPort`; CI prebuilt Vite
 * preview on :6173 uses the HttpOnly cookie. Both target this worker's 31xx
 * development backend.
 */

const RECONNECTING_BANNER = '[data-disconnect-banner="reconnecting"]';
const ANY_BANNER = "[data-disconnect-banner]";

/** Mirrors `RECONNECT_BANNER_GRACE_MS` in `$lib/stores/connection-ux.svelte`. */
const GRACE_MS = 3000;

/** Slack for observer/scheduling latency when asserting the lower bound. */
const OBSERVER_SLACK_MS = 150;

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
 * Browser-side WebSocket harness + banner-appearance recorder. Serialized into
 * the page via addInitScript; must be fully self-contained (no outer-scope
 * references except its `token`).
 *
 * `block` sends the next socket at a dead port so a drop can be held open for
 * longer than the grace period without touching the transport's own backoff.
 */
function installHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		block: false,
		droppedAt: null as number | null,
		bannerFirstSeenAt: null as number | null,
		markDrop() {
			w.__cera.droppedAt = performance.now();
			w.__cera.bannerFirstSeenAt = null;
			const s = w.__cera.socket;
			if (s) s.close();
		},
		/** ms between the drop and the banner first appearing; null = never seen. */
		bannerDelayMs(): number | null {
			const { droppedAt, bannerFirstSeenAt } = w.__cera;
			if (droppedAt === null || bannerFirstSeenAt === null) return null;
			return bannerFirstSeenAt - droppedAt;
		},
		isSocketOpen(): boolean {
			return w.__cera.socket?.readyState === 1;
		},
	};

	const noteBanner = (): void => {
		if (w.__cera.bannerFirstSeenAt !== null) return;
		if (document.querySelector('[data-disconnect-banner="reconnecting"]')) {
			w.__cera.bannerFirstSeenAt = performance.now();
		}
	};
	// Observe the Document node, not `documentElement` — an init script runs
	// before the page's own scripts, so the root element may not exist yet and
	// `observe(null)` would throw and take the whole harness down with it.
	new MutationObserver(noteBanner).observe(document, {
		childList: true,
		subtree: true,
	});

	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(w.__cera.block ? String(url).replace(/:\d+/, ":1") : url, protocols);
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

function bannerDelay(page: Page): Promise<number | null> {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	return page.evaluate(() => (window as any).__cera.bannerDelayMs());
}

test.describe(
	"reconnect banner grace period — a short drop stays silent",
	{ tag: "@functional" },
	() => {
		test.skip(
			({ browserName }) => browserName !== "chromium",
			"single-browser integration proof",
		);

		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"desktop layout drives the authed shell",
			);
			await page.addInitScript(installHarness, TOKEN);
			await page.goto("/");
			await page
				.waitForFunction(
					// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
					() => (window as any).__ceraAppMounted === true,
					undefined,
					{ timeout: 60_000 },
				)
				.catch(() => undefined);
			await page.evaluate(() => document.getElementById("js-failed")?.remove());
		});

		test.afterAll(async () => {
			const header = [
				"Reconnect-banner grace period: functional E2E evidence",
				"Driver: real frontend (rpcClient reconnect → connection-ux store →",
				"        DisconnectedBanner). The drop is page-local (own socket closed);",
				"        a held-open drop points the next socket at a dead port so the",
				"        transport's own backoff is untouched.",
				`Grace period asserted: ${GRACE_MS} ms`,
				`Generated: ${new Date().toISOString()}`,
				"",
			];
			fs.writeFileSync(
				evidencePath("reconnect-banner-grace.txt"),
				[...header, ...evidence, ""].join("\n"),
				"utf8",
			);
		});

		test("a drop that heals quickly never flashes the banner", async ({
			page,
		}) => {
			record("── short drop ──");

			await navigateTo(page, "settings");
			await expect(page.locator(ANY_BANNER)).toHaveCount(0);
			record("authed shell up, no disconnect banner");

			// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
			await page.evaluate(() => (window as any).__cera.markDrop());
			record("socket dropped (heartbeat-style re-dial)");

			await expect
				// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
				.poll(() => page.evaluate(() => (window as any).__cera.isSocketOpen()), {
					timeout: 30_000,
				})
				.toBe(true);
			record("transport reconnected");

			const delay = await bannerDelay(page);
			record(
				delay === null
					? "banner NEVER appeared ✓"
					: `banner appeared after ${Math.round(delay)} ms ✓`,
			);
			// Either it never appeared (the fast heal we expect), or the environment
			// was slow enough that the drop genuinely outlasted the grace. The
			// regression — a banner at ~0 ms — fails both ways.
			if (delay !== null) {
				expect(delay).toBeGreaterThanOrEqual(GRACE_MS - OBSERVER_SLACK_MS);
			}

			await expect(page.locator(ANY_BANNER)).toHaveCount(0);
			await expect(page.locator("#password")).toHaveCount(0);
			record("re-authenticated, no banner on screen ✓");
		});

		test("a drop that persists surfaces the banner, then clears on reconnect", async ({
			page,
		}) => {
			record("── persisting drop ──");

			await navigateTo(page, "settings");
			await expect(page.locator(ANY_BANNER)).toHaveCount(0);

			await page.evaluate(() => {
				// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
				const c = (window as any).__cera;
				c.block = true;
				c.markDrop();
			});
			record("socket dropped and held down (reconnects sent to a dead port)");

			await expect(page.locator(RECONNECTING_BANNER)).toBeVisible({
				timeout: 30_000,
			});
			const delay = await bannerDelay(page);
			record(`banner appeared after ${Math.round(delay ?? -1)} ms`);
			expect(delay).not.toBeNull();
			expect(delay as number).toBeGreaterThanOrEqual(
				GRACE_MS - OBSERVER_SLACK_MS,
			);
			record("banner withheld for the full grace period ✓");

			// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
			await page.evaluate(() => ((window as any).__cera.block = false));
			await expect(page.locator(ANY_BANNER)).toHaveCount(0, {
				timeout: 60_000,
			});
			await expect(page.locator("#password")).toHaveCount(0);
			record("reconnected → banner CLEARED, still authenticated ✓");
		});
	},
);
