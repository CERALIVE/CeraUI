import { afterEach, describe, expect, test } from "bun:test";
import {
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
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

// N3 (round 13): wall-clock ordering is not slot identity. The receipt target
// is compared with the booted slot only through the static system.conf
// bootname map, and an identity that cannot be resolved neither suppresses
// the mirror (already-synced) nor dispatches it: the gate skips the tick.

const dpkgSha = "5".repeat(64);
const buildId = "36d8131819aa4eb0b46666b76c702db0afada938";
const realMap = parseRaucSlotBootnames(
	"[slot.rootfs.0]\nbootname=A\n\n[slot.rootfs.1]\nbootname=B\n\n[slot.certs.0]\ntype=raw\n",
);
const healthy = (slot: string, bootId: string): HealthySlotState => ({
	boot_id: bootId,
	slot,
	build_id: buildId,
	dpkg_status_sha256: dpkgSha,
	recorded_at: "2026-09-30T11:33:49Z",
});
const receipt = (
	target_slot: string,
	completed_at = "2026-09-30T06:15:26Z",
) => ({
	state_sha256: dpkgSha,
	target_slot,
	completed_at,
});

const evidenceFor = (input: {
	readonly receipt: ReturnType<typeof receipt> | null;
	readonly healthyState: HealthySlotState;
	readonly bootnames: ReadonlyMap<string, string>;
}): SlotSyncEvidence => ({
	healthyState: input.healthyState,
	bootId: input.healthyState.boot_id,
	statusSha256: dpkgSha,
	buildId,
	receiptStateSha256: input.receipt?.state_sha256 ?? null,
	receiptTarget: classifyReceiptTarget({
		receipt: input.receipt,
		healthyState: input.healthyState,
		bootId: input.healthyState.boot_id,
		bootnames: input.bootnames,
	}),
	receiptTargetSlot: input.receipt?.target_slot ?? null,
});
const gate = (evidence: SlotSyncEvidence) =>
	slotSyncGate({
		...evidence,
		capabilities: {
			mode: "capable",
			features: ["apt-all-packages", "slot-sync"],
		},
		phase: "idle",
	});

describe("N3: no wall-clock identity; the receipt target is other, not-other or unknown", () => {
	test("an unresolvable map with equal or later timestamps is unknown and skips instead of dispatching", () => {
		const bootedB = healthy("B", "boot-2");
		for (const completedAt of [
			bootedB.recorded_at,
			"2026-09-30T11:40:00Z",
			"2099-01-01T00:00:00Z",
		]) {
			const evidence = evidenceFor({
				receipt: receipt("rootfs.1", completedAt),
				healthyState: bootedB,
				bootnames: new Map(),
			});
			expect(evidence.receiptTarget).toBe("unknown");
			expect(gate(evidence)).toEqual({
				allowed: false,
				reason: "slot-identity-unknown",
			});
		}
	});

	test("a target that is not the other rootfs slot never counts as already-synced", () => {
		for (const target of ["nonexistent.7", "certs.0", "C"]) {
			const evidence = evidenceFor({
				receipt: receipt(target, "2099-01-01T00:00:00Z"),
				healthyState: healthy("A", "boot-1"),
				bootnames: realMap,
			});
			expect(evidence.receiptTarget).toBe("not-other");
			expect(gate(evidence)).toEqual({ allowed: true });
		}
	});

	test("a backwards clock step no longer matters: only the slot map decides", () => {
		const bootedA = healthy("A", "boot-1");
		// Completed "before" this boot's record (clock stepped back), still the
		// other slot; completed "after" it, still the booted slot.
		expect(
			classifyReceiptTarget({
				receipt: receipt("rootfs.1", "2001-01-01T00:00:00Z"),
				healthyState: bootedA,
				bootId: "boot-1",
				bootnames: realMap,
			}),
		).toBe("other");
		expect(
			classifyReceiptTarget({
				receipt: receipt("rootfs.0", "2099-01-01T00:00:00Z"),
				healthyState: bootedA,
				bootId: "boot-1",
				bootnames: realMap,
			}),
		).toBe("not-other");
	});

	test("the OPI values: receipt rootfs.1, booted B, same dpkg SHA lets the mirror run", () => {
		const evidence = evidenceFor({
			receipt: receipt("rootfs.1"),
			healthyState: healthy("B", "045961b0-a77f-48c1-b649-c7b5d180f1a7"),
			bootnames: realMap,
		});
		expect(evidence.receiptTarget).toBe("not-other");
		expect(gate(evidence)).toEqual({ allowed: true });
	});

	test("a missing or previous-boot healthy record is unknown", () => {
		expect(
			classifyReceiptTarget({
				receipt: receipt("rootfs.1"),
				healthyState: healthy("A", "boot-previous"),
				bootId: "boot-now",
				bootnames: realMap,
			}),
		).toBe("unknown");
		expect(
			classifyReceiptTarget({
				receipt: receipt("rootfs.1"),
				healthyState: null,
				bootId: "boot-now",
				bootnames: realMap,
			}),
		).toBe("unknown");
	});

	test("across consecutive boots with the real map the mirror runs exactly when the other slot is stale", () => {
		type Step = { booted: string; bootId: string; mirrorExpected: boolean };
		const steps: Step[] = [
			{ booted: "A", bootId: "boot-1", mirrorExpected: true },
			{ booted: "A", bootId: "boot-1", mirrorExpected: false },
			{ booted: "A", bootId: "boot-2", mirrorExpected: false },
			{ booted: "B", bootId: "boot-3", mirrorExpected: true },
			{ booted: "B", bootId: "boot-3", mirrorExpected: false },
			{ booted: "B", bootId: "boot-4", mirrorExpected: false },
		];
		let written: ReturnType<typeof receipt> | null = null;
		const mirrors: string[] = [];
		for (const step of steps) {
			const verdict = gate(
				evidenceFor({
					receipt: written,
					healthyState: healthy(step.booted, step.bootId),
					bootnames: realMap,
				}),
			);
			expect({ step, allowed: verdict.allowed }).toEqual({
				step,
				allowed: step.mirrorExpected,
			});
			if (verdict.allowed) {
				// The unit mirrors the booted slot into the other one.
				written = receipt(step.booted === "A" ? "rootfs.1" : "rootfs.0");
				mirrors.push(step.bootId);
			}
		}
		expect(mirrors).toEqual(["boot-1", "boot-3"]);
	});
});

describe("N3 through the runtime: an unknown identity skips the tick, never dispatches", () => {
	afterEach(() => resetOrchestratorRuntimeForTest());

	test("sync-eligible with an unknown target is skipped back to idle and no unit is started", async () => {
		let starts = 0;
		const evidence = evidenceFor({
			receipt: receipt("rootfs.1", "2099-01-01T00:00:00Z"),
			healthyState: healthy("B", "boot-2"),
			bootnames: new Map(),
		});
		setOrchestratorRuntimeDepsForTest({
			...defaultOrchestratorRuntimeDeps,
			now: () => 5_000,
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
			onlyMeteredCandidateExists: async () => false,
			runPackageCheck: async () => null,
			readSlotSyncEvidence: async () => evidence,
			startSlotSync: async () => {
				starts++;
			},
			persist: () => {},
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "sync-eligible",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("idle");
		expect(getOrchestratorState().failureReason).toBeNull();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("idle");
		expect(starts).toBe(0);
	});
});
