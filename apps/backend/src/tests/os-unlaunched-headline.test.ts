import { afterEach, expect, test } from "bun:test";
import { osStageCandidateKey } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { input, manifest } from "./helpers/os-stage-unlaunched-fixture.ts";

afterEach(resetOrchestratorRuntimeForTest);
test("headline: a good inactive target is retryable only when exact unlaunched witness provenance matches", async () => {
	// Given the D8 failure shape with the new persisted attempt identity.
	const key = osStageCandidateKey(manifest);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "failed",
		failureReason: "rauc_recovery_unproven",
		packageCheck: {
			...initialOrchestratorState(0).packageCheck,
			nextAttemptAt: 100000,
		},
		osStageRecovery: {
			candidateKey: key,
			attemptId: input.attemptId,
			activeAttemptId: null,
			failedRounds: 1,
			nextRetryAt: null,
			mode: "unsafe",
			reason: "rauc_recovery_unproven",
		},
	});
	let persisted = structuredClone(getOrchestratorState());
	setOrchestratorRuntimeDepsForTest({
		acquireOsStageControl: acquireTestOsStageControl,
		readPersistedState: async () => persisted,
		now: () => 10,
		isUpdateAdmissionReady: async () => true,
		readOsUnlaunchedWitness: () => ({
			attemptId: input.attemptId,
			candidateKey: key,
			bootId: input.bootId,
			baselineInstance: input.baselineInstance,
			disposition: "unlaunched-unchanged",
		}),
		consumeOsUnlaunchedWitness: () => undefined,
		inspectOsOperation: async () => "idle",
		proveOsWriterQuiescent: async () => true,
		readBootId: async () => input.bootId,
		readHealthyState: async () => ({
			boot_id: input.bootId,
			slot: "B",
			build_id: "b",
			dpkg_status_sha256: "d".repeat(64),
			recorded_at: "2026-10-02T00:00:00Z",
		}),
		readRootSlots: async () => [
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
		],
		readOsReceipt: async () => undefined,
		readActivationArmed: async () => false,
		loadCapabilities: async () => ({ mode: "legacy", features: [] }),
		loadSettings: async () => ({
			packagesAuto: false,
			systemAuto: false,
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			channel: "stable",
			allowPackagesOverCellular: false,
			allowSystemOverCellular: false,
		}),
		persist: (state) => {
			persisted = structuredClone(state);
		},
		publishWireState: () => undefined,
	});
	// When the automatic admission tick reconciles the exact witness.
	await runOrchestratorTick();
	// Then the state is retryable with the already-counted round unchanged.
	expect(getOrchestratorState()).toMatchObject({
		phase: "os-available",
		failureReason: "rauc_install_failed",
		osStageRecovery: { failedRounds: 1, mode: "operator" },
	});
});
