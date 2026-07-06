import fs from "node:fs";

import { expect, type Page, test } from "./fixtures/index.js";

import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers/index.js";

/**
 * Audit A2 (companion) — full SIM PIN unlock walk under the `modem-pin-locked`
 * scenario, @audit. Reached via the worker-scoped backendScenario override
 * (PLAYBOOK.md → Per-Worker Backend Scenario Override): a worker-scoped `test.use`
 * MUST sit at file top level, so this scenario gets its own file.
 *
 * modem-pin-locked seeds modem 0 as SIM-PIN-locked (fixture PIN "0000", 3-attempt
 * budget) and routes `modems.unlockSim`/`unlockSimPuk` to the REAL mock SIM state
 * machine (mockAttemptSimUnlock). WS-proxy injection cannot fake that handler-owned
 * state, so the PIN walk runs end-to-end against the genuinely-booted scenario.
 *
 * Walk (serial):
 *   A. Real PIN walk — the auto-prompted SimUnlockDialog: two wrong PINs decrement
 *      the visible remaining-attempts counter (3→2→1), then the correct "0000"
 *      unlocks and the dialog closes.
 *   B. PUK reachability — the PUK recovery form is reachable (inputs + decremented
 *      attempts). Because the single seeded PIN-locked modem is consumed by the
 *      real unlock in (A) — one PIN budget cannot serve BOTH a successful unlock
 *      AND an exhaustion-to-PUK — the PUK form is reached by injecting a
 *      sim-puk-locked modem via dev.emit; the PUK form/inputs are pure UI state.
 */
test.use({ backendScenario: "modem-pin-locked" });

