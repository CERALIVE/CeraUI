import { expect, test } from "bun:test";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	initialOrchestratorState,
	ORCHESTRATOR_PHASES,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";

test("offer invalidation accepts only its active OS attempt and rejects every other phase", () => {
	const staging: OrchestratorState = {
		...initialOrchestratorState(0),
		phase: "os-staging",
		osStageRecovery: {
			candidateKey: "candidate",
			activeAttemptId: "a2",
			failedRounds: 1,
			nextRetryAt: null,
			mode: "automatic",
			reason: "os_transport_failed",
		},
	};
	const event = {
		type: "OS_STAGE_OFFER_INVALIDATED",
		now: 1,
		attemptId: "a2",
	} as const;
	expect(reduceOrchestrator(staging, event).phase).toBe("idle");
	expect(reduceOrchestrator(staging, { ...event, attemptId: "a1" })).toBe(
		staging,
	);
	for (const phase of ORCHESTRATOR_PHASES) {
		if (phase === "os-staging") continue;
		const state = { ...staging, phase };
		expect(reduceOrchestrator(state, event)).toBe(state);
	}
});

test("recovery confirmation and legacy migration reject every non-failed phase", () => {
	for (const phase of ORCHESTRATOR_PHASES) {
		if (phase === "failed") continue;
		const unsafe: OrchestratorState = {
			...initialOrchestratorState(0),
			phase,
			failureReason: "rauc_recovery_unproven",
			osStageRecovery: {
				candidateKey: "candidate",
				activeAttemptId: null,
				failedRounds: 1,
				nextRetryAt: null,
				mode: "unsafe",
				reason: "rauc_recovery_unproven",
			},
		};
		expect(
			reduceOrchestrator(unsafe, {
				type: "OS_STAGE_RECOVERY_CONFIRMED",
				now: 1,
				candidateKey: "candidate",
			}),
		).toBe(unsafe);
		const legacy: OrchestratorState = {
			...initialOrchestratorState(0),
			phase,
			failureReason: "rauc_install_failed",
		};
		expect(
			reduceOrchestrator(legacy, {
				type: "OS_STAGE_LEGACY_FAILURE_MIGRATED",
				now: 1,
				retryAt: 2,
			}),
		).toBe(legacy);
	}
});
