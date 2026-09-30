import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifySlotSyncProbe,
	type SlotSyncProbeState,
} from "../modules/system/update-orchestrator/lock.ts";
import {
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { SlotSyncEvidence } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";

// Interleavings around `pollSlotSync`'s awaits: a process death between two
// steps, or a read that still returns the previous run's state.

const statusSha256 = "a".repeat(64);
const matching: SlotSyncEvidence = {
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
};

const show = (props: Record<string, string>) => ({
	exitCode: 0,
	stdout: Object.entries(props)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n"),
});
const unitFailed = show({
	LoadState: "loaded",
	ActiveState: "failed",
	SubState: "failed",
	ExecMainCode: "1",
	ExecMainStatus: "1",
});
const inactiveClean = show({
	LoadState: "loaded",
	ActiveState: "inactive",
	SubState: "dead",
	ExecMainCode: "0",
	ExecMainStatus: "0",
});
const succeededExit0 = show({
	LoadState: "loaded",
	ActiveState: "inactive",
	SubState: "dead",
	ExecMainCode: "1",
	ExecMainStatus: "0",
});
const stillRunning = show({
	LoadState: "loaded",
	ActiveState: "activating",
	SubState: "start",
	ExecMainCode: "0",
	ExecMainStatus: "0",
});

let root: string | undefined;
afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

function deps(overrides: Partial<typeof defaultOrchestratorRuntimeDeps>) {
	const cleanup: string[] = [];
	const value = {
		...defaultOrchestratorRuntimeDeps,
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
		startSlotSync: async () => {},
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
		persist: () => {},
		...overrides,
	};
	return { value, cleanup };
}

function syncing(): void {
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "syncing",
	});
}

describe("B1: the failure verdict is durable before the systemd record is cleared", () => {
	test("a backend that dies inside reset-failed restarts failed, never synced from the surviving receipt", async () => {
		root = await mkdtemp(join(tmpdir(), "ceraui-slot-sync-b1-"));
		const file = join(root, "agent.json");
		setOrchestratorStateFilePathForTest(file);
		syncing();
		saveOrchestratorState(getOrchestratorState());
		let persistedAtReset: string | undefined;
		const first = deps({
			persist: saveOrchestratorState,
			inspectSlotSync: async () => classifySlotSyncProbe(unitFailed),
			resetSlotSyncFailure: async () => {
				// The process dies here: whatever is on disk is all that survives.
				persistedAtReset = readFileSync(file, "utf8");
				throw new Error("killed inside reset-failed");
			},
		});
		setOrchestratorRuntimeDepsForTest(first.value);
		await runOrchestratorTick();
		expect(persistedAtReset).toBeDefined();
		expect(JSON.parse(persistedAtReset ?? "{}").phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe(
			"slot-sync failed (exit 1)",
		);

		// Restart from exactly the crash-time bytes. The cleared record now
		// reads as a clean inactive unit and the receipt was published before
		// the failed mark-good; neither may turn the failure into success.
		writeFileSync(file, persistedAtReset ?? "");
		resetOrchestratorRuntimeForTest();
		setOrchestratorStateFilePathForTest(file);
		const phases: string[] = [];
		const second = deps({
			persist: (next) => {
				phases.push(next.phase);
				saveOrchestratorState(next);
			},
			inspectSlotSync: async () => classifySlotSyncProbe(inactiveClean),
		});
		await startUpdateOrchestrator(second.value);
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(phases).not.toContain("synced");
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe(
			"slot-sync failed (exit 1)",
		);
		expect(second.cleanup).toEqual([]);
	});

	test("a rejecting reset-failed cannot change the verdict", async () => {
		for (const [text, reason] of [
			[unitFailed, "slot-sync failed (exit 1)"],
			[
				show({
					LoadState: "loaded",
					ActiveState: "failed",
					SubState: "failed",
					ExecMainCode: "1",
					ExecMainStatus: "75",
				}),
				"slot-sync refused (exit 75)",
			],
		] as const) {
			resetOrchestratorRuntimeForTest();
			let resets = 0;
			setOrchestratorRuntimeDepsForTest(
				deps({
					inspectSlotSync: async () => classifySlotSyncProbe(text),
					resetSlotSyncFailure: async () => {
						resets++;
						throw new Error("systemctl reset-failed timed out");
					},
				}).value,
			);
			syncing();
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("failed");
			expect(getOrchestratorState().failureReason).toBe(reason);
			expect(resets).toBe(1);
		}
	});
});
