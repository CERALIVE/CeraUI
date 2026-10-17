import { afterEach, expect, test } from "bun:test";
import { OsAgentError } from "../modules/system/update-orchestrator/os-agent.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { osStageCandidateKey } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	getOsUpdateSummary,
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

test.each([
	[new OsStageError("rauc_install_failed"), "os-available", "operator"],
	[
		new OsStageError("rauc_recovery_unproven", {
			cause: new OsAgentError("expired"),
			diagnostics: { refusal: "resource-retirement-unproven" },
		}),
		"failed",
		"unsafe",
	],
	[
		new OsStageError("rauc_install_failed", {
			cause: new OsStageError("rauc_recovery_unproven", {
				cause: new OsAgentError("expired"),
			}),
		}),
		"os-available",
		"operator",
	],
	[
		new OsStageError("rauc_recovery_unproven", {
			cause: new AggregateError([new OsAgentError("expired")]),
			diagnostics: { refusal: "pin-teardown-unproven" },
		}),
		"failed",
		"unsafe",
	],
	[
		new OsStageError("rauc_install_failed", {
			cause: new OsAgentError("signer_issuer_invalid"),
		}),
		"os-available",
		"operator",
	],
] as const)(
	"CR integration preserves the offer for an unmarked %s control",
	async (error, phase, mode) => {
		// Given a refusal outside the positively pre-write invalidation contract.
		await recoveryHarness({
			stageOs: async () => {
				throw error;
			},
		});
		// When the actual runtime settles it.
		await runOrchestratorTick();
		// Then unsafe/resource/teardown and ordinary install errors retain policy.
		expect(getOrchestratorState()).toMatchObject({
			phase,
			osStageRecovery: { mode, failedRounds: 1 },
		});
		expect(getOsUpdateSummary().candidate?.version).toBe(manifest.version);
	},
);

test("CR reconciliation fences a replacement across B's writer-proof await", async () => {
	// Given an interrupted stage whose Operation is idle but writer proof is parked.
	const proofStarted = deferred<void>();
	const proof = deferred<boolean>();
	const stageStarted = deferred<void>();
	const stageDone = deferred<void>();
	await recoveryHarness({
		inspectOsOperation: async () => "idle",
		proveOsWriterQuiescent: () => {
			proofStarted.resolve();
			return proof.promise;
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
	// When D8 and a replacement complete admission while the proof is pending.
	const tick = runOrchestratorTick();
	await proofStarted.promise;
	await admitAndPrepareStreamStart();
	const install = installUpdatesNow();
	await stageStarted.promise;
	try {
		proof.resolve(true);
		await tick;
		// Then old positive proof cannot settle the new in-process producer.
		expect(getOrchestratorState()).toMatchObject({
			phase: "os-staging",
			osStageRecovery: {
				activeAttemptId: "00000000-0000-4000-8000-000000000001",
			},
		});
	} finally {
		stageDone.resolve();
		await install;
	}
	expect(getOrchestratorState().phase).toBe("os-staged");
});
