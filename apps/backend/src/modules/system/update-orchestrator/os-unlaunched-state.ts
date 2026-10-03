import { OS_STAGE_CONFIRMABLE_UNSAFE_REASONS } from "@ceraui/rpc/schemas";
import type { readOsUnlaunchedWitness } from "./os-stage-unlaunched-witness.ts";
import type { OrchestratorState } from "./types.ts";

export type OsUnlaunchedStageSettlement = {
	readonly type: "OS_UNLAUNCHED_STAGE_SETTLED";
	readonly now: number;
	readonly bootId: string;
	readonly witness: NonNullable<ReturnType<typeof readOsUnlaunchedWitness>>;
};

export function reduceOsUnlaunchedSettlement(
	state: OrchestratorState,
	event: OsUnlaunchedStageSettlement,
): OrchestratorState {
	const record = state.osStageRecovery;
	if (
		!record?.attemptId ||
		record.attemptId !== event.witness.attemptId ||
		record.candidateKey !== event.witness.candidateKey ||
		event.bootId !== event.witness.bootId ||
		event.witness.disposition !== "unlaunched-unchanged"
	)
		return state;
	let failedRounds: number;
	switch (state.phase) {
		case "os-staging":
			if (record.activeAttemptId !== record.attemptId) return state;
			failedRounds = record.failedRounds + 1;
			break;
		case "failed":
			if (
				record.mode !== "unsafe" ||
				record.activeAttemptId !== null ||
				record.failedRounds < 1 ||
				state.failureReason !== record.reason ||
				!OS_STAGE_CONFIRMABLE_UNSAFE_REASONS.some(
					(reason) => reason === record.reason,
				)
			)
				return state;
			failedRounds = record.failedRounds;
			break;
		default:
			return state;
	}
	return {
		...state,
		phase: "os-available",
		enteredAt: event.now,
		progress: null,
		failureReason: "rauc_install_failed",
		osStageRecovery: {
			...record,
			activeAttemptId: null,
			failedRounds,
			mode: "operator",
			reason: "rauc_install_failed",
			nextRetryAt: null,
		},
	};
}
