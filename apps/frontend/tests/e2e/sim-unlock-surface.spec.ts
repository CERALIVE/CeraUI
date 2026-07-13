import fs from "node:fs";

import { expect, type Page, test } from "./fixtures/index.js";

import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers";

/**
 * T13 — SIM unlock surface error-persistence (ceraui-os-interaction-ux), @functional.
 *
 * Drives the REAL SimUnlockDialog (auto-prompted by NetworkView when a modem
 * reports a SIM lock) against the dev backend with DOM/ARIA-only assertions. The
 * regression pinned here: the inline unlock error + decremented attempt counter
 * are LOCAL dialog state, set only from the submit result — a subsequent periodic
 * `modems` re-broadcast (which still carries the pre-submit attempt count) must
 * NOT erase or reset them.
 *
 * Two flows are covered, matching the predicates from T12
 * (`classifySimPinResult` / `classifySimPukResult`):
 *   - PIN wrong-pin → inline error with the decremented attempts that survive a
 *     re-broadcast; no PUK auto-escalation.
 *   - PUK wrong-puk → inline error with the decremented PUK attempts that survive
 *     a re-broadcast.
 *
 * Determinism comes from the same WS harness pattern as the other modem specs:
 * the locked modem is injected via `dev.emit`; unlock RPCs are dropped + faked
 * so their terminal state is owned by the test (mock mode otherwise reports
 * `no-locked-modem`). No fixed-delay waits.
 *
 * Topology: local Vite dev on :6173 uses `__ceraSocketPort`; CI prebuilt Vite
 * preview on :6173 uses the HttpOnly cookie. Both target this worker's 31xx
 * development backend.
 */

// Use a non-first modem so coverage is not tied to the fixture's first entry.
// The worker backend's 30s coalescer survives across tests assigned to that
// worker and can drop a broadcast identical to its previous payload; a distinct
// modem and varied stale attempt counts keep this test's frames unique while
// also proving no stale count erases the post-submit one.
const MODEM_INDEX = 2;

