import type { PipelineOverrideField } from "@ceraui/rpc";
import type {
	InputMode,
	StreamingSetConfigInput,
	StreamSource,
} from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { getApplyNowGate } from "./config-change-bridge.ts";
import type {
	InflightConfigMarker,
	StagedConfigFields,
} from "./config-change-staging.ts";
import {
	type ResolveSourceRoutingResult,
	resolveSelectionAnchor,
} from "./sources.ts";
import { newAttemptId } from "./start-failure-taxonomy.ts";

const APPLY_NOW_FIELDS = [
	"source",
	"resolution",
	"framerate",
	"video_codec",
	"input_mode",
	"composition",
] as const;

/**
 * Move the restart-requiring fields off `input` and into a marker for this
 * attempt, returning `undefined` when this save is an ordinary "apply on next
 * start". The marker is staged later, at dispatch.
 *
 * It MUTATES `input` on purpose: deleting the fields is what makes the existing
 * merge block below skip them, so there is exactly one place that decides
 * whether a value is persisted now — no parallel write path to drift.
 */
type StageApplyNowFieldsInput = {
	readonly input: StreamingSetConfigInput;
	readonly config: RuntimeConfig;
	readonly sourceRouting:
		| Extract<ResolveSourceRoutingResult, { ok: true }>
		| undefined;
	readonly inputMode: InputMode | undefined;
	readonly sources: readonly StreamSource[];
	/** Overrides the destination pipeline cannot honor; the candidate clears them. */
	readonly derivedClears: readonly PipelineOverrideField[];
};

export function stageApplyNowFields({
	input,
	config,
	sourceRouting,
	inputMode,
	sources,
	derivedClears,
}: StageApplyNowFieldsInput): InflightConfigMarker | undefined {
	if (input.apply_now !== true) return undefined;
	if (
		!APPLY_NOW_FIELDS.some((field) =>
			field === "video_codec"
				? input.video_codec != null
				: input[field] !== undefined,
		)
	)
		return undefined;
	if (!getApplyNowGate().isStreamLive()) return undefined;

	const candidate: StagedConfigFields = {
		...(input.source === undefined
			? {}
			: {
					source: input.source,
					source_stable_id:
						resolveSelectionAnchor(
							sourceRouting?.selected_video_input ?? input.source,
							sources,
						) ?? null,
				}),
		...(input.resolution === undefined ? {} : { resolution: input.resolution }),
		...(input.framerate === undefined ? {} : { framerate: input.framerate }),
		// Residue the DESTINATION pipeline cannot honor belongs to this change: a
		// refused or reverted switch must leave the running source's geometry alone.
		...(derivedClears.includes("resolution") ? { resolution: null } : {}),
		...(derivedClears.includes("framerate") ? { framerate: null } : {}),
		// The engine change-config contract cannot clear a codec; use its next-start default.
		...(input.video_codec == null ? {} : { video_codec: input.video_codec }),
		// A next-start save may clear only the saved mode. An automatic source
		// apply must also clear any explicit mode retained by the live engine.
		...(input.input_mode === undefined &&
		inputMode === config.input_mode &&
		(input.source === undefined || inputMode !== undefined)
			? {}
			: { input_mode: inputMode ?? null }),
		...(input.composition === undefined
			? {}
			: { composition: input.composition }),
		// Routed from the source or the mode: it moves only with them.
		...(input.pipeline === undefined ? {} : { pipeline: input.pipeline }),
		...(sourceRouting === undefined
			? {}
			: { selected_video_input: sourceRouting.selected_video_input ?? null }),
	};
	const previous: InflightConfigMarker["previous"] = {
		...(input.composition === undefined
			? {}
			: { composition: config.composition ?? null }),
		...(config.source === undefined ? {} : { source: config.source }),
		...(config.source_stable_id === undefined
			? {}
			: { source_stable_id: config.source_stable_id }),
		...(config.resolution === undefined
			? {}
			: { resolution: config.resolution }),
		...(config.framerate === undefined ? {} : { framerate: config.framerate }),
		...(config.video_codec === undefined
			? {}
			: { video_codec: config.video_codec }),
		...(config.input_mode === undefined
			? {}
			: { input_mode: config.input_mode }),
		...(config.pipeline === undefined ? {} : { pipeline: config.pipeline }),
		...(config.selected_video_input === undefined
			? {}
			: { selected_video_input: config.selected_video_input }),
	};

	// Everything the candidate holds is held back from the merge below, so a
	// field it gains can never also be saved now.
	for (const field of Object.keys(candidate))
		Reflect.deleteProperty(input, field);

	return {
		attemptId: newAttemptId(),
		startedAt: Date.now(),
		candidate,
		previous,
	};
}
