import { afterEach, expect, test } from "bun:test";
import type { SlotSyncProbeState } from "../modules/system/update-orchestrator/lock.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { RootSlotStatus } from "../modules/system/update-orchestrator/slot-status.ts";
import type { SlotSyncEvidence } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";

const failureAt = Date.parse("2026-10-19T15:00:00Z");
const failed = {
	...initialOrchestratorState(failureAt),
	phase: "failed" as const,
	failureReason: "slot-sync failed (exit 143)",
};
const evidence = {
	healthyState: {
		boot_id: "boot",
		slot: "rootfs.1",
		build_id: "build",
		dpkg_status_sha256: "a".repeat(64),
		recorded_at: "2026-10-19T14:00:00Z",
	},
	bootId: "boot",
	statusSha256: "a".repeat(64),
	buildId: "build",
	receiptStateSha256: "a".repeat(64),
	receiptTarget: "other" as const,
	receiptTargetSlot: "rootfs.0",
	receiptCompletedAt: "2026-10-19T15:13:38Z",
	receiptBuildId: "build",
	receiptImageVersion: "2026.10.69",
};
const slots: readonly RootSlotStatus[] = [
	{
		name: "rootfs.1",
		bootname: "B",
		state: "booted",
		bootStatus: "good",
		version: "2026.10.69",
		lastSyncedAt: null,
	},
	{
		name: "rootfs.0",
		bootname: "A",
		state: "inactive",
		bootStatus: "good",
		version: "2026.10.68",
		lastSyncedAt: null,
	},
];
afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const n of getPersistentNotifications(true).show)
		if (n.name.startsWith("update:slot-sync-recovered:"))
			notificationRemove(n.name);
});

function arrange(
	input: {
		readonly receipt?: SlotSyncEvidence;
		readonly slots?: readonly RootSlotStatus[];
		readonly probe?: () => Promise<SlotSyncProbeState>;
	} = {},
) {
	const deps = fakeDeps({
		now: () => Date.parse("2026-10-19T15:20:00Z"),
		readSlotSyncEvidence: async () => input.receipt ?? evidence,
		inspectSlotSync: input.probe ?? (async () => ({ kind: "inactive-clean" })),
		readRootSlots: async () => input.slots ?? slots,
		readBootedVersion: async () => "2026.10.69",
	});
	deps.persist(failed);
	setOrchestratorRuntimeDepsForTest(deps);
	setOrchestratorStateForTest(failed);
}

test("a later matching successful mirror supersedes the recorded interruption", async () => {
	// Given the receipt and good slots from a later successful run.
	arrange();
	// When a tick probes them freshly.
	await runOrchestratorTick();
	// Then the workflow is recovered, not quarantined or resubmitted.
	expect(getOrchestratorState()).toMatchObject({
		phase: "idle",
		failureReason: null,
	});
	expect(
		getPersistentNotifications(true).show.some((n) =>
			n.name.startsWith("update:slot-sync-recovered:"),
		),
	).toBe(true);
});

for (const [name, patch] of [
	[
		"receipt older than failure",
		{ receiptCompletedAt: "2026-10-19T14:59:59Z" },
	],
	["receipt equal to failure", { receiptCompletedAt: "2026-10-19T15:00:00Z" }],
	["receipt for booted slot", { receiptTargetSlot: "rootfs.1" }],
	["different package state", { receiptStateSha256: "b".repeat(64) }],
	["different build", { receiptBuildId: "other" }],
	["different OS version", { receiptImageVersion: "2026.10.68" }],
	["invalid completion time", { receiptCompletedAt: "invalid" }],
	["future completion time", { receiptCompletedAt: "2027-01-01T00:00:00Z" }],
	["missing receipt", { receiptCompletedAt: null }],
	["stale health boot", { bootId: "another-boot" }],
	["unresolved slot identity", { receiptTarget: "unknown" }],
] as const) {
	test(`slot-sync recovery preserves failure with ${name}`, async () => {
		// Given exactly one missing receipt proof.
		arrange({ receipt: { ...evidence, ...patch } });
		// When a tick probes it.
		await runOrchestratorTick();
		// Then the old failure is retained.
		expect(getOrchestratorState()).toEqual(failed);
	});
}
for (const slot of [0, 1]) {
	test(`slot-sync recovery stays failed when slot ${slot} is bad`, async () => {
		// Given one bad slot, even though a receipt exists.
		arrange({
			slots: slots.map((s, i) =>
				i === slot ? { ...s, bootStatus: "bad" } : s,
			),
		});
		// When a tick reads RAUC.
		await runOrchestratorTick();
		// Then both-good proof is absent.
		expect(getOrchestratorState()).toEqual(failed);
	});
}
for (const kind of ["running", "absent", "failed", "refused"] as const) {
	test(`slot-sync recovery stays failed when unit is ${kind}`, async () => {
		// Given a unit with no positive clean completion shape.
		arrange({ probe: async () => ({ kind, exitCode: 143 }) });
		// When a tick reads it.
		await runOrchestratorTick();
		// Then a prior receipt cannot hide the current run.
		expect(getOrchestratorState()).toEqual(failed);
	});
}

test("a mirror starting during the evidence reads vetoes recovery", async () => {
	// Given a clean first probe and a running confirmation probe.
	let reads = 0;
	arrange({
		probe: async () => ({ kind: ++reads === 1 ? "inactive-clean" : "running" }),
	});
	// When the tick observes the changed unit.
	await runOrchestratorTick();
	// Then it keeps the original failure and does not reset the new run.
	expect(getOrchestratorState()).toEqual(failed);
});
