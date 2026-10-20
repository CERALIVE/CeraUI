import { expect } from "bun:test";
import { reduceOrchestrator } from "../../modules/system/update-orchestrator/reducer.ts";
import {
	initialOrchestratorState,
	type OrchestratorEvent,
	type OrchestratorPhase,
	type OrchestratorState,
} from "../../modules/system/update-orchestrator/types.ts";
import { input } from "./os-stage-unlaunched-fixture.ts";

type WitnessEvent = Extract<
	OrchestratorEvent,
	{ type: "OS_UNLAUNCHED_STAGE_SETTLED" }
>;

export function unlaunchedTotalitySample(now: number): WitnessEvent {
	return {
		type: "OS_UNLAUNCHED_STAGE_SETTLED",
		now,
		bootId: input.bootId,
		witness: {
			attemptId: input.attemptId,
			candidateKey: "k",
			bootId: input.bootId,
			baselineInstance: input.baselineInstance,
			disposition: "unlaunched-unchanged",
		},
	};
}

export function assertUnlaunchedTotalityOutcome(
	phase: OrchestratorPhase,
	event: WitnessEvent,
): void {
	const state: OrchestratorState = {
		...initialOrchestratorState(0),
		phase,
		failureReason: phase === "failed" ? "rauc_recovery_unproven" : null,
		osStageRecovery: {
			candidateKey: event.witness.candidateKey,
			attemptId: event.witness.attemptId,
			activeAttemptId: phase === "os-staging" ? event.witness.attemptId : null,
			failedRounds: phase === "failed" ? 1 : 0,
			mode: phase === "failed" ? "unsafe" : "automatic",
			reason: phase === "failed" ? "rauc_recovery_unproven" : null,
			nextRetryAt: null,
		},
	};
	const next = reduceOrchestrator(state, event);
	if (phase === "os-staging" || phase === "failed") {
		expect(next.phase).toBe("os-available");
		expect(next.failureReason).toBe("rauc_install_failed");
		expect(next.osStageRecovery).toMatchObject({
			activeAttemptId: null,
			failedRounds: 1,
			mode: "operator",
			reason: "rauc_install_failed",
			nextRetryAt: null,
		});
	} else {
		expect(next).toBe(state);
	}
}
