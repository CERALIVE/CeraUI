import type { OrchestratorState } from "./types.ts";

/** Compare values from the authoritative file, never process-local references. */
export function sameOsRecoveryIdentity(
	left: OrchestratorState,
	right: OrchestratorState | null,
): boolean {
	if (!right) return false;
	const a = left.osStageRecovery;
	const b = right.osStageRecovery;
	return (
		left.phase === right.phase &&
		left.failureReason === right.failureReason &&
		left.osStageDiscoveryRetryAt === right.osStageDiscoveryRetryAt &&
		a?.attemptId === b?.attemptId &&
		a?.candidateKey === b?.candidateKey &&
		a?.activeAttemptId === b?.activeAttemptId &&
		a?.failedRounds === b?.failedRounds &&
		a?.mode === b?.mode &&
		a?.reason === b?.reason &&
		a?.nextRetryAt === b?.nextRetryAt
	);
}
