import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import type { SlotSyncProbeState } from "../modules/system/update-orchestrator/lock.ts";
import {
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	SLOT_SYNC_QUEUED_START_GRACE_MS,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	type HealthySlotState,
	type SlotSyncEvidence,
	slotSyncGate,
} from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import {
	classifyReceiptTarget,
	parseRaucSlotBootnames,
} from "../modules/system/update-orchestrator/slot-sync-state.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { raucSlots } from "./helpers/slot-sync-rauc.ts";

// Round 15 review items: a transient CONFIRMATION probe failure, a receipt
// target the bootname map cannot resolve, and a silent identity skip.

const statusSha256 = "a".repeat(64);
const bootedA: HealthySlotState = {
	boot_id: "boot-new",
	slot: "A",
	build_id: "build-new",
	dpkg_status_sha256: statusSha256,
	recorded_at: "2026-09-30T11:33:49Z",
};
const mirroredIntoB: SlotSyncEvidence = {
	healthyState: bootedA,
	bootId: "boot-new",
	statusSha256,
	buildId: "build-new",
	receiptStateSha256: statusSha256,
	receiptTarget: "other",
	receiptTargetSlot: "rootfs.1",
};
const clean: SlotSyncProbeState = { kind: "inactive-clean" };
const absent: SlotSyncProbeState = { kind: "absent" };
const PAST_GRACE = SLOT_SYNC_QUEUED_START_GRACE_MS * 100;

afterEach(() => resetOrchestratorRuntimeForTest());

function harness(start: {
	readonly phase: "idle" | "sync-eligible" | "syncing";
	readonly evidence: SlotSyncEvidence;
}) {
	const probes: SlotSyncProbeState[] = [];
	const cleanup: string[] = [];
	const persisted: { phase: string; failureReason: string | null }[] = [];
	const dispatched: string[] = [];
	let evidence = start.evidence;
	setOrchestratorRuntimeDepsForTest({
		...defaultOrchestratorRuntimeDeps,
		now: () => PAST_GRACE,
		loadCapabilities: async () => ({
			mode: "capable",
			features: ["apt-all-packages", "slot-sync"],
		}),
		loadSettings: async () => ({
			packagesAuto: false,
			systemAuto: false,
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			channel: "stable",
			allowPackagesOverCellular: true,
			allowSystemOverCellular: false,
		}),
		isStreamLive: () => false,
		readSlotSyncEvidence: async () => evidence,
		readRootSlots: async () => raucSlots("A"),
		startSlotSync: async () => {
			dispatched.push("ceralive-slot-sync.service");
		},
		inspectSlotSync: async () => probes.shift() ?? clean,
		resetSlotSyncFailure: async () => {},
		cleanSlotSyncArchives: async () => {
			cleanup.push("apt");
			return true;
		},
		removeRaucDownloads: async () => {
			cleanup.push("downloads");
		},
		dropSupersededQuarantine: async () => {
			cleanup.push("quarantine");
		},
		refreshSlots: async () => {
			cleanup.push("slots");
		},
		persist: (next) => {
			persisted.push({ phase: next.phase, failureReason: next.failureReason });
		},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: start.phase,
	});
	return {
		cleanup,
		persisted,
		dispatched,
		queueProbes: (...next: SlotSyncProbeState[]) => probes.push(...next),
		setEvidence: (value: SlotSyncEvidence) => {
			evidence = value;
		},
	};
}

