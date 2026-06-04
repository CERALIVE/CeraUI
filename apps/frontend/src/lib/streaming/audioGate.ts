/**
 * Audio-configuration gate resolver — SINGLE SOURCE OF TRUTH (Task 4).
 *
 * The Audio dialog can only be configured once a video pipeline that exposes
 * audio is selected. Crucially, the gate must follow the DRAFTED encoder
 * selection (what the operator just chose in the Encoder dialog) and not only
 * the last value persisted to the backend config — otherwise picking an
 * audio-capable pipeline never clears the gate until a stream (re)start.
 *
 * Precedence mirrors `EncoderDialog`'s own seeding (`config?.source ??
 * savedConfig?.pipeline`): the in-flight DRAFT wins, the saved device config is
 * the fallback.
 *
 * This module is PURE (no runes, no RPC, no Svelte) so it can be imported by
 * the dialog and unit-tested without side effects.
 */
import type { Pipeline } from "@ceraui/rpc/schemas";

/** The three mutually-exclusive states the audio gate can be in. */
export type AudioGateState =
	/** Nothing drafted or saved — the operator must pick an encoder pipeline. */
	| "no-pipeline"
	/** A pipeline is selected, but it exposes no audio configuration. */
	| "no-audio-support"
	/** A pipeline with audio support is selected — controls are enabled. */
	| "enabled";

/** Pipeline lookup map as published on `getPipelines()?.pipelines`. */
export type PipelineMap = Record<string, Pipeline> | undefined;

/**
 * Resolve the effective pipeline key the audio gate should read.
 *
 * Draft-first, saved-fallback: the drafted encoder source (from the Encoder
 * dialog, layered in LiveView) takes precedence over the persisted config
 * pipeline. Empty strings are treated as "unset".
 */
export function resolveAudioPipelineKey(
	effectivePipeline: string | undefined,
	savedPipeline: string | undefined,
): string | undefined {
	return effectivePipeline || savedPipeline || undefined;
}

/** Does the pipeline identified by `pipelineKey` expose audio configuration? */
export function pipelineSupportsAudio(
	pipelineKey: string | undefined,
	pipelines: PipelineMap,
): boolean {
	if (!pipelineKey || !pipelines) return false;
	return pipelines[pipelineKey]?.supportsAudio ?? false;
}

/**
 * Resolve the gate state from an already-resolved pipeline key.
 *
 * - no key            → "no-pipeline"
 * - key, no audio     → "no-audio-support"
 * - key, audio        → "enabled"
 */
export function resolveAudioGateState(
	pipelineKey: string | undefined,
	pipelines: PipelineMap,
): AudioGateState {
	if (!pipelineKey) return "no-pipeline";
	if (!pipelineSupportsAudio(pipelineKey, pipelines)) return "no-audio-support";
	return "enabled";
}
