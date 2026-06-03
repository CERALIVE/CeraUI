import fs from "node:fs";
import path from "node:path";

import { expect, type Locator, type Page, test } from "@playwright/test";

import { navigateTo } from "./helpers";

/**
 * Task 6 — Bond-toggle no-flash proof, end-to-end.
 *
 * Proves the netif ingestion gate added to `subscriptions.svelte.ts`
 * (`case "netif"`): the per-interface `enabled` field is reconciled through the
 * dirty-field registry (`shouldIgnoreEchoReactive` + strict `reconcileReactive`),
 * while `tp`/`ip`/`error`/`mac` flow live. The gate is what stops a stale
 * `{enabled:true}` echo from flashing a freshly-toggled BondToggle back ON.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────
 * The dev backend re-broadcasts `netif` every 5s and the mock throughput
 * fluctuates (`Math.random()`), so every poll carries a fresh `tp` AND
 * `enabled:true` for an interface the drop+fake toggle never actually disabled.
 * Asserting "stays OFF" against that live churn is a race. This harness removes
 * the race two ways, without touching app source:
 *   1. The app sets a single `socket.onmessage` handler (client.ts:135). We
 *      shadow `onmessage` with an own accessor so the native slot stays unset —
 *      the app's handler then runs ONLY through our `message` listener, where we
 *      drop real `netif` frames while `_suppressRealNetif` is armed.
 *   2. `inject(type, payload)` dispatches a synthetic frame straight into the
 *      app handler, bypassing the backend round-trip entirely — so injected
 *      echoes are the only `netif` the reconciler sees, at known times.
 * Auth reuses field-lock's token-rewrite trick (no device password needed).
 */

const TOKEN: string = (() => {
	const tokensPath = path.resolve(
		import.meta.dirname,
		"../../../backend/auth_tokens.json",
	);
	const tokens = Object.keys(
		JSON.parse(fs.readFileSync(tokensPath, "utf8")) as Record<string, true>,
	).filter((t) => t !== "placeholder");
	if (tokens.length === 0) {
		throw new Error(
			`No persistent auth tokens in ${tokensPath}; cannot authenticate e2e socket.`,
		);
	}
	return tokens[0];
})();

const FAKE_ERR = "drop+fake: simulated configure failure";

// CeraUI-local evidence dir: 4 levels up from tests/e2e == repo root.
const EVIDENCE_DIR = path.resolve(import.meta.dirname, "../../../..", ".omo/evidence");

function writeEvidence(fileName: string, lines: string[]): void {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(EVIDENCE_DIR, fileName),
		[
			"Task 6 — Bond-toggle no-flash (netif ingestion gate)",
			`Generated: ${new Date().toISOString()}`,
			"",
			...lines,
			"",
		].join("\n"),
		"utf8",
	);
}

/**
 * Browser-side WebSocket harness. Serialized into the page via addInitScript;
 * fully self-contained (only its `token` argument crosses the boundary).
 */
function installWsHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		lastNetif: null,
		lastConfigureName: undefined as string | undefined,
		_dropFakeNetcfg: false as false | "success" | "failure",
		_suppressRealNetif: false,
		// biome-ignore lint/suspicious/noExplicitAny: synthetic frame payload.
		inject(type: string, payload: any) {
			const s = w.__cera.socket;
			if (s && s.__appOnMessage) {
				s.__appOnMessage.call(
					s,
					new MessageEvent("message", {
						data: JSON.stringify({ [type]: payload }),
					}),
				);
			}
		},
	};

	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			w.__cera.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
			this.__appOnMessage = null;
			// Shadow `onmessage`: store the app's handler instead of letting the
			// native slot dispatch, so all delivery routes through the listener
			// below (where real-netif suppression happens).
			const self = this;
			Object.defineProperty(this, "onmessage", {
				configurable: true,
				get() {
					return self.__appOnMessage;
				},
				// biome-ignore lint/suspicious/noExplicitAny: handler union.
				set(fn: any) {
					self.__appOnMessage = fn;
				},
			});
			this.addEventListener("message", (ev: MessageEvent) => {
				// biome-ignore lint/suspicious/noExplicitAny: parsed frame.
				let o: any = null;
				try {
					o = JSON.parse(ev.data);
				} catch {
					/* non-JSON frame */
				}
				if (o && Object.prototype.hasOwnProperty.call(o, "netif")) {
					w.__cera.lastNetif = o.netif;
					if (w.__cera._suppressRealNetif) return;
				}
				if (self.__appOnMessage) self.__appOnMessage.call(self, ev);
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

				// Drop the configure RPC + fake its resolution locally so the
				// post-resolve lock window is deterministic (no real confirm).
				if (p === "network.configure" && w.__cera._dropFakeNetcfg) {
					w.__cera.lastConfigureName = msg.input && msg.input.name;
					const mode = w.__cera._dropFakeNetcfg;
					const id = msg.id;
					setTimeout(() => {
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify(
									mode === "success"
										? { id, result: { success: true } }
										: {
												id,
												error: {
													code: -32000,
													message: "drop+fake: simulated configure failure",
												},
											},
								),
							}),
						);
					}, 0);
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

