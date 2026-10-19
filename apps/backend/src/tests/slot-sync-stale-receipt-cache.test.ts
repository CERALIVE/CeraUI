import { afterEach, expect, test } from "bun:test";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { raucSlots } from "./helpers/slot-sync-rauc.ts";
import {
	evidence,
	fixture,
	statusSha256,
} from "./helpers/slot-sync-runtime-harness.ts";

const matchingReceipt = { ...evidence, receiptStateSha256: statusSha256 };

afterEach(() => resetOrchestratorRuntimeForTest());

test("a backward clock step re-reads cached target health before mirror dispatch", async () => {
	// Given a good inactive target cached at a later wall-clock time.
	let now = 2_000;
	let slots = raucSlots("A");
	let reads = 0;
	const h = fixture({
		now: () => now,
		readSlotSyncEvidence: async () => matchingReceipt,
		readOsReceipt: async () => undefined,
		readRootSlots: async () => {
			reads++;
			return slots;
		},
	});
	setOrchestratorStateForTest(initialOrchestratorState(0));
	await runOrchestratorTick();
	expect(h.commands).toEqual([]);
	expect(reads).toBe(1);
	slots = raucSlots("A", "bad");
	now = 1_000;

	// When the clock steps backwards before the next eligibility check.
	await runOrchestratorTick();

	// Then fresh bad-target evidence permits one mirror, not the cached refusal.
	expect(reads).toBe(2);
	expect(h.commands).toHaveLength(1);
});

test("changed receipt target identity re-reads cached health inside 60 seconds", async () => {
	// Given cached good health under the canonical inactive-slot name.
	let slots = raucSlots("A");
	let reads = 0;
	const h = fixture({
		readOsReceipt: async () => undefined,
		readRootSlots: async () => {
			reads++;
			return slots;
		},
	});
	h.setEvidence(matchingReceipt);
	setOrchestratorStateForTest(initialOrchestratorState(0));
	await runOrchestratorTick();
	expect(h.commands).toEqual([]);
	expect(reads).toBe(1);
	slots = raucSlots("A", "bad");
	// The bootname is another valid identity for the same inactive target.
	h.setEvidence({ ...matchingReceipt, receiptTargetSlot: "B" });

	// When evidence changes at the same injected time, before cache expiry.
	await runOrchestratorTick();

	// Then the changed identity gets fresh RAUC evidence and one mirror dispatch.
	expect(reads).toBe(2);
	expect(h.commands).toHaveLength(1);
});

test("leaving idle and returning during a target read refuses stale dispatch authority", async () => {
	// Given a target read spanning a different state generation, ending idle again.
	let reads = 0;
	const phases: string[] = [];
	const h = fixture({
		readSlotSyncEvidence: async () => matchingReceipt,
		readOsReceipt: async () => undefined,
		persist: (state) => phases.push(state.phase),
		readRootSlots: async () => {
			reads++;
			if (reads === 1) {
				setOrchestratorStateForTest({
					...initialOrchestratorState(0),
					phase: "os-staged",
				});
				setOrchestratorStateForTest(initialOrchestratorState(0));
			}
			return raucSlots("A", "bad");
		},
	});
	setOrchestratorStateForTest(initialOrchestratorState(0));

	// When the awaited read reports a bad inactive target to the original tick.
	await runOrchestratorTick();

	// Then even transient eligibility/dispatch must be refused despite ending idle.
	expect(reads).toBe(1);
	expect(phases).toEqual([]);
	expect(h.commands).toEqual([]);
	expect(getOrchestratorState().phase).toBe("idle");
});