describe("a transient confirmation-probe failure is not a verdict", () => {
	test("matching receipt, clean first probe, absent confirmation: stays syncing with nothing persisted", async () => {
		const h = harness({ phase: "syncing", evidence: mirroredIntoB });
		h.queueProbes(clean, absent);
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("syncing");
		expect(getOrchestratorState().failureReason).toBeNull();
		expect(h.persisted.map((entry) => entry.phase)).not.toContain("failed");
		expect(h.cleanup).toEqual([]);
	});

	test("the next poll fails a persistent absent as unit-absent, persisted", async () => {
		const h = harness({ phase: "syncing", evidence: mirroredIntoB });
		h.queueProbes(clean, absent, absent);
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("slot-sync-unit-absent");
		expect(h.persisted.at(-1)).toEqual({
			phase: "failed",
			failureReason: "slot-sync-unit-absent",
		});
		expect(h.cleanup).toEqual([]);
	});

	test("the next poll with a clean, matching pair settles synced", async () => {
		const h = harness({ phase: "syncing", evidence: mirroredIntoB });
		h.queueProbes(clean, absent, clean, clean);
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("synced");
		expect(h.cleanup).toEqual(["apt", "downloads", "quarantine", "slots"]);
	});
});

describe("a receipt target the bootname map cannot resolve is unknown", () => {
	// The map names the booted slot only; the other slot's section is missing.
	const partialMap = parseRaucSlotBootnames("[slot.rootfs.0]\nbootname=A\n");
	const classify = (target: string) =>
		classifyReceiptTarget({
			receipt: { target_slot: target },
			healthyState: bootedA,
			bootId: "boot-new",
			bootnames: partialMap,
		});

	test("an unmapped rootfs slot or bare name could be the other slot: unknown", () => {
		expect(classify("rootfs.1")).toBe("unknown");
		expect(classify("B")).toBe("unknown");
	});

	test("a name that resolves to a known non-other slot stays not-other", () => {
		expect(classify("rootfs.0")).toBe("not-other");
		expect(classify("A")).toBe("not-other");
		expect(classify("certs.0")).toBe("not-other");
	});

	test("the gate skips, and never dispatches, on that unknown receipt", () => {
		const evidence: SlotSyncEvidence = {
			...mirroredIntoB,
			receiptTarget: classify("rootfs.1"),
		};
		expect(
			slotSyncGate({
				...evidence,
				capabilities: {
					mode: "capable",
					features: ["apt-all-packages", "slot-sync"],
				},
				phase: "idle",
			}),
		).toEqual({ allowed: false, reason: "slot-identity-unknown" });
	});

	test("a real mirror's own receipt is judged by RAUC and settles synced", async () => {
		const h = harness({
			phase: "syncing",
			evidence: { ...mirroredIntoB, receiptTarget: classify("rootfs.1") },
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("synced");
		expect(h.cleanup).toEqual(["apt", "downloads", "quarantine", "slots"]);
	});
});

describe("slot-identity-unknown is logged once per change, on both paths", () => {
	const unknownIdentity: SlotSyncEvidence = {
		...mirroredIntoB,
		receiptTarget: "unknown",
	};
	const identityWarnings = (spy: {
		readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> };
	}) =>
		spy.mock.calls.filter((call) =>
			String(call[0]).includes("slot identity unknown"),
		).length;

	test("sync-eligible then idle ticks warn once, and again only after it changed", async () => {
		const warn = spyOn(logger, "warn");
		try {
			const h = harness({ phase: "sync-eligible", evidence: unknownIdentity });
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("idle");
			for (let tick = 0; tick < 4; tick++) await runOrchestratorTick();
			expect(identityWarnings(warn)).toBe(1);
			expect(h.dispatched).toEqual([]);
			// The situation changes (a previous boot's record), then recurs.
			h.setEvidence({ ...unknownIdentity, bootId: "boot-next" });
			await runOrchestratorTick();
			h.setEvidence(unknownIdentity);
			await runOrchestratorTick();
			await runOrchestratorTick();
			expect(identityWarnings(warn)).toBe(2);
			expect(h.dispatched).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	test("the idle path alone warns too", async () => {
		const warn = spyOn(logger, "warn");
		try {
			harness({ phase: "idle", evidence: unknownIdentity });
			await runOrchestratorTick();
			await runOrchestratorTick();
			expect(identityWarnings(warn)).toBe(1);
		} finally {
			warn.mockRestore();
		}
	});
});
