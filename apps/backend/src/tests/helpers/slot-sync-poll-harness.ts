import { classifySlotSyncProbe } from "../../modules/system/update-orchestrator/lock.ts";
import {
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../../modules/system/update-orchestrator/runtime.ts";
import type { SlotSyncEvidence } from "../../modules/system/update-orchestrator/slot-sync-gate.ts";
import { initialOrchestratorState } from "../../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";
import { raucSlots } from "./slot-sync-rauc.ts";

export const statusSha256 = "a".repeat(64);

export const matching: SlotSyncEvidence = {
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
	receiptStateSha256: statusSha256,
	receiptTarget: "other",
	receiptTargetSlot: "rootfs.1",
};

export const show = (props: Record<string, string>) => ({
	exitCode: 0,
	stdout: Object.entries(props)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n"),
});

export const unitFailed = show({
	LoadState: "loaded",
	ActiveState: "failed",
	SubState: "failed",
	ExecMainCode: "1",
	ExecMainStatus: "1",
});

export const inactiveClean = show({
	LoadState: "loaded",
	ActiveState: "inactive",
	SubState: "dead",
	ExecMainCode: "0",
	ExecMainStatus: "0",
});

export const succeededExit0 = show({
	LoadState: "loaded",
	ActiveState: "inactive",
	SubState: "dead",
	ExecMainCode: "1",
	ExecMainStatus: "0",
});

export const stillRunning = show({
	LoadState: "loaded",
	ActiveState: "activating",
	SubState: "start",
	ExecMainCode: "0",
	ExecMainStatus: "0",
});

export function deps(
	overrides: Partial<typeof defaultOrchestratorRuntimeDeps>,
) {
	const cleanup: string[] = [];
	const value = {
		...defaultOrchestratorRuntimeDeps,
		acquireOsStageControl: acquireTestOsStageControl,
		startupRetryClock: { wait: () => Promise.resolve() },
		now: () => 9_000,
		loadCapabilities: async () => ({
			mode: "capable" as const,
			features: ["apt-all-packages", "slot-sync"] as (
				| "apt-all-packages"
				| "slot-sync"
			)[],
		}),
		isStreamLive: () => false,
		readSlotSyncEvidence: async () => matching,
		readRootSlots: async () => raucSlots("A"),
		startSlotSync: async () => {
			// Poll fixtures must not dispatch a host mirror.
		},
		resetSlotSyncFailure: async () => {
			// Reset-failure cases override this port explicitly.
		},
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
			// Crash cases override storage with their own temporary state file.
		},
		...overrides,
	};
	return { value, cleanup };
}

export function syncing(): void {
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "syncing",
	});
}

export const lines = (
	...entries: ReadonlyArray<readonly [string, string]>
) => ({
	exitCode: 0,
	stdout: entries.map(([key, value]) => `${key}=${value}`).join("\n"),
});

export async function settleThroughRuntime(result: {
	exitCode: number;
	stdout: string;
}) {
	resetOrchestratorRuntimeForTest();
	const h = deps({
		inspectSlotSync: async () => classifySlotSyncProbe(result),
	});
	setOrchestratorRuntimeDepsForTest(h.value);
	syncing();
	await runOrchestratorTick();
	return { state: getOrchestratorState(), cleanup: h.cleanup };
}
