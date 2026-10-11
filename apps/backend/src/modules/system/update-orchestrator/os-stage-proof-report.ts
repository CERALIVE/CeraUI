import { logger } from "../../../helpers/logger.ts";
import { stageEvidence } from "./os-stage-process-evidence.ts";
import type { StageProofWait } from "./os-stage-proof-wait.ts";
import type { RaucStageSnapshot } from "./os-stage-recovery.ts";

export function reportStageProofDecision(input: {
	readonly snapshot: RaucStageSnapshot | null;
	readonly wait: Pick<StageProofWait, "deadline" | "now" | "previousInstance">;
	readonly reason: string;
	readonly disposition: "defer" | "final" | "proven";
	readonly observation?: string;
}): void {
	try {
		const detail = stageEvidence(input.snapshot);
		logger.warn("update-orchestrator: OS stage proof decision", {
			...detail,
			members: detail?.members.slice(0, 16),
			extraMembers: detail?.members
				.filter((member) => member.identity !== input.snapshot?.instance)
				.slice(0, 16),
			resources: input.snapshot?.resources
				.slice(0, 16)
				.map((id) => id.slice(0, 160)),
			currentInstance: input.snapshot?.instance ?? null,
			previousInstance: input.wait.previousInstance ?? null,
			deadlineRemainingMs: Math.max(0, input.wait.deadline - input.wait.now()),
			reason: input.reason,
			disposition: input.disposition,
			observation: input.observation,
		});
	} catch {
		return;
	}
}
