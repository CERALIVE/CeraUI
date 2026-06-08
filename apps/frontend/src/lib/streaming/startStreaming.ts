/**
 * Start-stream config assembly + validation — SINGLE SOURCE OF TRUTH (Task 16).
 *
 * `LiveView` persists encoder/server settings via `rpc.streaming.setConfig`
 * (Task 14), so the SAVED backend `ConfigMessage` (the `getConfig` snapshot) is
 * the authoritative source for a stream start. The only NOT-yet-persisted draft
 * is the working audio override (the AudioDialog edits it in memory until the
 * next stream start folds it in).
 *
 * This module assembles the full `ConfigMessage` handed to
 * `SystemHelper.startStreaming` (→ `rpc.streaming.start`) and gates it on the
 * two fields a stream cannot start without:
 *   - a video source (`pipeline`)
 *   - a server target (`srtla_addr` OR `relay_server`)
 *
 * Pure (no runes, no RPC, no Svelte) so the view can call it and tests can
 * exercise assembly + validation without side effects.
 */
import type { ConfigMessage, Pipelines } from "@ceraui/rpc/schemas";

/**
 * Working audio override layered over the saved config until stream (re)start.
 * Mirrors the `AudioConfigValues` the AudioDialog writes back to LiveView.
 */
export type AudioOverride = {
	asrc?: string;
	acodec?: ConfigMessage["acodec"];
	delay?: number;
} | null;

/** Reason a start was refused — maps to an i18n error key in the view. */
export type StartConfigError =
	| "missingPipeline"
	| "missingServer"
	| "unknownPipeline";

export type StartConfigResult =
	| { ok: true; config: ConfigMessage }
	| { ok: false; error: StartConfigError };

/**
 * True when the saved config has a usable server target — either a direct
 * SRTLA address or a selected relay server. Mirrors LiveView's `serverTarget`.
 */
export function hasServerTarget(config: ConfigMessage | undefined): boolean {
	return Boolean(config?.srtla_addr || config?.relay_server);
}

/**
 * Assemble the full `ConfigMessage` for `rpc.streaming.start` from the SAVED
 * backend config, folding in the not-yet-persisted audio override.
 *
 * Validation gates (refuse, never start on a half-config):
 *   - `pipeline` must be set  → `missingPipeline`
 *   - a server target must be set → `missingServer`
 *   - `pipeline` must be a known key in the supplied `pipelines` registry
 *     → `unknownPipeline` (a stale/legacy id must never reach the backend)
 *
 * `pipelines` is REQUIRED (Task 28): the registry argument must always be passed
 * so the recognition gate can never be skipped. An absent registry (the snapshot
 * has not hydrated yet) is itself a refusal — `unknownPipeline` — because a start
 * cannot be validated without it. A stale/legacy id is therefore always rejected
 * BEFORE any RPC dispatch, never silently forwarded to the backend.
 *
 * Audio fields prefer the working override, falling back to the saved config —
 * matching LiveView's `effectiveAudio*` deriveds.
 */
export function buildStartConfig(
	config: ConfigMessage | undefined,
	audioOverride: AudioOverride,
	pipelines: Pipelines | undefined,
): StartConfigResult {
	const pipeline = config?.pipeline;
	if (!pipeline) {
		return { ok: false, error: "missingPipeline" };
	}

	if (!hasServerTarget(config)) {
		return { ok: false, error: "missingServer" };
	}

	// Recognition gate is mandatory: an unhydrated registry (undefined) or a
	// pipeline id absent from it both refuse with `unknownPipeline`.
	if (!pipelines || !(pipeline in pipelines)) {
		return { ok: false, error: "unknownPipeline" };
	}

	const asrc = audioOverride?.asrc ?? config.asrc;
	const acodec = audioOverride?.acodec ?? config.acodec;
	const delay = audioOverride?.delay ?? config.delay;

	const assembled: ConfigMessage = {
		...config,
		pipeline,
		...(asrc !== undefined ? { asrc } : {}),
		...(acodec !== undefined ? { acodec } : {}),
		...(delay !== undefined ? { delay } : {}),
	};

	return { ok: true, config: assembled };
}

/** Inputs to the Start-button enablement predicate. */
export type CanStartStreamInput = {
	hasServer: boolean;
	pipelineRecognized: boolean;
	starting: boolean;
};

/**
 * Whether the Start button may be enabled: a server target, a recognized
 * pipeline, and no start already in flight (double-start safety).
 */
export function canStartStream({
	hasServer,
	pipelineRecognized,
	starting,
}: CanStartStreamInput): boolean {
	return hasServer && pipelineRecognized && !starting;
}
