import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { RootSlotStatus } from "../modules/system/update-orchestrator/slot-status.ts";
import type { SlotSyncEvidence } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { raucSlots } from "./helpers/slot-sync-rauc.ts";
import { fixture, statusSha256 } from "./helpers/slot-sync-runtime-harness.ts";

// OPI fallback: B is healthy, but the install overwrote A after this receipt.
const matchingReceipt: SlotSyncEvidence = {
	healthyState: {
		boot_id: "fallback-boot",
		slot: "B",
		build_id: "same-build",
		dpkg_status_sha256: statusSha256,
		recorded_at: "2026-10-19T19:11:15Z",
	},
	bootId: "fallback-boot",
	statusSha256,
	buildId: "same-build",
	receiptStateSha256: statusSha256,
	receiptTarget: "other",
	receiptTargetSlot: "rootfs.0",
};

function fallbackFixture() {
	let now = 1_000;
	let slots = raucSlots("B", "bad");
	let receipt = matchingReceipt;
	let reads = 0;
	const phases: string[] = [];
	const h = fixture({
		now: () => now,
		readSlotSyncEvidence: async () => receipt,
		readRootSlots: async () => {
			reads++;
			return slots;
		},
		readOsReceipt: async () => undefined,
		persist: (state) => phases.push(state.phase),
	});
	setOrchestratorStateForTest(initialOrchestratorState(0));
	return {
		...h,
		phases,
		reads: () => reads,
		advance: (ms: number) => {
			now += ms;
		},
		setSlots: (value: readonly RootSlotStatus[]) => {
			slots = value;
		},
		rewriteReceipt: () => {
			receipt = { ...matchingReceipt };
		},
	};
}

afterEach(() => resetOrchestratorRuntimeForTest());

test("fallback with an unchanged dpkg hash dispatches the bad-target mirror once", async () => {
	// Given the earlier receipt still matches the healthy B packages.
	const h = fallbackFixture();
	// When the idle scheduler evaluates the overwritten, bad A slot.
	await runOrchestratorTick();
	// Then eligibility precedes the existing unit dispatch, sharing one RAUC read.
	expect(h.phases).toEqual(["sync-eligible", "syncing"]);
	expect(h.commands).toHaveLength(1);
	expect(h.reads()).toBe(1);
});

test("a matching receipt into a good inactive slot suppresses dispatch with bounded reads", async () => {
	const h = fallbackFixture();
	h.setSlots(raucSlots("B"));
	for (let tick = 0; tick < 20; tick++) {
		await runOrchestratorTick();
		h.advance(1_000);
	}
	expect(getOrchestratorState().phase).toBe("idle");
	expect(h.commands).toEqual([]);
	expect(h.reads()).toBe(1);
});

test("a previously good target that turns bad is re-observed at the refresh bound", async () => {
	const h = fallbackFixture();
	h.setSlots(raucSlots("B"));
	await runOrchestratorTick();
	h.setSlots(raucSlots("B", "bad"));
	h.advance(60_000);
	await runOrchestratorTick();
	expect(h.commands).toHaveLength(1);
	expect(h.reads()).toBe(2);
});

for (const status of ["unknown", "", "pending"]) {
	test(`undecidable inactive status ${JSON.stringify(status)} refuses and logs once`, async () => {
		const h = fallbackFixture();
		h.setSlots(raucSlots("B", status));
		const warn = spyOn(logger, "warn");
		try {
			for (let tick = 0; tick < 3; tick++) {
				await runOrchestratorTick();
				h.advance(60_000);
			}
			expect(h.commands).toEqual([]);
			expect(getOrchestratorState().phase).toBe("idle");
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
}

test("unreadable RAUC refuses, logs once and does not spawn again inside 60 seconds", async () => {
	let reads = 0;
	const h = fixture({
		readSlotSyncEvidence: async () => matchingReceipt,
		readOsReceipt: async () => undefined,
		readRootSlots: async () => {
			reads++;
			throw new Error("fixture RAUC unavailable");
		},
	});
	setOrchestratorStateForTest(initialOrchestratorState(0));
	const warn = spyOn(logger, "warn");
	try {
		for (let tick = 0; tick < 10; tick++) await runOrchestratorTick();
		expect(h.commands).toEqual([]);
		expect(reads).toBe(1);
		expect(warn).toHaveBeenCalledTimes(1);
	} finally {
		warn.mockRestore();
	}
});

test("an already syncing bad target is polled without another dispatch", async () => {
	const h = fallbackFixture();
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "syncing",
	});
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("syncing");
	expect(h.commands).toEqual([]);
});

test("a rewritten receipt and good target settle the recovery without repeat dispatch", async () => {
	const h = fallbackFixture();
	await runOrchestratorTick();
	h.rewriteReceipt();
	h.setSlots(raucSlots("B"));
	h.setProbe("inactive-clean");
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("synced");
	for (let tick = 0; tick < 4; tick++) {
		h.advance(60_000);
		await runOrchestratorTick();
	}
	expect(getOrchestratorState().phase).toBe("idle");
	expect(h.commands).toHaveLength(1);
});

for (const slots of [
	[],
	raucSlots("B", "bad").slice(0, 1),
	raucSlots("A", "bad"),
	raucSlots("B", "bad").map((slot) => ({ ...slot, bootStatus: "bad" })),
]) {
	test(`unproven boot/target roster ${JSON.stringify(slots)} never dispatches`, async () => {
		const h = fallbackFixture();
		h.setSlots(slots);
		await runOrchestratorTick();
		expect(h.commands).toEqual([]);
		expect(getOrchestratorState().phase).toBe("idle");
	});
}

test("a pending OS phase reached during the target read wins over bad-target evidence", async () => {
	const h = fixture({
		readSlotSyncEvidence: async () => matchingReceipt,
		readOsReceipt: async () => undefined,
		readRootSlots: async () => {
			setOrchestratorStateForTest({
				...initialOrchestratorState(0),
				phase: "os-staged",
			});
			return raucSlots("B", "bad");
		},
	});
	setOrchestratorStateForTest(initialOrchestratorState(0));
	await runOrchestratorTick();
	expect(h.commands).toEqual([]);
	expect(getOrchestratorState().phase).toBe("os-staged");
});

test("an OS write phase invalidates a cached good target before returning idle", async () => {
	const h = fallbackFixture();
	h.setSlots(raucSlots("B"));
	await runOrchestratorTick();
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-verifying",
	});
	h.setSlots(raucSlots("B", "bad"));
	setOrchestratorStateForTest(initialOrchestratorState(0));
	await runOrchestratorTick();
	expect(h.commands).toHaveLength(1);
	expect(h.reads()).toBe(2);
});

test("a failed recovery retains the existing sticky failure instead of looping", async () => {
	const h = fallbackFixture();
	await runOrchestratorTick();
	h.setProbe("absent");
	h.advance(100_000);
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("failed");
	for (let tick = 0; tick < 20; tick++) {
		h.advance(60_000);
		await runOrchestratorTick();
	}
	expect(getOrchestratorState().phase).toBe("failed");
	expect(h.commands).toHaveLength(1);
});
