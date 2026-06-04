import fs from "node:fs";
import path from "node:path";

import { expect, type Locator, type Page, test } from "@playwright/test";

import { navigateTo } from "./helpers";

/**
 * Task 1 — Bond-toggle no-flash proof, end-to-end.
 *
 * Proves two cooperating layers keep a freshly-toggled BondToggle from flashing
 * back to the server's stale `enabled` value:
 *   1. The netif ingestion gate in `subscriptions.svelte.ts` (`case "netif"`):
 *      the per-interface `enabled` field is reconciled through the dirty-field
 *      registry (`shouldIgnoreEchoReactive` + strict `reconcileReactive`), while
 *      `tp`/`ip`/`error`/`mac` flow live.
 *   2. The BondToggle display fix: `displayed = (pending || isPending(field))
 *      ? target : enabled`. The optimistic `target` is held not only while
 *      `pending`, but for the whole window the field-lock is held — i.e. AFTER
 *      the RPC resolves (`pending` clears) and BEFORE the confirming echo lands.
 *      The fast-path wire-up `onRpcAppliedReactive(field, applied.enabled)` in
 *      the RPC success path adopts the server-applied value and holds the lock
 *      until the matching echo releases it.
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

// Workspace-root evidence dir: 5 levels up from tests/e2e == /mnt/.../ceralive.
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../../..",
	".omo/evidence",
);

function writeEvidence(fileName: string, lines: string[]): void {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(EVIDENCE_DIR, fileName),
		[
			"Task 1 — Bond-toggle no-flash (display hold + fast-path lock release)",
			`Generated: ${new Date().toISOString()}`,
			"",
			...lines,
			"",
		].join("\n"),
		"utf8",
	);
}

function writeEvidence19(fileName: string, lines: string[]): void {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(EVIDENCE_DIR, fileName),
		[
			"Task 19 — Toggle reconciliation edge cases (echo timing, reconnect, failure, TTL)",
			`Generated: ${new Date().toISOString()}`,
			"",
			...lines,
			"",
		].join("\n"),
		"utf8",
	);
}

function writeEvidenceJson(fileName: string, data: unknown): void {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(EVIDENCE_DIR, fileName),
		`${JSON.stringify(data, null, 2)}\n`,
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
		_dropFakeNetcfg: false as false | "success" | "failure" | "orphan",
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
				// post-resolve lock window is deterministic (no real confirm). The
				// success fake mirrors the real backend's applied-state return shape
				// (`{ success, applied: { name, ip, enabled } }`) so the BondToggle
				// fast-path (`onRpcAppliedReactive`) is exercised exactly as in prod.
				if (p === "network.configure" && w.__cera._dropFakeNetcfg) {
					w.__cera.lastConfigureName = msg.input && msg.input.name;
					const mode = w.__cera._dropFakeNetcfg;
					// Orphan mode: drop the configure RPC and NEVER resolve it, so the
					// owning promise stays pending forever — emulating a socket that
					// dropped mid-operation (the component's `finally` never runs, leaving
					// `pending` stuck until the reconnect-edge reconciliation clears it).
					if (mode === "orphan") return undefined;
					const id = msg.id;
					const input = msg.input ?? {};
					setTimeout(() => {
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify(
									mode === "success"
										? {
												id,
												result: {
													success: true,
													applied: {
														name: input.name,
														ip: input.ip,
														enabled: input.enabled,
													},
												},
											}
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

function armOrphan(page: Page): Promise<void> {
	return page.evaluate(() => {
		const c = (window as any).__cera;
		c._suppressRealNetif = true;
		c._dropFakeNetcfg = "orphan";
	});
}

/**
 * Drive the app's connection-state machine deterministically by invoking the
 * client's own `onclose` / `onopen` handlers on the live socket — WITHOUT
 * actually closing the transport (readyState stays OPEN, so the transport's
 * backoff `connect()` is a no-op and no real reconnect timing is involved). A
 * `close` then `open` (with a frame flush between) reproduces the exact
 * `disconnected → connected` reconnect edge that `shouldReconcileOnReconnect`
 * keys on, with zero wall-clock timing dependency.
 */
function emitConn(page: Page, phase: "close" | "open"): Promise<void> {
	return page.evaluate((ph) => {
		const s = (window as any).__cera.socket;
		if (!s) return;
		if (ph === "close") s.onclose?.(new CloseEvent("close"));
		else s.onopen?.(new Event("open"));
	}, phase);
}

