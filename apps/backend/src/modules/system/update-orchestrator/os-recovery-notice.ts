import {
	announceOsStageSettlement,
	notifyUpdate,
	type OsStageNoticeKind,
} from "./notifications.ts";
import { osStageCandidateVersion, osStageNoticeId } from "./os-stage-retry.ts";
import type { OrchestratorState } from "./types.ts";

const kinds: Readonly<
	Record<"automatic" | "operator" | "unsafe", OsStageNoticeKind>
> = {
	automatic: "os-stage-retry",
	operator: "os-stage-operator",
	unsafe: "os-stage-unresolved",
};

function recoveryNotice(state: OrchestratorState) {
	const record = state.osStageRecovery;
	if (
		!record ||
		record.activeAttemptId !== null ||
		record.failedRounds < 1 ||
		record.reason === null
	)
		return undefined;
	return {
		kind: kinds[record.mode],
		id: osStageNoticeId(record.candidateKey),
		version: osStageCandidateVersion(record.candidateKey),
	};
}

export function replaceOsStageRecoveryNotice(state: OrchestratorState): void {
	const notice = recoveryNotice(state);
	if (notice) announceOsStageSettlement(notice.kind, notice.id, notice.version);
}

export function hydrateOsStageRecoveryNotice(state: OrchestratorState): void {
	const notice = recoveryNotice(state);
	if (notice) notifyUpdate(notice);
}
