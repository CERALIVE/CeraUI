import { afterEach, expect, test } from "bun:test";
import { osStageCandidateKey } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	installUpdatesNow,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	cleanupRecovery,
	deferred,
	manifest,
	recoveryHarness,
} from "./helpers/os-recovery-harness.ts";

afterEach(cleanupRecovery);

test("C-R2 ignores an interrupted-stage probe when D8 admits a replacement during its await", async () => {
	// Given a resumed attempt and an operation read parked before returning idle.
	const probeStarted = deferred<void>();
	const operation = deferred<"idle">();
	const stageStarted = deferred<void>();
	const stageDone = deferred<void>();
	await recoveryHarness({
		// Positive proof makes the identity fence, not an absent device, decisive.
		proveOsWriterQuiescent: async () => true,
		inspectOsOperation: () => {
			probeStarted.resolve();
			return operation.promise;
		},
		stageOs: async () => {
			stageStarted.resolve();
			await stageDone.promise;
		},
	});
	setOrchestratorStateForTest({
		...getOrchestratorState(),
		phase: "os-staging",
		osStageRecovery: {
			candidateKey: osStageCandidateKey(manifest),
			activeAttemptId: "interrupted",
			failedRounds: 0,
			nextRetryAt: null,
			mode: "automatic",
			reason: null,
		},
	});
	// When D8 aborts the resumed attempt and a replacement starts before the old probe returns.
	const tick = runOrchestratorTick();
	await probeStarted.promise;
	await admitAndPrepareStreamStart();
	const install = installUpdatesNow();
	await stageStarted.promise;
	operation.resolve("idle");
	await tick;
	// Then the replacement still owns the stage and its completion is accepted.
	expect(getOrchestratorState().phase).toBe("os-staging");
	expect(getOrchestratorState().osStageRecovery?.activeAttemptId).toBe(
		"00000000-0000-4000-8000-000000000001",
	);
	stageDone.resolve();
	expect(await install).toEqual({ started: true });
	expect(getOrchestratorState().phase).toBe("os-staged");
});
