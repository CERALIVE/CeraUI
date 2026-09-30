import { afterEach, describe, expect, test } from "bun:test";
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
	parseRaucSlotBootnames,
	receiptTargetsOtherSlot,
} from "../modules/system/update-orchestrator/slot-sync-state.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";

// OPI task-45d D1: v1 and v2 share one package set and build id, so after the
// activation of v2 into B the A->B receipt from v1 matched the new dpkg state
// and the mirror of B into A was skipped. The receipt must name the slot that
// is NOT booted now.

const dpkgSha =
	"53428b0436fb2f0cccd4a4214df0172bfc5682aa2218d8a655c8e7a3ad0a6031";
const buildId = "36d8131819aa4eb0b46666b76c702db0afada938";
const bootedB: HealthySlotState = {
	boot_id: "045961b0-a77f-48c1-b649-c7b5d180f1a7",
	slot: "B",
	build_id: buildId,
	dpkg_status_sha256: dpkgSha,
	recorded_at: "2026-09-30T11:33:49Z",
};
const receiptBefore = {
	state_sha256: dpkgSha,
	build_id: buildId,
	image_version: "36d8131",
	target_slot: "rootfs.1",
	completed_at: "2026-09-30T06:15:26Z",
};
// The device's generated /etc/rauc/system.conf (install-boot.sh heredoc).
const systemConf = `[system]
compatible=ceralive-rk3588
bootloader=custom

[slot.rootfs.0]
device=/dev/disk/by-partlabel/rootfs_a
type=ext4
bootname=A

[slot.rootfs.1]
device=/dev/disk/by-partlabel/rootfs_b
type=ext4
bootname=B

[slot.certs.0]
device=/data/ceralive/certs/.rauc-certs-slot
type=raw
`;
const bootnames = parseRaucSlotBootnames(systemConf);

const evidenceFor = (
	receipt: typeof receiptBefore | null,
	healthyState: HealthySlotState = bootedB,
): SlotSyncEvidence => ({
	healthyState,
	bootId: healthyState.boot_id,
	statusSha256: dpkgSha,
	buildId,
	receiptStateSha256: receipt?.state_sha256 ?? null,
	receiptTargetsOtherSlot: receiptTargetsOtherSlot({
		receipt,
		healthyState,
		bootnames,
	}),
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

describe("OPI-D1: already-synced means the CURRENT other slot was mirrored", () => {
	test("reads each rootfs slot's bootname from system.conf", () => {
		expect([...bootnames]).toEqual([
			["rootfs.0", "A"],
			["rootfs.1", "B"],
		]);
	});

	test("the hardware case: a receipt that targets the now-booted slot does not suppress the mirror", () => {
		const evidence = evidenceFor(receiptBefore);
		expect(evidence.receiptTargetsOtherSlot).toBe(false);
		expect(gate(evidence)).toEqual({ allowed: true });
	});

	test("a receipt for the current other slot with this dpkg state is already-synced", () => {
		const evidence = evidenceFor({ ...receiptBefore, target_slot: "rootfs.0" });
		expect(evidence.receiptTargetsOtherSlot).toBe(true);
		expect(gate(evidence)).toEqual({
			allowed: false,
			reason: "already-synced",
		});
	});

	test("the target and the booted slot may each be a slot name or a bootname", () => {
		const named: HealthySlotState = { ...bootedB, slot: "rootfs.1" };
		for (const [target, healthy, other] of [
			["A", bootedB, true],
			["B", bootedB, false],
			["rootfs.0", named, true],
			["rootfs.1", named, false],
			["A", named, true],
			["B", named, false],
		] as const)
			expect(
				receiptTargetsOtherSlot({
					receipt: { ...receiptBefore, target_slot: target },
					healthyState: healthy,
					bootnames,
				}),
			).toBe(other);
	});

	test("without a slot map only a receipt written during this boot counts, so an unneeded mirror runs at most once", () => {
		const unmapped = new Map<string, string>();
		const decide = (completedAt: string, target = "rootfs.0") =>
			receiptTargetsOtherSlot({
				receipt: {
					...receiptBefore,
					target_slot: target,
					completed_at: completedAt,
				},
				healthyState: bootedB,
				bootnames: unmapped,
			});
		// Before this boot's healthy record: it may name either slot, so mirror.
		expect(decide("2026-09-30T06:15:26Z")).toBe(false);
		// The unit refuses to run before this boot's healthy record exists, so a
		// receipt written after it is this boot's mirror of the booted slot.
		expect(decide("2026-09-30T11:40:00Z")).toBe(true);
		expect(decide("2026-09-30T11:33:49Z")).toBe(true);
		// A target spelled exactly like the booted slot is never the other one.
		expect(decide("2026-09-30T11:40:00Z", "B")).toBe(false);
		expect(decide("not a time")).toBe(false);
		expect(parseRaucSlotBootnames("")).toEqual(new Map());
		expect(
			receiptTargetsOtherSlot({
				receipt: null,
				healthyState: bootedB,
				bootnames,
			}),
		).toBe(false);
		expect(
			receiptTargetsOtherSlot({
				receipt: receiptBefore,
				healthyState: null,
				bootnames,
			}),
		).toBe(false);
	});
});

describe("OPI-D1 through the runtime", () => {
	afterEach(() => resetOrchestratorRuntimeForTest());

	test("after an activation the mirror runs once, settles, and the next ticks see already-synced", async () => {
		let receipt = receiptBefore;
		let starts = 0;
		setOrchestratorRuntimeDepsForTest({
			...defaultOrchestratorRuntimeDeps,
			now: () => 10_000,
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
			readSlotSyncEvidence: async () => evidenceFor(receipt),
			startSlotSync: async () => {
				starts++;
			},
			// The unit mirrors B into A and publishes its receipt for rootfs.0.
			inspectSlotSync: async () => {
				receipt = {
					...receiptBefore,
					target_slot: "rootfs.0",
					completed_at: "2026-09-30T11:40:00Z",
				};
				return { kind: "inactive-clean" };
			},
			cleanSlotSyncArchives: async () => true,
			removeRaucDownloads: async () => {},
			dropSupersededQuarantine: async () => {},
			refreshSlots: async () => [],
			persist: () => {},
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "sync-eligible",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("syncing");
		expect(starts).toBe(1);
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("synced");
		for (let tick = 0; tick < 3; tick++) await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("idle");
		expect(starts).toBe(1);
	});

	test("a stale receipt for the booted slot cannot settle a run whose unit still reads inactive-clean", async () => {
		setOrchestratorRuntimeDepsForTest({
			...defaultOrchestratorRuntimeDeps,
			now: () => SLOT_SYNC_QUEUED_START_GRACE_MS + 11_000,
			readSlotSyncEvidence: async () => evidenceFor(receiptBefore),
			inspectSlotSync: async () => ({ kind: "inactive-clean" }),
			persist: () => {},
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "syncing",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("slot-sync-unit-absent");
	});
});
