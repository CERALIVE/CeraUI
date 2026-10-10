import {
	defaultOrchestratorRuntimeDeps,
	SLOT_SYNC_QUEUED_START_GRACE_MS,
	setOrchestratorRuntimeDepsForTest,
} from "../../modules/system/update-orchestrator/runtime.ts";
import type { SlotSyncEvidence } from "../../modules/system/update-orchestrator/slot-sync-gate.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";
import { raucSlots } from "./slot-sync-rauc.ts";

export const statusSha256 = "a".repeat(64);

export const pastGrace = (ms: number) => SLOT_SYNC_QUEUED_START_GRACE_MS + ms;

export const evidence: SlotSyncEvidence = {
	healthyState: {
		boot_id: "boot-new",
		slot: "A",
		build_id: "build-new",
		dpkg_status_sha256: statusSha256,
		recorded_at: "2026-09-24T00:00:00Z",
	},
	bootId: "boot-new",
	statusSha256,
	buildId: "build-new",
	receiptStateSha256: "b".repeat(64),
	receiptTarget: "other",
	receiptTargetSlot: "rootfs.1",
};

export function fixture(
	overrides: Partial<typeof defaultOrchestratorRuntimeDeps> = {},
) {
	const commands: string[][] = [];
	const cleanup: string[] = [];
	let probe: "running" | "succeeded" | "absent" | "inactive-clean" = "running";
	let observed = evidence;
	const deps = {
		...defaultOrchestratorRuntimeDeps,
		acquireOsStageControl: acquireTestOsStageControl,
		startupRetryClock: { wait: () => Promise.resolve() },
		now: () => 2_000,
		loadCapabilities: async () => ({
			mode: "capable" as const,
			features: ["apt-all-packages", "slot-sync"] as (
				| "apt-all-packages"
				| "slot-sync"
			)[],
		}),
		loadSettings: async () => ({
			packagesAuto: false,
			systemAuto: false,
			schedule: { mode: "any-idle" as const, start: "03:00", end: "05:00" },
			channel: "stable" as const,
			allowPackagesOverCellular: true,
			allowSystemOverCellular: false,
		}),
		isStreamLive: () => true, // a local-only mirror is permitted mid-stream
		readSlotSyncEvidence: async () => observed,
		readRootSlots: async () => raucSlots("A"),
		startSlotSync: async () => {
			commands.push([
				"systemctl",
				"start",
				"--no-block",
				"ceralive-slot-sync.service",
			]);
		},
		inspectSlotSync: async () => ({ kind: probe }),
		inspectOsOperation: async () => "running" as const,
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
		persist: () => {
			// This fixture observes runtime state without a disk-backed writer.
		},
		...overrides,
	};
	setOrchestratorRuntimeDepsForTest(deps);
	return {
		deps,
		commands,
		cleanup,
		setEvidence: (value: SlotSyncEvidence) => {
			observed = value;
		},
		setProbe: (
			value: "running" | "succeeded" | "absent" | "inactive-clean",
		) => {
			probe = value;
		},
	};
}
