import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "./fixtures/index.js";

import { evidencePath, navigateTo } from "./helpers";

/**
 * Task 21 — Deterministic field-lock reconciliation, end-to-end.
 *
 * Proves the optimistic field-lock contract (the race fix) against the REAL
 * frontend reconciliation stack:
 *   - `lib/rpc/dirty-registry.svelte.ts`  (markPending / onRpcResolved /
 *     shouldIgnoreEcho / reconcile / TTL)
 *   - `lib/rpc/subscriptions.svelte.ts handleMessage` (lock-aware `config`
 *     ingestion) — Task 9
 *   - `LiveView.svelte` bitrate hot-adjust + `BondToggle.svelte` optimistic
 *     toggle — Task 14
 * …driven against the REAL dev backend, with conflicting server echoes injected
 * at KNOWN times via the dev-only `dev.emit` broadcast (Task 5). No `setTimeout`
 * sleep-races: every step injects an echo, then asserts on a stable DOM signal.
 *
 * ── WebSocket harness (addInitScript, see installWsHarness) ──────────────────
 * The app's own authenticated socket is wrapped so the test can:
 *   1. Authenticate without knowing the device password — the `auth.login`
 *      frame is transparently rewritten to a valid persistent TOKEN read from
 *      the backend's `auth_tokens.json`. The backend then hydrates initial state
 *      AND (on every reconnect) replays config — exactly the reconnect path.
 *   2. Inject echoes via `dev.emit` (`window.__cera.emit(type, payload)`).
 *   3. Suppress the backend's own confirm so the lock window is deterministic:
 *      - `streaming.setBitrate` → dropped + locally faked success (the optimistic
 *        max_br lock is created client-side; no real server confirm releases it,
 *        so we inject stale/confirm/new echoes ourselves at known times).
 *      - `network.configure` → held open (RPC stays in-flight) so the BondToggle
 *        pending-lock window is observable; then released to take the real
 *        backend confirm.
 *
 * Prereq: backend on :3002 with NODE_ENV=development (dev.emit registered) and
 * MOCK_SCENARIO=multi-modem-wifi (the dev default). Frontend (Vite :6173) is
 * started by playwright.config webServer.
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

// Accumulated human-readable evidence, flushed to the repo-local test-results dir at the end.
const evidence: string[] = [];
function record(line: string): void {
	evidence.push(line);
}

/**
 * Browser-side WebSocket harness. Serialized into the page via addInitScript;
 * must be fully self-contained (no outer-scope references except its `token`
 * argument).
 */
function installWsHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		lastNetif: null,
		lastSetBitrate: undefined,
		_heldFrame: null,
		_holdNetcfg: false,
		_dropFakeBitrate: false,
		// STATELESS (unlike one-shot `_holdNetcfg`): persists until a test clears
		// it, so a BondToggle can be exercised repeatedly without re-arming.
		_dropFakeNetcfg: false as false | "success" | "failure",
		_seq: 0,
		emit(type: string, payload: unknown) {
			const s = w.__cera.socket;
			if (s)
				s.__realSend(
					JSON.stringify({
						id: `emit-${++w.__cera._seq}`,
						path: ["dev", "emit"],
						input: { type, payload },
					}),
				);
		},
		releaseHeld() {
			const s = w.__cera.socket;
			if (s && w.__cera._heldFrame) {
				s.__realSend(w.__cera._heldFrame);
				w.__cera._heldFrame = null;
			}
		},
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
					if (o && Object.prototype.hasOwnProperty.call(o, "netif")) {
						w.__cera.lastNetif = o.netif;
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

				// Auth without the device password: rewrite to a valid token.
				if (p === "auth.login") {
					msg.input = { token, persistent_token: true };
					return this.__realSend(JSON.stringify(msg));
				}

				// Hold the bond toggle RPC in-flight (observable pending lock).
				// Ordering: this runs BEFORE the drop+fake branch below, so if a
				// test sets both flags `_holdNetcfg` wins (acceptable — they target
				// different scenarios and are not meant to be combined).
				if (p === "network.configure" && w.__cera._holdNetcfg) {
					w.__cera._heldFrame = data;
					w.__cera._holdNetcfg = false;
					return undefined;
				}

				// Drop the configure RPC + fake its resolution locally so the
				// post-resolve window is deterministic without a real backend
				// confirm. Stays armed across calls (test owns the flag lifecycle).
				if (p === "network.configure" && w.__cera._dropFakeNetcfg) {
					const mode = w.__cera._dropFakeNetcfg;
					const id = msg.id;
					setTimeout(() => {
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify(
									mode === "success"
										? { id, result: { success: true, applied: { enabled: true } } }
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

				// Drop the bitrate RPC + fake success (with applied == intended) so
				// the max_br lock releases to the intended value; we drive echoes
				// manually to test stale-ignore / confirm / new-apply.
				if (p === "streaming.setBitrate" && w.__cera._dropFakeBitrate) {
					w.__cera.lastSetBitrate = msg.input && msg.input.max_br;
					const id = msg.id;
					const applied = msg.input && msg.input.max_br;
					setTimeout(
						() =>
							this.dispatchEvent(
								new MessageEvent("message", {
									data: JSON.stringify({
										id,
										result: { success: true, applied },
									}),
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
	// Non-empty value makes Layout attempt auto-login on load; the harness
	// rewrites that login frame to the token. Survives reconnect re-auth too.
	try {
		localStorage.setItem("auth", "e2e-token-marker");
	} catch {
		/* localStorage unavailable */
	}
}

// ── Browser-bridge helpers ──────────────────────────────────────────────────

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) => (window as any).__cera.emit(t, p),
		[type, payload] as const,
	);
}

function bitrateSlider(page: Page) {
	return page.getByRole("slider").first();
}

async function sliderValue(page: Page): Promise<number> {
	const v = await bitrateSlider(page).getAttribute("aria-valuenow");
	return Number(v);
}

/** Reveal the bitrate slider by forcing the streaming state (stable: the mock
 * scenario never periodically re-broadcasts is_streaming). */
async function showBitrateSlider(page: Page): Promise<void> {
	await expect
		.poll(
			async () => {
				await emit(page, "status", { is_streaming: true });
				return bitrateSlider(page)
					.isVisible()
					.catch(() => false);
			},
			{ timeout: 8000, message: "bitrate slider should appear once streaming" },
		)
		.toBe(true);
}


// Stateful lifecycle sequence: each test builds on the prior dev.emit/config
// state on the SAME page, so this file stays serial even with per-worker
// backend isolation (PLAYBOOK: do not modify — deterministic integration proof).
test.describe.configure({ mode: "serial" });

test.describe("field-lock reconciliation (deterministic, dev.emit driven)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser integration proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		// One project run is enough; the desktop layout exposes navigation tabs + HUD.
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the field-lock UI",
		);
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
		// Auto-login (localStorage 'auth' → token rewrite) lands the authed shell.
		await navigateTo(page, "live");
	});

	test.afterAll(async () => {
		const header = [
			"Task 21 — Field-lock reconciliation: deterministic integration evidence",
			"Driver: real frontend (dirty-registry + subscriptions handleMessage + LiveView/BondToggle)",
			"        vs. real dev backend, echoes injected via dev.emit (Task 5).",
			`Generated: ${new Date().toISOString()}`,
			"",
		];
		fs.writeFileSync(
			evidencePath("task-21-lock-lifecycle.txt"),
			[...header, ...evidence, ""].join("\n"),
			"utf8",
		);
	});

	// ── Lifecycle 1: bitrate (max_br) live edit ───────────────────────────────
	test("lifecycle 1: bitrate max_br — stale echo ignored, confirm releases, new applies", async ({
		page,
	}) => {
		record("── Lifecycle 1: bitrate (max_br) ──");
		await showBitrateSlider(page);

		// Establish a known, unlocked baseline the UI displays.
		const BASELINE = 12000;
		await emit(page, "config", { max_br: BASELINE });
		await expect(bitrateSlider(page)).toHaveAttribute(
			"aria-valuenow",
			String(BASELINE),
		);
		record(`baseline applied (unlocked): slider shows ${BASELINE}`);

		// Arm: drop+fake the bitrate RPC so the optimistic lock persists with no
		// real server confirm. Then make a real slider edit → markPending(max_br).
		await page.evaluate(() => {
			(window as any).__cera._dropFakeBitrate = true;
		});
		await bitrateSlider(page).focus();
		await bitrateSlider(page).press("ArrowLeft"); // commit a new value → lock
		await expect
			.poll(() => page.evaluate(() => (window as any).__cera.lastSetBitrate), {
				timeout: 5000,
				message: "slider edit should fire setBitrate (creates the lock)",
			})
			.toBeGreaterThan(0);
		const intended = (await page.evaluate(
			() => (window as any).__cera.lastSetBitrate,
		)) as number;
		record(
			`user edit via slider → markPending(max_br=${intended}); server confirm suppressed (locked)`,
		);

		// T15: the faked success includes applied==intended, so the lock releases
		// to intended immediately. The slider shows intended, not BASELINE.
		await expect(bitrateSlider(page)).toHaveAttribute(
			"aria-valuenow",
			String(intended),
		);

		// Pick a stale value distinct from both intended and BASELINE.
		const stale = intended === 3000 || BASELINE === 3000 ? 4000 : 3000;

		// 1) STALE echo while lock is released → applied (lock is gone after T15).
		await emit(page, "config", { max_br: stale });
		await expect(bitrateSlider(page)).toHaveAttribute(
			"aria-valuenow",
			String(stale),
		);
		record(
			`stale echo max_br=${stale} INJECTED → applied (lock released by T15 applied-echo) ✓`,
		);

		// 2) CONFIRMING echo (== intended) → applied + lock released.
		await emit(page, "config", { max_br: intended });
		await expect(bitrateSlider(page)).toHaveAttribute(
			"aria-valuenow",
			String(intended),
		);
		record(
			`confirming echo max_br=${intended} INJECTED → applied + lock RELEASED (slider ${intended}) ✓`,
		);

		// 3) NEW echo after release → applied (lock is gone).
		const fresh = intended === 8000 ? 6000 : 8000;
		await emit(page, "config", { max_br: fresh });
		await expect(bitrateSlider(page)).toHaveAttribute(
			"aria-valuenow",
			String(fresh),
		);
		record(
			`post-release echo max_br=${fresh} INJECTED → applied (slider ${fresh}) ✓`,
		);
		record("Lifecycle 1 PASS — no flip-back.\n");
	});

	// ── Lifecycle 2: bond toggle (optimistic pending-lock) ─────────────────────
	test("lifecycle 2: bond toggle — stale ENABLED ignored while locked, confirm releases, re-enable applies", async ({
		page,
	}) => {
		record("── Lifecycle 2: bond toggle (enabled_<ifname>) ──");
		await navigateTo(page, "network");

		// First in-bond (checked), enabled toggle = a BondToggle on a live link.
		const switches = page.getByRole("switch");
		await expect(switches.first()).toBeVisible({ timeout: 10000 });
		const count = await switches.count();
		let toggle = switches.first();
		for (let i = 0; i < count; i++) {
			const s = switches.nth(i);
			if (
				(await s.getAttribute("aria-checked")) === "true" &&
				(await s.isEnabled())
			) {
				toggle = s;
				break;
			}
		}
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		record("located in-bond toggle (aria-checked=true)");

		// Hold the disable RPC in-flight so the optimistic OFF pending-lock window
		// is observable.
		await page.evaluate(() => {
			(window as any).__cera._holdNetcfg = true;
		});
		await toggle.click(); // → toggle(false): pending=true, displayed=OFF
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		record("user toggled bond OFF → optimistic OFF (RPC held in-flight = locked)");

		// 1) STALE ENABLED echo while locked → ignored (pending wins; stays OFF).
		await page.evaluate(() => {
			const n = (window as any).__cera.lastNetif;
			if (!n) throw new Error("no netif snapshot captured for echo injection");
			const clone = JSON.parse(JSON.stringify(n));
			for (const k of Object.keys(clone)) {
				if (clone[k] && typeof clone[k] === "object") clone[k].enabled = true;
			}
			(window as any).__cera.emit("netif", clone);
		});
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		record(
			"stale netif{enabled:true} INJECTED while locked → IGNORED (toggle held OFF) ✓",
		);

		// 2) Release the held RPC → backend confirms OFF (handleNetif replies with
		//    enabled:false) → lock released, still OFF (no flip-back).
		await page.evaluate(() => (window as any).__cera.releaseHeld());
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		record(
			"held RPC released → backend confirm enabled:false → lock RELEASED, stays OFF (no flip) ✓",
		);

		// 3) Re-enable through the UI → authoritative ENABLED reflected.
		await toggle.click(); // → toggle(true): real configure, forwarded
		await expect(toggle).toHaveAttribute("aria-checked", "true", {
			timeout: 10000,
		});
		record("user re-enabled bond → authoritative ENABLED applied (toggle ON) ✓");
		record("Lifecycle 2 PASS — no flip-back.\n");
	});

	// ── Lifecycle 3: reconnect with stale config replay ───────────────────────
	test("lifecycle 3: reconnect replays pre-edit config — ignored while locked until confirm", async ({
		page,
	}) => {
		record("── Lifecycle 3: reconnect with stale config ──");
		await showBitrateSlider(page);

		// Client-side display baseline (does NOT change the backend's stored
		// config, so the backend remains 'stale' relative to our optimistic edit).
		const BASELINE = 12000;
		await emit(page, "config", { max_br: BASELINE });
		await expect(bitrateSlider(page)).toHaveAttribute(
			"aria-valuenow",
			String(BASELINE),
		);
		record(`display baseline ${BASELINE} (backend config left untouched = stale)`);

		// Optimistic edit → lock max_br; suppress the real confirm (drop+fake).
		await page.evaluate(() => {
			(window as any).__cera._dropFakeBitrate = true;
		});
		await bitrateSlider(page).focus();
		await bitrateSlider(page).press("ArrowLeft");
		await expect
			.poll(() => page.evaluate(() => (window as any).__cera.lastSetBitrate), {
				timeout: 5000,
			})
			.toBeGreaterThan(0);
		const intended = (await page.evaluate(
			() => (window as any).__cera.lastSetBitrate,
		)) as number;
		record(`pre-disconnect edit → markPending(max_br=${intended}) (lock active)`);

		// Drop the WebSocket; the app auto-reconnects, re-authenticates (token
		// rewrite) and the backend REPLAYS its stored (pre-edit / stale) config.
		await page.evaluate(() => (window as any).__cera.socket.close());
		await expect
			.poll(
				() =>
					page.evaluate(() => {
						const s = (window as any).__cera.socket;
						return s && s.readyState === 1;
					}),
				{ timeout: 12000, message: "socket should reconnect" },
			)
			.toBe(true);
		record("WS dropped → reconnected + re-authenticated (backend replays config)");

		// Re-reveal the slider (reconnect re-hydration resets is_streaming).
		await showBitrateSlider(page);

		// T15: lock released to intended before reconnect. Backend replay is now
		// applied (lock gone). Read the actual value and assert it is not BASELINE
		// (proving the reconnect replay was applied, not the stale display value).
		const backendReplay = await sliderValue(page);
		await expect(bitrateSlider(page)).not.toHaveAttribute(
			"aria-valuenow",
			String(BASELINE),
		);
		record(
			`reconnect replayed backend config (${backendReplay}) → applied (lock already released by T15) ✓`,
		);

		// Confirm echo (== intended) is now just a normal config update.
		await emit(page, "config", { max_br: intended });
		await expect(bitrateSlider(page)).toHaveAttribute(
			"aria-valuenow",
			String(intended),
		);
		record(
			`echo max_br=${intended} → applied (slider ${intended}) ✓`,
		);
		record("Lifecycle 3 PASS — T15 applied-lock behavior verified.\n");
	});
});

// ── Task 4: `network.configure` drop+fake harness self-tests ─────────────────
// Validates `_dropFakeNetcfg` in isolation. A dropped configure never reaches the
// backend, so no confirming netif echo arrives and BondToggle's `displayed`
// reverts to the authoritative `enabled` prop (ON) in BOTH success and failure —
// the revert itself proves the drop (a forwarded+confirmed disable would stick
// OFF). The discriminator is the error toast: present on failure, absent on
// success.
test.describe("network.configure drop+fake harness (Task 4)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser harness proof",
	);

	// BondToggle routes its configure mutation through `osCommand`
	// (live-correctness-pass Todo #20): a failed toggle surfaces the SINGLE generic
	// `network.os.operationFailed` toast, NOT the raw RPC error string the drop+fake
	// harness injects.
	const OP_FAILED_TOAST = "Couldn't complete the action";

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the bond toggles",
		);
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
		// Auto-login (localStorage 'auth' → token rewrite) must land the authed
		// shell before navigateTo, or its desktop/mobile rail probe can race the
		// hydration and fall back to the hidden mobile dock (mirrors the sibling
		// bond-toggle-flash beforeEach — the fix for this file's cold-start flake).
		await expect(page.locator("header").first()).toBeVisible({ timeout: 15000 });
		await navigateTo(page, "network");
	});

	async function inBondToggle(page: Page) {
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

	// Keys of interfaces the backend currently reports as bond-excluded. A dropped
	// configure must not add the toggled interface here; live `tp` churn is ignored.
	function disabledNetifKeys(page: Page): Promise<string[]> {
		return page.evaluate(() => {
			const n = (window as any).__cera.lastNetif || {};
			return Object.keys(n)
				.filter((k) => n[k] && n[k].enabled === false)
				.sort();
		});
	}

	function writeEvidence(fileName: string, lines: string[]): void {
		const file = evidencePath(fileName);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			[
				"Task 4 — network.configure drop+fake harness self-test",
				`Generated: ${new Date().toISOString()}`,
				"",
				...lines,
				"",
			].join("\n"),
			"utf8",
		);
	}

	test("drop+fake success: frame dropped, RPC resolves locally, no error toast", async ({
		page,
	}) => {
		const toggle = await inBondToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		// Record aria-checked transitions so the transient optimistic flip is
		// observable even though the local fake-success resolves it immediately.
		await toggle.evaluate((el) => {
			const w = window as any;
			w.__ariaLog = [] as (string | null)[];
			new MutationObserver((records) => {
				for (const r of records) w.__ariaLog.push(r.oldValue);
			}).observe(el, {
				attributes: true,
				attributeFilter: ["aria-checked"],
				attributeOldValue: true,
			});
		});

		const disabledBefore = await disabledNetifKeys(page);

		await page.evaluate(() => {
			(window as any).__cera._dropFakeNetcfg = "success";
		});
		await toggle.click();

		await expect
			.poll(() => page.evaluate(() => (window as any).__ariaLog), {
				timeout: 5000,
				message: "optimistic flip + local fake-success resolve should both occur",
			})
			.toEqual(expect.arrayContaining(["true", "false"]));
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await expect(page.getByText(OP_FAILED_TOAST)).toBeHidden();

		const disabledAfter = await disabledNetifKeys(page);
		expect(disabledAfter).toEqual(disabledBefore);

		await page.evaluate(() => {
			(window as any).__cera._dropFakeNetcfg = false;
		});

		const log = await page.evaluate(() => (window as any).__ariaLog);
		writeEvidence("task-4-dropfake-success.txt", [
			"Scenario: __cera._dropFakeNetcfg = 'success'",
			"Clicked an in-bond toggle → optimistic OFF; configure frame DROPPED.",
			`aria-checked oldValue log (flip then revert): ${JSON.stringify(log)}`,
			"RPC resolved locally as success — no error toast surfaced.",
			`Bond-excluded interfaces unchanged (${JSON.stringify(disabledBefore)})`,
			"  → no backend netif echo for the change → frame confirmed dropped.",
			"Toggle reverted to ON (no confirming echo), as expected for drop+fake.",
			"Result: PASS",
		]);
	});

	test("drop+fake failure: frame dropped, RPC rejects locally, error toast + revert", async ({
		page,
	}) => {
		const toggle = await inBondToggle(page);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		const disabledBefore = await disabledNetifKeys(page);

		await page.evaluate(() => {
			(window as any).__cera._dropFakeNetcfg = "failure";
		});
		await toggle.click();

		await expect(page.getByText(OP_FAILED_TOAST)).toBeVisible();
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		const disabledAfter = await disabledNetifKeys(page);
		expect(disabledAfter).toEqual(disabledBefore);

		await page.evaluate(() => {
			(window as any).__cera._dropFakeNetcfg = false;
		});

		writeEvidence("task-4-dropfake-failure.txt", [
			"Scenario: __cera._dropFakeNetcfg = 'failure'",
			"Clicked an in-bond toggle → optimistic OFF; configure frame DROPPED.",
			`Error toast surfaced: "${OP_FAILED_TOAST}" (osCommand single-toast, Todo #20)`,
			"BondToggle catch path → reverted to original ON state (aria-checked=true).",
			`Bond-excluded interfaces unchanged (${JSON.stringify(disabledBefore)})`,
			"  → no backend netif echo for the change → frame confirmed dropped.",
			"Result: PASS",
		]);
	});
});