/**
 * Yield two animation frames, letting the drop+fake `setTimeout(0)` macrotask
 * and the component's resolve→finally microtasks run. A frame-based wait (not a
 * fixed-duration sleep) so it stays deterministic — no banned fixed-delay waits.
 */
function flush(page: Page): Promise<void> {
	return page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
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

/** Every in-bond (aria-checked=true), enabled BondToggle plus its interface name. */
async function findEnabledToggles(
	page: Page,
): Promise<{ toggle: Locator; name: string }[]> {
	const switches = page.getByRole("switch");
	await expect(switches.first()).toBeVisible({ timeout: 10000 });
	const count = await switches.count();
	const found: { toggle: Locator; name: string }[] = [];
	for (let i = 0; i < count; i++) {
		const s = switches.nth(i);
		const testid = await s.getAttribute("data-testid");
		if (
			testid?.startsWith("bond-toggle-") &&
			(await s.getAttribute("aria-checked")) === "true" &&
			(await s.isEnabled())
		) {
			found.push({
				toggle: page.getByTestId(testid),
				name: testid.slice("bond-toggle-".length),
			});
		}
	}
	return found;
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
 * Drop+fake-success click an in-bond toggle, then settle. With the flash-back
 * fix the toggle HOLDS at OFF after the RPC resolves: the optimistic ON→OFF flip
 * lands, `onRpcAppliedReactive(field,false)` adopts the applied value + marks
 * the lock resolved, and `displayed` keeps following `target` while the lock is
 * held — there is NO revert to ON. The lock is left post-resolve with
 * intendedValue=OFF, awaiting the confirming echo. Returns the configured iface.
 */
async function dropFakeToggleOff(page: Page, toggle: Locator): Promise<string> {
	await observeAria(toggle);
	await armDropFake(page, "success");
	await toggle.click();
	// Wait for the configure RPC to be sent + faked, then flush its resolution.
	await expect
		.poll(() => lastConfigureName(page), {
			timeout: 5000,
			message: "configure must capture an interface name",
		})
		.toBeTruthy();
	await flush(page);
	// Held at OFF post-resolve — the flash-back fix means no revert to ON.
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	return (await lastConfigureName(page)) as string;
}

test.describe.configure({ mode: "serial" });

test.describe("bond-toggle no-flash (display hold + ingestion gate)", () => {
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
	test("A: post-resolve the toggle holds OFF; stale enabled:true is blocked; matching enabled:false settles OFF with no flash", async ({
		page,
	}) => {
		const toggle = await findEnabledToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		const ifname = await dropFakeToggleOff(page, toggle);

		// Single ON→OFF transition, NO flash-back: a revert would have appended a
		// false→true transition (oldValue "false"). The fix holds OFF post-resolve.
		expect(
			await ariaLog(page),
			"only the optimistic ON→OFF flip; no flash-back to ON",
		).toEqual(["true"]);

		// STALE echo: enabled:true ≠ intended(false) → shouldIgnoreEcho → BLOCKED.
		await inject(page, "netif", { [ifname]: { enabled: true, tp: 111 } });
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		expect(
			await ariaLog(page),
			"stale echo must not move the toggle (no new transitions)",
		).toEqual(["true"]);

		// MATCHING echo: enabled:false === intended → strict reconcile releases
		// the lock and applies → toggle stays OFF (now from the authoritative prop).
		await inject(page, "netif", { [ifname]: { enabled: false, tp: 222 } });
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		expect(
			await ariaLog(page),
			"matching echo release adds no transition (already OFF)",
		).toEqual(["true"]);

		writeEvidence("task-1-no-flash.txt", [
			"Scenario A — no flash (core proof)",
			`Interface: ${ifname}`,
			"drop+fake OFF → optimistic ON→OFF flip, then HELD OFF post-resolve.",
			"STALE netif{enabled:true} injected → BLOCKED (toggle held OFF).",
			"MATCHING netif{enabled:false} injected → lock released, toggle stays OFF.",
			`aria-checked oldValue log: ${JSON.stringify(await ariaLog(page))}`,
			"Result: PASS — single ON→OFF transition, no flash-back to ON",
		]);
	});

	// ── Scenario B — Matching echo releases the lock ───────────────────────────
	test("B: matching echo releases the lock; later echoes flow through freely", async ({
		page,
	}) => {
		const toggle = await findEnabledToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		const ifname = await dropFakeToggleOff(page, toggle);

		// Matching echo releases the lock and applies OFF (toggle stays OFF).
		await inject(page, "netif", { [ifname]: { enabled: false, tp: 10 } });
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		// Lock gone: a subsequent enabled:true now flows through unguarded → ON.
		await inject(page, "netif", { [ifname]: { enabled: true, tp: 20 } });
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		writeEvidence("task-1-matching-release.txt", [
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
		// On failure the catch path releases the field-lock to the authoritative
		// `enabled` prop, so `displayed` reverts immediately (no echo required).
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		writeEvidence("task-1-rpc-failure-revert.txt", [
			"Scenario C — RPC failure reverts optimistic",
			"drop+fake FAILURE click → BondToggle catch path.",
			`Error toast surfaced: "${FAKE_ERR}"`,
			"Field-lock released to authoritative prop → optimistic OFF reverted to ON.",
			"Result: PASS",
		]);
	});

	// ── Scenario D — Rapid double-toggle ───────────────────────────────────────
	test("D: rapid double-toggle settles to a stable state with no oscillation", async ({
		page,
	}) => {
		const toggle = await findEnabledToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await observeAria(toggle);
		await armDropFake(page, "success");
		// Two clicks in quick succession. Depending on whether the first drop+fake
		// RPC resolves in the gap between the awaited clicks, the second either is
		// serialized away (pending still true → BondToggle early-returns) or runs
		// as a second completed toggle. Either way the control must NOT get stuck
		// pending and must settle to a single stable state with no flash/oscillation.
		await toggle.click();
		await toggle.click();

		await expect
			.poll(() => lastConfigureName(page), { timeout: 5000 })
			.toBeTruthy();
		// Never stuck: the in-flight flag clears and the control re-enables.
		await expect(toggle).toHaveAttribute("aria-busy", "false");
		await expect(toggle).toBeEnabled();

		// Capture the settled state, then prove it is STABLE across several frames
		// (no oscillation / no flash-back beyond the user's own toggles).
		await flush(page);
		const settled = await toggle.getAttribute("aria-checked");
		for (let i = 0; i < 6; i++) {
			await flush(page);
			expect(
				await toggle.getAttribute("aria-checked"),
				"settled state must not oscillate",
			).toBe(settled);
		}
		// Recorded transitions are only the user's own toggles — at most two,
		// never a spurious repeat (a flash-back would add an extra transition).
		const log = await ariaLog(page);
		expect(
			log.length,
			"no more aria transitions than user toggles",
		).toBeLessThanOrEqual(2);

		writeEvidence("task-1-double-toggle.txt", [
			"Scenario D — rapid double-toggle",
			"drop+fake SUCCESS; clicked twice in quick succession.",
			`Settled aria-checked: ${settled} (stable across 6 frames).`,
			`aria-checked oldValue log: ${JSON.stringify(log)}`,
			"Control not stuck (aria-busy=false, enabled); no oscillation/flash-back.",
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

		writeEvidence("task-1-ttl-selfsweep.txt", [
			"Scenario E — TTL self-sweep",
			`Interface: ${ifname}`,
			"Lock held post-resolve with NO confirming echo (TTL is the only valve).",
			"Waited > FIELD_LOCK_TTL_MS (10s); lock force-released by expire().",
			"Post-TTL netif{enabled:false}→OFF then {enabled:true}→ON applied freely.",
			"Result: PASS",
		]);
	});

	// ── Scenario F — RPC resolves before echo arrives (Task 1 fast-path proof) ──
	test("F: RPC resolves before echo arrives — toggle holds OFF (no flash-back)", async ({
		page,
	}) => {
		const toggle = await findEnabledToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await observeAria(toggle);
		await armDropFake(page, "success");
		await toggle.click();

		// The drop+fake RPC resolves on a microtask — BEFORE any netif echo can
		// arrive (real netif suppressed; none injected yet). `pending` clears in
		// the finally, but the field-lock is held by onRpcAppliedReactive, so
		// `displayed` keeps following `target`=OFF. The OLD bug snapped `displayed`
		// back to the stale `enabled`=ON prop right here — a visible flash-back.
		await expect
			.poll(() => lastConfigureName(page), { timeout: 5000 })
			.toBeTruthy();

		// Sample aria-checked across several render frames spanning the whole
		// post-resolve / pre-echo window. Every sample must be OFF.
		const samples: { frame: number; ariaChecked: string | null }[] = [];
		for (let frame = 0; frame < 8; frame++) {
			await flush(page);
			samples.push({
				frame,
				ariaChecked: await toggle.getAttribute("aria-checked"),
			});
		}
		const ifname = (await lastConfigureName(page)) as string;
		const flashedToOn = samples.some((s) => s.ariaChecked !== "false");

		expect(
			flashedToOn,
			"toggle must hold OFF across the entire post-resolve window",
		).toBe(false);
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		expect(
			await ariaLog(page),
			"exactly one ON→OFF transition; no flash-back to ON",
		).toEqual(["true"]);

		// The confirming echo finally settles OFF cleanly (lock released, OFF).
		await inject(page, "netif", { [ifname]: { enabled: false, tp: 7 } });
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		expect(
			await ariaLog(page),
			"echo release adds no transition (already OFF)",
		).toEqual(["true"]);

		writeEvidenceJson("task-1-toggle-samples.json", {
			scenario: "RPC resolves before echo arrives",
			interface: ifname,
			samples,
			ariaCheckedOldValueLog: await ariaLog(page),
			flashedBackToOn: flashedToOn,
			result: "PASS — toggle held OFF; no flash-back",
		});
		writeEvidence("task-1-rpc-before-echo.txt", [
			"Scenario F — RPC resolves before echo arrives",
			`Interface: ${ifname}`,
			"drop+fake SUCCESS resolves on a microtask, BEFORE any netif echo.",
			"pending cleared (finally) but the field-lock is held by onRpcAppliedReactive,",
			"so `displayed` followed `target`=OFF across the whole window.",
			`aria-checked samples: ${JSON.stringify(samples)}`,
			`aria-checked oldValue log: ${JSON.stringify(await ariaLog(page))}`,
			"Confirming netif{enabled:false} → lock released, toggle stayed OFF.",
			"Result: PASS (no flash-back to ON)",
		]);
	});

	// ── Scenario G — RPC-before-echo: immediate window + ~5s periodic broadcast ─
	// Task 19 coverage-proof target. Reverting BondToggle's derivation to
	// `pending ? target : enabled` makes the post-resolve sample loop observe ON.
	test("G: RPC resolves before any echo — holds OFF across the post-resolve window; a stale ~5s periodic broadcast is blocked; the matching echo settles OFF", async ({
		page,
	}) => {
		const toggle = await findEnabledToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await observeAria(toggle);
		await armDropFake(page, "success");
		await toggle.click();

		await expect
			.poll(() => lastConfigureName(page), { timeout: 5000 })
			.toBeTruthy();
		const ifname = (await lastConfigureName(page)) as string;

		const samples: { frame: number; ariaChecked: string | null }[] = [];
		for (let frame = 0; frame < 8; frame++) {
			await flush(page);
			samples.push({
				frame,
				ariaChecked: await toggle.getAttribute("aria-checked"),
			});
		}
		expect(
			samples.some((s) => s.ariaChecked !== "false"),
			"immediate post-resolve / pre-echo window must hold OFF (no flash-back)",
		).toBe(false);
		expect(
			await ariaLog(page),
			"exactly one ON→OFF transition in the immediate window",
		).toEqual(["true"]);

		await inject(page, "netif", { [ifname]: { enabled: true, tp: 333 } });
		for (let frame = 0; frame < 4; frame++) {
			await flush(page);
			await expect(toggle).toHaveAttribute("aria-checked", "false");
		}
		expect(
			await ariaLog(page),
			"stale ~5s periodic broadcast (enabled:true) must not move the toggle",
		).toEqual(["true"]);

		await inject(page, "netif", { [ifname]: { enabled: false, tp: 444 } });
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		expect(
			await ariaLog(page),
			"matching echo release adds no transition (already OFF)",
		).toEqual(["true"]);

		writeEvidenceJson("task-19-rpc-before-echo-samples.json", {
			scenario: "RPC-before-echo: immediate window + stale periodic broadcast",
			interface: ifname,
			samples,
			ariaCheckedOldValueLog: await ariaLog(page),
			result: "PASS — held OFF; stale periodic blocked; matching echo settled OFF",
		});
		writeEvidence19("task-19-rpc-before-echo.txt", [
			"Scenario G — RPC resolves before any echo (immediate + periodic broadcast)",
			`Interface: ${ifname}`,
			"drop+fake SUCCESS resolves on a microtask, BEFORE any netif echo.",
			`Immediate post-resolve samples (all OFF): ${JSON.stringify(samples)}`,
			"Stale ~5s periodic broadcast netif{enabled:true} → BLOCKED (held OFF).",
			"Matching netif{enabled:false} → lock released, toggle stayed OFF.",
			"Result: PASS (no flash-back to ON in either window)",
		]);
	});

	// ── Scenario H — WS reconnect mid-toggle (reconcile-inflight) ───────────────
	test("H: WS reconnect mid-toggle — reconcile-inflight clears the stuck pending and snaps to the authoritative value (no wrong-direction flash)", async ({
		page,
	}) => {
		const enabledToggles = await findEnabledToggles(page);
		expect(
			enabledToggles.length,
			"need at least one in-bond interface",
		).toBeGreaterThan(0);
		const { toggle, name } = enabledToggles[0];
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await observeAria(toggle);
		await armOrphan(page);
		await toggle.click();

		await expect.poll(() => lastConfigureName(page), { timeout: 5000 }).toBe(name);
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await expect(toggle).toHaveAttribute("aria-busy", "true");
		expect(
			await ariaLog(page),
			"only the optimistic ON→OFF flip; the RPC is orphaned (stuck pending)",
		).toEqual(["true"]);

		await emitConn(page, "close");
		await flush(page);
		await emitConn(page, "open");
		await flush(page);

		await expect(toggle).toHaveAttribute("aria-busy", "false");
		await expect(toggle).toBeEnabled();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		expect(
			await ariaLog(page),
			"ON→OFF optimistic, then OFF→ON reconcile to the authoritative prop",
		).toEqual(["true", "false"]);

		for (let i = 0; i < 6; i++) {
			await flush(page);
			expect(
				await toggle.getAttribute("aria-checked"),
				"reconciled state must not oscillate",
			).toBe("true");
		}
		expect(
			await ariaLog(page),
			"no further transitions after the reconcile",
		).toEqual(["true", "false"]);

		await inject(page, "netif", { [name]: { enabled: false, tp: 9 } });
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		writeEvidence19("task-19-reconnect-inflight.txt", [
			"Scenario H — WS reconnect mid-toggle (reconcile-inflight)",
			`Interface: ${name}`,
			"Orphaned configure RPC → `pending` stuck (aria-busy=true), held OFF.",
			"Connection driven disconnected → connected (genuine reconnect edge).",
			"shouldReconcileOnReconnect fired → lock released + pending cleared.",
			"Toggle snapped to authoritative ON (orphaned disable never applied).",
			"Post-reconnect echo netif{enabled:false} flowed freely → lock was released.",
			"Result: PASS (no stuck pending, no wrong-direction flash)",
		]);
	});

	// ── Scenario I — RPC failure reverts AND releases the lock ──────────────────
	test("I: RPC failure reverts to the server value and releases the field-lock (no stuck pending — later echoes flow freely)", async ({
		page,
	}) => {
		const enabledToggles = await findEnabledToggles(page);
		expect(enabledToggles.length).toBeGreaterThan(0);
		const { toggle, name } = enabledToggles[0];
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await observeAria(toggle);
		await armDropFake(page, "failure");
		await toggle.click();

		await expect(page.getByText(FAKE_ERR)).toBeVisible();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await expect(toggle).toHaveAttribute("aria-busy", "false");
		await expect(toggle).toBeEnabled();
		expect(
			await ariaLog(page),
			"optimistic ON→OFF then revert OFF→ON; nothing else",
		).toEqual(["true", "false"]);

		await inject(page, "netif", { [name]: { enabled: false, tp: 5 } });
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await inject(page, "netif", { [name]: { enabled: true, tp: 6 } });
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		writeEvidence19("task-19-rpc-failure-lock-released.txt", [
			"Scenario I — RPC failure reverts AND releases the lock",
			`Interface: ${name}`,
			"drop+fake FAILURE → toast + immediate revert to authoritative ON.",
			"Post-failure netif{enabled:false}→OFF then {enabled:true}→ON BOTH applied.",
			"A stuck intended=false lock would have BLOCKED the later enabled:true.",
			"Result: PASS (lock released, no stuck pending)",
		]);
	});

	// ── Scenario J — two interfaces, independent field locks ────────────────────
	test("J: two interfaces toggled rapidly — enabled_<ifA>/enabled_<ifB> locks are independent (releasing one never disturbs the other)", async ({
		page,
	}) => {
		const enabledToggles = await findEnabledToggles(page);
		expect(
			enabledToggles.length,
			"need at least two in-bond interfaces",
		).toBeGreaterThanOrEqual(2);
		const [a, b] = enabledToggles;
		expect(a.name).not.toBe(b.name);

		await expect(a.toggle).toHaveAttribute("aria-checked", "true");
		await expect(b.toggle).toHaveAttribute("aria-checked", "true");

		await armDropFake(page, "success");
		await a.toggle.click();
		await b.toggle.click();
		await expect
			.poll(() => lastConfigureName(page), { timeout: 5000 })
			.toBe(b.name);
		await flush(page);
		await expect(a.toggle).toHaveAttribute("aria-checked", "false");
		await expect(b.toggle).toHaveAttribute("aria-checked", "false");

		await inject(page, "netif", { [a.name]: { enabled: false, tp: 1 } });
		await expect(a.toggle).toHaveAttribute("aria-checked", "false");

		await inject(page, "netif", { [b.name]: { enabled: true, tp: 2 } });
		await expect(b.toggle).toHaveAttribute("aria-checked", "false");

		await inject(page, "netif", { [a.name]: { enabled: true, tp: 3 } });
		await expect(a.toggle).toHaveAttribute("aria-checked", "true");
		await expect(b.toggle).toHaveAttribute("aria-checked", "false");

		await inject(page, "netif", { [b.name]: { enabled: false, tp: 4 } });
		await expect(b.toggle).toHaveAttribute("aria-checked", "false");
		await expect(a.toggle).toHaveAttribute("aria-checked", "true");

		writeEvidence19("task-19-two-iface-independent.txt", [
			"Scenario J — two interfaces, independent per-field locks",
			`Interface A: ${a.name} · Interface B: ${b.name}`,
			"Both toggled OFF rapidly (drop+fake SUCCESS) → each holds its own lock.",
			"Matching echo for A → A's lock released (A OFF, authoritative).",
			"Stale enabled:true for B → BLOCKED (B's lock intact, no cross-talk).",
			"Stale enabled:true for A → flows (A's lock gone) → A ON.",
			"Matching echo for B → B's lock released (B OFF); A unchanged (ON).",
			"Result: PASS (locks fully independent)",
		]);
	});

	// ── Scenario K — TTL self-sweep releases a lock when no echo ever arrives ───
	test("K: TTL self-sweep releases the lock if no echo ever arrives — a pre-TTL stale echo is blocked, a post-TTL echo flows", async ({
		page,
	}) => {
		const toggle = await findEnabledToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		const ifname = await dropFakeToggleOff(page, toggle);
		const start = Date.now();

		await inject(page, "netif", { [ifname]: { enabled: true, tp: 1 } });
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		await expect
			.poll(() => Date.now() - start, {
				timeout: 14000,
				intervals: [500],
				message: "wait past FIELD_LOCK_TTL_MS (10s) for the self-sweep",
			})
			.toBeGreaterThan(12000);

		await inject(page, "netif", { [ifname]: { enabled: true, tp: 2 } });
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await inject(page, "netif", { [ifname]: { enabled: false, tp: 3 } });
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		writeEvidence19("task-19-ttl-selfsweep.txt", [
			"Scenario K — TTL self-sweep (no echo ever arrives)",
			`Interface: ${ifname}`,
			"Lock held post-resolve with NO confirming echo (TTL is the only valve).",
			"Pre-TTL stale netif{enabled:true} → BLOCKED (held OFF).",
			"Waited > FIELD_LOCK_TTL_MS (10s); lock force-released by expire().",
			"Post-TTL netif{enabled:true}→ON then {enabled:false}→OFF flowed freely.",
			"Result: PASS (TTL released the lock)",
		]);
	});
});