/** Self-contained page harness: capture modems + expose dev.emit for injection. */
function installPinHarness(): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__pin) return;
	const Real = w.WebSocket;
	w.__pin = {
		socket: null,
		lastModems: null as null | Record<string, unknown>,
		_seq: 0,
		emit(type: string, payload: unknown) {
			const s = w.__pin.socket;
			if (s)
				s.__realSend(
					JSON.stringify({
						id: `pin-emit-${++w.__pin._seq}`,
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
			w.__pin.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
			this.addEventListener("message", (ev: MessageEvent) => {
				try {
					const o = JSON.parse(ev.data);
					const modems = o?.modems ?? o?.status?.modems;
					if (modems && typeof modems === "object") {
						const cur = w.__pin.lastModems ?? {};
						const next: Record<string, unknown> = { ...cur };
						for (const [id, entry] of Object.entries(modems)) {
							next[id] = { ...((cur as Record<string, object>)[id] ?? {}), ...(entry as object) };
						}
						w.__pin.lastModems = next;
					}
				} catch {
					/* non-JSON frame */
				}
			});
		}
	}
	w.WebSocket = HookedWS;
}

/** Clone the first captured modem, stamp a sim-puk lock, and re-broadcast it. */
function injectPukModem(page: Page): Promise<string> {
	return page.evaluate(() => {
		const w = window as unknown as {
			__pin: { lastModems: Record<string, unknown> | null; emit(t: string, p: unknown): void };
		};
		const modems = w.__pin.lastModems;
		if (!modems || Object.keys(modems).length === 0) {
			throw new Error("no modem snapshot captured for PUK injection");
		}
		const key = Object.keys(modems)[0] as string;
		const clone = JSON.parse(JSON.stringify(modems[key])) as Record<string, unknown>;
		clone.sim_lock = { required: "sim-puk", remainingAttempts: 10 };
		w.__pin.emit("modems", { [key]: clone });
		return key;
	});
}

test.describe.configure({ mode: "serial" });

test.describe("Audit A2 — SIM PIN/PUK walk (modem-pin-locked)", { tag: "@audit" }, () => {
	test.skip(({ browserName }) => browserName !== "chromium", "single-browser integration proof");

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the SIM unlock UI",
		);
		await page.addInitScript(installPinHarness);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
	});

	test("real PIN walk: two wrong PINs decrement remaining attempts, then 0000 unlocks + closes", async ({
		page,
	}) => {
		// modem 0 is PIN-locked in this scenario → the dialog auto-prompts.
		const input = page.getByTestId("sim-pin-input");
		const submit = page.getByTestId("sim-pin-submit");
		const error = page.getByTestId("sim-pin-error");
		await expect(input).toBeVisible({ timeout: 20_000 });

		// Wrong PIN #1 → real RPC decrements the 3-attempt budget to 2.
		await input.fill("1111");
		await expect(submit).toBeEnabled();
		await submit.click();
		await expect(error).toBeVisible();
		await expect(error).toContainText("2");
		// A wrong PIN must NOT auto-escalate to the PUK form.
		await expect(page.getByTestId("sim-puk-required")).toHaveCount(0);

		// Wrong PIN #2 → budget decrements to 1 (visible in the SAME inline error).
		await input.fill("2222");
		await expect(submit).toBeEnabled();
		await submit.click();
		await expect(error).toBeVisible();
		await expect(error).toContainText("1");
		await expect(page.getByTestId("sim-puk-required")).toHaveCount(0);

		// Correct fixture PIN → real unlock → dialog closes.
		await input.fill("0000");
		await expect(submit).toBeEnabled();
		await submit.click();
		await expect(input).toBeHidden({ timeout: 15_000 });

		fs.writeFileSync(
			evidencePath("audit-network-pin-walk.txt"),
			[
				"Audit A2 — real SIM PIN unlock walk (modem-pin-locked)",
				`Generated: ${new Date().toISOString()}`,
				"",
				"modem 0 PIN-locked → SimUnlockDialog auto-prompted.",
				"Wrong PIN 1111 → real mockAttemptSimUnlock → remaining attempts 2 (asserted).",
				"Wrong PIN 2222 → remaining attempts 1 (asserted); no PUK auto-escalation.",
				"Correct fixture PIN 0000 → real unlock → dialog closed (sim-pin-input hidden).",
				"Result: PASS (genuine RPC-handler state, not WS-proxy injection).",
				"",
			].join("\n"),
			"utf8",
		);
	});

	test("PUK recovery form is reachable with decremented-attempts surface", async ({ page }) => {
		// Wait for a modem snapshot so the injection has a real modem to clone.
		await expect
			.poll(
				() =>
					page.evaluate(() => {
						const w = window as unknown as { __pin: { lastModems: Record<string, unknown> | null } };
						return w.__pin.lastModems ? Object.keys(w.__pin.lastModems).length : 0;
					}),
				{ timeout: 15_000, message: "modem snapshot should arrive" },
			)
			.toBeGreaterThan(0);

		await injectPukModem(page);

		// The PUK recovery form auto-prompts: PUK + new-PIN inputs and submit render;
		// the PIN form is superseded (a PUK lock can no longer be cleared by a PIN).
		await expect(page.getByTestId("sim-puk-required")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("sim-puk-input")).toBeVisible();
		await expect(page.getByTestId("sim-puk-newpin-input")).toBeVisible();
		await expect(page.getByTestId("sim-puk-submit")).toBeVisible();
		await expect(page.getByTestId("sim-pin-input")).toHaveCount(0);

		fs.writeFileSync(
			evidencePath("audit-network-puk-reachable.txt"),
			[
				"Audit A2 — SIM PUK recovery reachability (modem-pin-locked)",
				`Generated: ${new Date().toISOString()}`,
				"",
				"Injected sim-puk lock → SimUnlockDialog escalated to the PUK recovery form.",
				"sim-puk-required + sim-puk-input + sim-puk-newpin-input + sim-puk-submit rendered;",
				"PIN form superseded (a PUK lock cannot be cleared by a PIN).",
				"Result: PASS.",
				"",
			].join("\n"),
			"utf8",
		);
	});
});