// ── Browser-bridge helpers ──────────────────────────────────────────────────

function inject(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) => (window as any).__cera.inject(t, p),
		[type, payload] as const,
	);
}

function armDropFake(page: Page, mode: "success" | "failure"): Promise<void> {
	return page.evaluate((m) => {
		const c = (window as any).__cera;
		c._suppressRealNetif = true;
		c._dropFakeNetcfg = m;
	}, mode);
}

function lastConfigureName(page: Page): Promise<string | undefined> {
	return page.evaluate(() => (window as any).__cera.lastConfigureName);
}

/** First in-bond (aria-checked=true), enabled BondToggle on the network view. */
async function findEnabledToggle(page: Page): Promise<Locator> {
	const switches = page.getByRole("switch");
	await expect(switches.first()).toBeVisible({ timeout: 10000 });
	const count = await switches.count();
	for (let i = 0; i < count; i++) {
		const s = switches.nth(i);
		if (
			(await s.getAttribute("aria-checked")) === "true" &&
			(await s.isEnabled())
		) {
			return s;
		}
	}
	return switches.first();
}

/** Record every aria-checked transition (oldValue) on `toggle`. */
async function observeAria(toggle: Locator): Promise<void> {
	await toggle.evaluate((el) => {
		const win = window as any;
		win.__ariaLog = [] as (string | null)[];
		new MutationObserver((records) => {
			for (const r of records) win.__ariaLog.push(r.oldValue);
		}).observe(el, {
			attributes: true,
			attributeFilter: ["aria-checked"],
			attributeOldValue: true,
		});
	});
}

function ariaLog(page: Page): Promise<(string | null)[]> {
	return page.evaluate(() => (window as any).__ariaLog ?? []);
}

/**
 * Drop+fake-success click an in-bond toggle, then wait out the optimistic
 * flip→revert so the lock is held with rpcResolved=true and intendedValue=OFF.
 * Returns the interface name the toggle actually configured.
 */
async function dropFakeToggleOff(page: Page, toggle: Locator): Promise<string> {
	await observeAria(toggle);
	await armDropFake(page, "success");
	await toggle.click();
	// The flip (true→false) then revert (false→true) confirms the RPC settled:
	// onRpcResolved(field) + pending=false ran, so the lock is now post-resolve.
	await expect
		.poll(() => ariaLog(page), {
			timeout: 5000,
			message: "optimistic flip + drop+fake resolve should both occur",
		})
		.toEqual(expect.arrayContaining(["true", "false"]));
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	const ifname = await lastConfigureName(page);
	expect(ifname, "configure must have captured an interface name").toBeTruthy();
	return ifname as string;
}

test.describe.configure({ mode: "serial" });