function installWsHarness(): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		lastModems: null as null | Record<string, unknown>,
		// Map<path, result>. A dropped+faked unlock RPC resolves locally with the
		// configured terminal so the success / wrong-pin / wrong-puk branches are
		// deterministic with no PIN/PUK-locked hardware.
		_rpcFake: {} as Record<string, unknown>,
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
					const modems = o?.modems ?? o?.status?.modems;
					if (modems && typeof modems === "object") {
						w.__cera.lastModems = modems;
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
				if (p && Object.prototype.hasOwnProperty.call(w.__cera._rpcFake, p)) {
					const result = w.__cera._rpcFake[p];
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
}

function armFake(page: Page, path: string, result: unknown): Promise<void> {
	return page.evaluate(
		([pth, res]) => {
			(window as any).__cera._rpcFake[pth] = res;
		},
		[path, result] as const,
	);
}

/** Clone the dedicated live modem, stamp a SIM lock, and re-broadcast it. */
function injectLockedModem(
	page: Page,
	lock: { required: string; remainingAttempts?: number },
): Promise<string> {
	return page.evaluate(
		([simLock, index]) => {
			const w = window as any;
			const modems = w.__cera.lastModems;
			const key = modems ? Object.keys(modems)[index as number] : undefined;
			if (!key) throw new Error("no modem at the dedicated index to lock");
			const clone = JSON.parse(JSON.stringify(modems[key]));
			clone.sim_lock = simLock;
			w.__cera.emit("modems", { [key]: clone });
			return key;
		},
		[lock, MODEM_INDEX] as const,
	);
}

/** Re-broadcast the locked modem unchanged — the periodic full-state tick. */
function reBroadcastLocked(
	page: Page,
	key: string,
	lock: { required: string; remainingAttempts?: number },
): Promise<void> {
	return page.evaluate(
		([k, simLock]) => {
			const w = window as any;
			const clone = JSON.parse(JSON.stringify(w.__cera.lastModems[k]));
			clone.sim_lock = simLock;
			w.__cera.emit("modems", { [k]: clone });
		},
		[key, lock] as const,
	);
}


test.describe(
	"sim unlock surface — inline error persists across a modems re-broadcast",
	{ tag: "@functional" },
	() => {
		test.skip(
			({ browserName }) => browserName !== "chromium",
			"single-browser integration proof",
		);

		const evidence: string[] = [];
		const record = (line: string) => evidence.push(line);

		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"desktop layout drives the SIM unlock UI",
			);
			await page.addInitScript(installWsHarness);
			await page.goto("/");
			await ensureAuthenticated(page);
			await navigateTo(page, "network");
			await expect
				.poll(
					() =>
						page.evaluate(() => {
							const m = (window as any).__cera.lastModems;
							return m ? Object.keys(m).length : 0;
						}),
					{ timeout: 15000, message: "modem snapshot should arrive" },
				)
				.toBeGreaterThan(0);
		});

		test.afterAll(async () => {
			fs.writeFileSync(
				evidencePath("task-13-sim-unlock-surface.txt"),
				[
					"T13 — SIM unlock surface error-persistence: functional E2E evidence",
					"Driver: real SimUnlockDialog (classifySimPinResult / classifySimPukResult",
					"        predicates + local error state) vs. real dev backend; locked modem",
					"        injected via dev.emit, unlock RPCs pinned via drop+fake.",
					`Generated: ${new Date().toISOString()}`,
					"",
					...evidence,
					"",
				].join("\n"),
				"utf8",
			);
		});

		test("a wrong-pin inline error and its decremented attempts survive a subsequent modems re-broadcast", async ({
			page,
		}) => {
			record("── sim PIN: wrong-pin error persists across a re-broadcast ──");
			await armFake(page, "modems.unlockSim", {
				state: "wrong-pin",
				remainingAttempts: 2,
			});

			const key = await injectLockedModem(page, {
				required: "sim-pin",
				remainingAttempts: 3,
			});

			const input = page.getByTestId("sim-pin-input");
			const submit = page.getByTestId("sim-pin-submit");
			await expect(input).toBeVisible();
			await input.fill("0000");
			await expect(submit).toBeEnabled();
			await submit.click();

			const error = page.getByTestId("sim-pin-error");
			await expect(error).toBeVisible();
			await expect(error).toContainText("2");
			record(
				"submitted wrong PIN → inline error shows decremented attempts (2)",
			);

			// A periodic full-state re-broadcast still carries the PRE-submit attempt
			// count (3). The local inline error must survive — not reset to 3, not
			// cleared, and the dialog must not auto-escalate to the PUK form.
			for (let i = 0; i < 3; i++) {
				await reBroadcastLocked(page, key, {
					required: "sim-pin",
					remainingAttempts: 3 + i,
				});
			}
			await expect(error).toBeVisible();
			await expect(error).toContainText("2");
			await expect(input).toBeVisible();
			await expect(page.getByTestId("sim-puk-required")).toHaveCount(0);
			record(
				"injected 3 modems re-broadcasts (stale attempts=3) → error STILL shows 2, PIN field kept, no PUK escalation ✓",
			);
		});

		test("a wrong-puk inline error and its decremented attempts survive a subsequent modems re-broadcast", async ({
			page,
		}) => {
			record("── sim PUK: wrong-puk error persists across a re-broadcast ──");
			await armFake(page, "modems.unlockSimPuk", {
				success: false,
				error: "wrong-puk",
				remainingAttempts: 7,
			});

			const key = await injectLockedModem(page, {
				required: "sim-puk",
				remainingAttempts: 8,
			});

			const puk = page.getByTestId("sim-puk-input");
			const newPin = page.getByTestId("sim-puk-newpin-input");
			const submit = page.getByTestId("sim-puk-submit");
			await expect(puk).toBeVisible();
			await puk.fill("00000000");
			await newPin.fill("1234");
			await expect(submit).toBeEnabled();
			await submit.click();

			const error = page.getByTestId("sim-puk-error");
			const attempts = page.getByTestId("sim-puk-attempts");
			await expect(error).toBeVisible();
			await expect(attempts).toContainText("7");
			record(
				"submitted wrong PUK → inline error + decremented PUK attempts (7)",
			);

			// The stale re-broadcast carries the pre-submit PUK count (8); the local
			// decremented count (7) must survive and the PUK form stays open.
			for (let i = 0; i < 3; i++) {
				await reBroadcastLocked(page, key, {
					required: "sim-puk",
					remainingAttempts: 8 + i,
				});
			}
			await expect(error).toBeVisible();
			await expect(attempts).toContainText("7");
			await expect(puk).toBeVisible();
			record(
				"injected 3 modems re-broadcasts (stale attempts=8) → error STILL shows 7, PUK form kept ✓",
			);
		});
	},
);
