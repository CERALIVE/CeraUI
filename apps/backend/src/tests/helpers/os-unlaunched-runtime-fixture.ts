import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateOrchestratorPersistedStateSchema } from "@ceraui/rpc/schemas";
import { OsAttemptIntentStore } from "../../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import { osStageCandidateKey } from "../../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	consumeOsUnlaunchedWitness,
	readOsUnlaunchedWitness,
	writeOsUnlaunchedWitness,
} from "../../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import {
	fromPersisted,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../../modules/system/update-orchestrator/quarantine.ts";
import {
	defaultOrchestratorRuntimeDeps,
	type OrchestratorRuntimeDeps,
	resetOrchestratorRuntimeForTest,
} from "../../modules/system/update-orchestrator/runtime.ts";
import type { RootSlotStatus } from "../../modules/system/update-orchestrator/slot-status.ts";
import type { OrchestratorState } from "../../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";
import { input, manifest } from "./os-stage-unlaunched-fixture.ts";

export const KEY = osStageCandidateKey(manifest);
export const NOW = 1790901041750;
// Transcribed agent.json from the Orange Pi D8 unsafe receipt, 2026-10-02.
export const D8_STATE = fromPersisted(
	updateOrchestratorPersistedStateSchema.parse({
		schema: 1,
		phase: "failed",
		enteredAt: 1790901041749,
		progress: null,
		failureReason: "rauc_recovery_unproven",
		packageCheck: {
			lastAttemptAt: 1790900877919,
			lastSuccessAt: 1790900877919,
			consecutiveFailures: 0,
			lastFailureWasRateLimited: false,
			nextAttemptAt: 1790922297054,
		},
		osCheck: {
			lastAttemptAt: 1790900880010,
			lastSuccessAt: 1790900880010,
			consecutiveFailures: 0,
			lastFailureWasRateLimited: false,
			nextAttemptAt: 1790941516453,
		},
		cellularOverrideId: null,
		osStageRecovery: {
			candidateKey:
				"2026.10.52|13|drill|orange-pi-5-plus|ceralive-orangepi5-plus|https://images.ceralive.tv/releases/orange-pi-5-plus/2026.10.52/bundle.raucb|3acb98f25ca876a2b36ea215d62a4aff9997bb6cb5041d7ee8df3d0873b9aef0",
			activeAttemptId: null,
			failedRounds: 1,
			nextRetryAt: null,
			mode: "unsafe",
			reason: "rauc_recovery_unproven",
		},
	}),
);

export function identifiedState(): OrchestratorState {
	return {
		...D8_STATE,
		osStageRecovery: {
			candidateKey: KEY,
			activeAttemptId: null,
			attemptId: input.attemptId,
			failedRounds: 1,
			nextRetryAt: null,
			mode: "unsafe",
			reason: "rauc_recovery_unproven",
		},
	};
}

export const GOOD_SLOTS: readonly RootSlotStatus[] = [
	{
		name: "rootfs.1",
		bootname: "B",
		state: "booted",
		bootStatus: "good",
		version: null,
		lastSyncedAt: null,
	},
	{
		name: "rootfs.0",
		bootname: "A",
		state: "inactive",
		bootStatus: "good",
		version: null,
		lastSyncedAt: null,
	},
];

export function runtimeFixture(
	overrides: Partial<OrchestratorRuntimeDeps> = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "os-unlaunched-runtime-"));
	const file = join(dir, "agent.json");
	const witnessDeps = {
		path: join(dir, "witness.json"),
		uid: process.getuid?.() ?? 0,
	};
	const intentStore = new OsAttemptIntentStore({
		path: join(dir, "os-attempt-intent.json"),
		uid: witnessDeps.uid,
	});
	const runtimeDeps: OrchestratorRuntimeDeps = {
		...defaultOrchestratorRuntimeDeps,
		acquireOsStageControl: acquireTestOsStageControl,
		startupRetryClock: { wait: async () => undefined },
		osAttemptIntentStore: intentStore,
		readOsStageJob: async () => null,
		osStageStartupDeps: {
			run: async () => ({
				exitCode: 0,
				stdout: "LoadState=not-found\n",
				stderr: "",
			}),
		},
		now: () => NOW,
		loadSettings: async () => ({
			packagesAuto: true,
			systemAuto: true,
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			channel: "stable",
			allowPackagesOverCellular: true,
			allowSystemOverCellular: true,
		}),
		loadCapabilities: async () => ({
			mode: "capable",
			features: ["apt-all-packages", "rauc-verity-streaming"],
		}),
		isIdle: async () => true,
		isStreamLive: () => false,
		isUpdateAdmissionReady: async () => true,
		isOsStageReady: async () => true,
		onlyMeteredCandidateExists: async () => false,
		runPackageCheck: async () => null,
		getPackageInstallWireState: () => ({ kind: "idle" }),
		recoverSoftwareUpdateIfRunning: async () => false,
		checkOsManifest: async () => ({
			available: true,
			rateLimited: false,
			failed: false,
			reason: "",
			manifest,
		}),
		newOsAttemptId: () => "00000000-0000-4000-8000-000000000003",
		stageOs: async () => undefined,
		inspectOsOperation: async () => "idle",
		proveOsWriterQuiescent: async () => true,
		readBootId: async () => input.bootId,
		readRootSlots: async () => GOOD_SLOTS,
		readOsReceipt: async () => undefined,
		readActivationArmed: async () => false,
		readHealthyState: async () => ({
			boot_id: input.bootId,
			slot: "B",
			build_id: "b",
			dpkg_status_sha256: "d".repeat(64),
			recorded_at: "2026-10-02T00:00:00Z",
		}),
		readOsUnlaunchedWitness: () => readOsUnlaunchedWitness(witnessDeps),
		consumeOsUnlaunchedWitness: (attemptId) =>
			consumeOsUnlaunchedWitness(attemptId, witnessDeps),
		persist: (state) => saveOrchestratorState(state, file),
		quarantine: new UpdateQuarantine(
			join(dir, "quarantine.json"),
			async () => undefined,
		),
		publishWireState: () => undefined,
		...overrides,
	};
	setOrchestratorStateFilePathForTest(file);
	return {
		file,
		intentStore,
		witnessDeps,
		deps: runtimeDeps,
		writeWitness: () => writeOsUnlaunchedWitness(input, witnessDeps),
		cleanup: () => {
			resetOrchestratorRuntimeForTest();
			setOrchestratorStateFilePathForTest(null);
			rmSync(dir, { recursive: true });
		},
	};
}
