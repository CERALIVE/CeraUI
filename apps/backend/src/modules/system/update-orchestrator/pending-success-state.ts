import { isDeepStrictEqual } from "node:util";
import { toPersisted } from "./persistence.ts";
import { reduceOrchestrator } from "./reducer.ts";
import type { OrchestratorState } from "./types.ts";

export function samePackageSuccessState(
	left: OrchestratorState | null,
	right: OrchestratorState,
): boolean {
	return (
		left !== null && isDeepStrictEqual(toPersisted(left), toPersisted(right))
	);
}

export function samePackageCompletion(
	baseline: OrchestratorState,
	current: OrchestratorState,
): boolean {
	// No package transaction ID exists in agent.json. Preserve all non-phase identity.
	return isDeepStrictEqual(
		{
			...toPersisted(baseline),
			phase: null,
			enteredAt: null,
			progress: null,
			failureReason: null,
		},
		{
			...toPersisted(current),
			phase: null,
			enteredAt: null,
			progress: null,
			failureReason: null,
		},
	);
}

export function packageSuccessState(
	before: OrchestratorState,
	now: number,
): OrchestratorState | null {
	switch (before.phase) {
		case "downloading":
			return reduceOrchestrator(
				reduceOrchestrator(before, { type: "COMMIT_PHASE_ENTERED", now }),
				{ type: "COMMIT_SUCCEEDED", now },
			);
		case "committing":
			return reduceOrchestrator(before, { type: "COMMIT_SUCCEEDED", now });
		case "restarting-services":
		case "settled":
			return before;
		default:
			return null;
	}
}
