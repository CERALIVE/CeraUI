import type {
	ListSwitchTargetsResult,
	SwitchInputResult,
} from "@ceralive/cerastream";
import {
	SWITCH_INPUT_ERRORS,
	type SwitchInputOutput,
} from "@ceraui/rpc/schemas";

export interface SessionSwitchDeps {
	readonly isStreaming: () => boolean;
	readonly listTargets: () => Promise<ListSwitchTargetsResult | undefined>;
	readonly switchTarget: (id: string) => Promise<SwitchInputResult>;
	readonly legacySwitch: (id: string) => Promise<SwitchInputOutput>;
	readonly captureFollow: (
		id: string,
		result: SwitchInputOutput,
	) => SwitchInputOutput;
	readonly now: () => number;
}

export async function switchSessionInput(
	inputId: string,
	deps: SessionSwitchDeps,
): Promise<SwitchInputOutput> {
	if (!deps.isStreaming()) return deps.legacySwitch(inputId);
	const started = deps.now();
	const roster = await deps.listTargets();
	if (roster === undefined) return deps.legacySwitch(inputId);
	const target = roster.switch_targets.find(
		(entry) => entry.input_id === inputId,
	);
	if (target === undefined)
		return { success: false, error: SWITCH_INPUT_ERRORS.SOURCE_LOST };
	const switched = await deps.switchTarget(target.input_id);
	const result = {
		success: true,
		active_input: switched.active_input,
		gap_ms: Math.max(0, Math.round(deps.now() - started)),
	};
	switch (target.kind) {
		case "capture":
			return deps.captureFollow(switched.active_input, result);
		case "synthetic":
		case "network":
			return result;
		default: {
			const exhaustive: never = target.kind;
			return exhaustive;
		}
	}
}