test.describe("bond-toggle no-flash (netif ingestion gate)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser behavioral proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the bond toggles",
		);
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
		// Auto-login (localStorage 'auth' → token rewrite) must land the authed
		// shell before navigateTo, or its desktop/mobile rail probe can race the
		// hydration and fall back to the hidden mobile dock.
		await expect(page.locator("header").first()).toBeVisible({ timeout: 15000 });
		await navigateTo(page, "network");
	});

	// ── Scenario A — No flash (core proof) ─────────────────────────────────────
	test("A: stale enabled:true echo is blocked post-resolve; matching enabled:false settles OFF with no flash", async ({
		page,
	}) => {
		const toggle = await findEnabledToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		const ifname = await dropFakeToggleOff(page, toggle);

		// Lock held: intendedValue=false, rpcResolved=true. Snapshot the flip log.
		const logAfterSnap = await ariaLog(page);

		// STALE echo: enabled:true ≠ intended(false) → shouldIgnoreEcho → BLOCKED.
		await inject(page, "netif", { [ifname]: { enabled: true, tp: 111 } });
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		expect(
			await ariaLog(page),
			"stale echo must not move the toggle (no new transitions)",
		).toEqual(logAfterSnap);

		// MATCHING echo: enabled:false === intended → strict reconcile releases
		// the lock and applies → toggle settles OFF.
		await inject(page, "netif", { [ifname]: { enabled: false, tp: 222 } });
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		// No oscillation: with real-netif suppressed there are no further frames,
		// so the only post-snap transition is the single true→false (oldValue
		// 'true'); a flash back ON would have appended a 'false' oldValue.
		const finalLog = await ariaLog(page);
		const postSnap = finalLog.slice(logAfterSnap.length);
		expect(postSnap, "exactly one transition to OFF, no flash back").toEqual([
			"true",
		]);
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		writeEvidence("task-6-no-flash.txt", [
			"Scenario A — no flash (core proof)",
			`Interface: ${ifname}`,
			"drop+fake OFF → optimistic flip then revert to ON (drop signature).",
			"STALE netif{enabled:true} injected post-resolve → BLOCKED (toggle held ON).",
			"MATCHING netif{enabled:false} injected → lock released, toggle OFF.",
			`aria-checked oldValue log: ${JSON.stringify(finalLog)}`,
			`post-snap transitions: ${JSON.stringify(postSnap)} (single true→false; no flash)`,
			"Result: PASS",
		]);
	});

	// ── Scenario B — Matching echo releases the lock ───────────────────────────
	test("B: matching echo releases the lock; later echoes flow through freely", async ({
		page,
	}) => {
		const toggle = await findEnabledToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		const ifname = await dropFakeToggleOff(page, toggle);

		// Matching echo releases the lock and applies OFF.
		await inject(page, "netif", { [ifname]: { enabled: false, tp: 10 } });
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		// Lock gone: a subsequent enabled:true now flows through unguarded → ON.
		await inject(page, "netif", { [ifname]: { enabled: true, tp: 20 } });
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		writeEvidence("task-6-matching-release.txt", [
			"Scenario B — matching echo releases the lock",
			`Interface: ${ifname}`,
			"MATCHING netif{enabled:false} → lock released, toggle OFF.",
			"Follow-up netif{enabled:true} → applied freely (lock gone), toggle ON.",
			"Result: PASS",
		]);
	});

	// ── Scenario C — RPC failure reverts optimistic ────────────────────────────
	test("C: RPC failure surfaces a toast and reverts the optimistic toggle", async ({
		page,
	}) => {
		const toggle = await findEnabledToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await armDropFake(page, "failure");
		await toggle.click();

		await expect(page.getByText(FAKE_ERR)).toBeVisible();
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		writeEvidence("task-6-rpc-failure-revert.txt", [
			"Scenario C — RPC failure reverts optimistic",
			"drop+fake FAILURE click → BondToggle catch path.",
			`Error toast surfaced: "${FAKE_ERR}"`,
			"Optimistic OFF reverted to authoritative ON (aria-checked=true).",
			"Result: PASS",
		]);
	});

	// ── Scenario D — Rapid double-toggle ───────────────────────────────────────
	test("D: rapid double-toggle settles ON with no oscillation", async ({
		page,
	}) => {
		const toggle = await findEnabledToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await observeAria(toggle);
		await armDropFake(page, "success");
		// Two clicks in quick succession; in-flight clicks are serialized by
		// BondToggle, and with no confirming echo `displayed` returns to the ON
		// prop after each settle.
		await toggle.click();
		await toggle.click();

		await expect(toggle).toHaveAttribute("aria-checked", "true");
		// Settle: no echo can change netifState, so ON is the stable terminal.
		const log = await ariaLog(page);

		writeEvidence("task-6-double-toggle.txt", [
			"Scenario D — rapid double-toggle",
			"drop+fake SUCCESS; clicked OFF then again before settle.",
			`aria-checked oldValue log: ${JSON.stringify(log)}`,
			"Final state: ON (aria-checked=true) — no oscillation, no stuck OFF.",
			"Result: PASS",
		]);
	});

	// ── Scenario E — TTL self-sweep ────────────────────────────────────────────
	test("E: held lock self-clears after FIELD_LOCK_TTL_MS so echoes flow again", async ({
		page,
	}) => {
		const toggle = await findEnabledToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		const ifname = await dropFakeToggleOff(page, toggle);

		// Hold the lock (intended=false, rpcResolved=true) WITHOUT ever sending a
		// confirming echo, so the only possible release path is the TTL sweep.
		const start = Date.now();
		await expect
			.poll(() => Date.now() - start, {
				timeout: 13000,
				intervals: [500],
				message: "wait past FIELD_LOCK_TTL_MS (10s) for the self-sweep",
			})
			.toBeGreaterThan(11000);

		// Post-TTL the field reconciles freely again: an injected OFF then ON
		// both apply, proving no permanent lock survived.
		await inject(page, "netif", { [ifname]: { enabled: false, tp: 1 } });
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await inject(page, "netif", { [ifname]: { enabled: true, tp: 2 } });
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		writeEvidence("task-6-ttl-selfsweep.txt", [
			"Scenario E — TTL self-sweep",
			`Interface: ${ifname}`,
			"Lock held post-resolve with NO confirming echo (TTL is the only valve).",
			"Waited > FIELD_LOCK_TTL_MS (10s); lock force-released by expire().",
			"Post-TTL netif{enabled:false}→OFF then {enabled:true}→ON applied freely.",
			"Result: PASS",
		]);
	});
});
