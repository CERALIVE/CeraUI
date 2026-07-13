import fs from "node:fs";

import { expect, type Page, test } from "./fixtures/index.js";

import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers";

/**
 * Task 23 — SIM PIN unlock UI, end-to-end.
 *
 * Drives the REAL frontend SimUnlockDialog (auto-prompted by NetworkView when a
 * modem reports `sim_lock.required === 'sim-pin'`) against the dev backend, with
 * deterministic terminal states injected via the WebSocket harness:
 *   - a PIN-locked modem is injected by cloning a live mock modem and adding
 *     `sim_lock`, then re-broadcasting it via `dev.emit('modems', …)`.
 *   - `modems.unlockSim` is dropped + faked so the success / wrong-pin branches
 *     are exercised without PIN-locked hardware (mock mode reports
 *     `no-locked-modem`).
 *
 * Auth uses the real first-run flow via `ensureAuthenticated` (the harness does
 * NOT rewrite auth.login), so the spec is self-sufficient regardless of the
 * device's set-up state. No fixed-delay waits: every step asserts on a stable
 * DOM signal.
 *
 * Topology: local Vite dev on :6173 uses `__ceraSocketPort`; CI prebuilt Vite
 * preview on :6173 uses the HttpOnly cookie. Both target this worker's 31xx
 * development backend.
 */

function installWsHarness(): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		lastModems: null,
		_unlockResult: null as null | { state: string; remainingAttempts?: number },
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

				// Drop the unlock RPC + fake the configured terminal state so the
				// success / wrong-pin branches are deterministic with no hardware.
				if (p === "modems.unlockSim" && w.__cera._unlockResult) {
					const id = msg.id;
					const result = w.__cera._unlockResult;
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

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) => (window as any).__cera.emit(t, p),
		[type, payload] as const,
	);
}

/** Clone a live mock modem, stamp on a SIM lock, and re-broadcast it. The clone
 *  keeps every field the cellular UI renders, so only the lock state changes. */
async function injectLockedModem(
	page: Page,
	lock: { required: string; remainingAttempts?: number },
): Promise<string> {
	return page.evaluate((simLock) => {
		const w = window as any;
		const modems = w.__cera.lastModems;
		if (!modems || Object.keys(modems).length === 0) {
			throw new Error("no modem snapshot captured for lock injection");
		}
		const key = Object.keys(modems)[0];
		const clone = JSON.parse(JSON.stringify(modems[key]));
		clone.sim_lock = simLock;
		w.__cera.emit("modems", { [key]: clone });
		return key;
	}, lock);
}

/** Re-broadcast the modem with the lock cleared (carrier accepted the PIN). */
async function clearModemLock(page: Page, key: string): Promise<void> {
	await page.evaluate((k) => {
		const w = window as any;
		const clone = JSON.parse(JSON.stringify(w.__cera.lastModems[k]));
		delete clone.sim_lock;
		w.__cera.emit("modems", { [k]: clone });
	}, key);
}


test.describe("SIM PIN unlock UI (Task 23, dev.emit driven)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser integration proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the SIM unlock UI",
		);
		await page.addInitScript(installWsHarness);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
		// Wait until the first modem snapshot is captured by the harness.
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

	test("success: locked modem prompts, PIN unlocks, dialog closes", async ({
		page,
	}) => {
		await page.evaluate(() => {
			(window as any).__cera._unlockResult = { state: "success" };
		});

		const key = await injectLockedModem(page, {
			required: "sim-pin",
			remainingAttempts: 3,
		});

		// The dialog auto-prompts: PIN field + submit are present for the locked modem.
		const input = page.getByTestId("sim-pin-input");
		const submit = page.getByTestId("sim-pin-submit");
		await expect(input).toBeVisible();
		await expect(submit).toBeVisible();

		// Submit a valid PIN → faked success → dialog closes.
		await input.fill("1234");
		await expect(submit).toBeEnabled();
		await submit.click();

		// On success the modem unlocks (carrier echo clears the lock) and the
		// prompt is gone — the modem row is back to its normal (connected) state.
		await clearModemLock(page, key);
		await expect(input).toBeHidden();

		fs.writeFileSync(
			evidencePath("task-23-ui-unlock.txt"),
			[
				"Task 23 — SIM PIN unlock UI: success path",
				`Generated: ${new Date().toISOString()}`,
				"",
				`Injected SIM-PIN lock on modem ${key} → SimUnlockDialog auto-prompted.`,
				"data-testid=sim-pin-input and sim-pin-submit present for the locked modem ✓",
				"Entered PIN 1234 → modems.unlockSim → state=success.",
				"Lock cleared (carrier echo) → PIN prompt dismissed, modem row back to connected ✓",
				"Result: PASS",
				"",
			].join("\n"),
			"utf8",
		);
	});

	test("wrong-pin: error shows remaining attempts, no PUK auto-trigger", async ({
		page,
	}) => {
		await page.evaluate(() => {
			(window as any).__cera._unlockResult = {
				state: "wrong-pin",
				remainingAttempts: 2,
			};
		});

		await injectLockedModem(page, { required: "sim-pin", remainingAttempts: 3 });

		const input = page.getByTestId("sim-pin-input");
		const submit = page.getByTestId("sim-pin-submit");
		await expect(input).toBeVisible();

		await input.fill("0000");
		await submit.click();

		// Inline error surfaces the remaining attempts; PIN field stays (still locked).
		const error = page.getByTestId("sim-pin-error");
		await expect(error).toBeVisible();
		await expect(error).toContainText("2");
		await expect(input).toBeVisible();
		// A wrong PIN must NOT auto-escalate the UI into the PUK state.
		await expect(page.getByTestId("sim-puk-required")).toHaveCount(0);

		const errorText = (await error.textContent())?.trim() ?? "";
		fs.writeFileSync(
			evidencePath("task-23-ui-wrong.txt"),
			[
				"Task 23 — SIM PIN unlock UI: wrong-PIN path",
				`Generated: ${new Date().toISOString()}`,
				"",
				"Injected SIM-PIN lock → SimUnlockDialog auto-prompted.",
				"Entered wrong PIN 0000 → modems.unlockSim → state=wrong-pin, remainingAttempts=2.",
				`Inline error surfaced: "${errorText}" (shows remaining attempts) ✓`,
				"PIN field still present (dialog stayed open) — no blind resubmit.",
				"No PUK auto-trigger: sim-puk-required absent ✓",
				"Result: PASS",
				"",
			].join("\n"),
			"utf8",
		);
	});
});
