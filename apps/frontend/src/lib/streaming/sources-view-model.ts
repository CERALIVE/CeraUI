/**
 * Legacy view-model projections derived from the unified `sources` broadcast.
 *
 * The device-first source model (`getSources()`) is the ONE semantic truth for
 * "what can I stream". Several surfaces still speak the older two-broadcast
 * vocabulary — a `pipelines` registry keyed by pipeline id, and a flat
 * `CaptureDevice[]` — so this module projects the unified `StreamSource[]` back
 * into exactly those shapes. Consumers keep their existing signatures; only the
 * INGESTION path changes (`TD-legacy-source-broadcasts`).
 *
 * The projections mirror the backend builders field-for-field
 * (`apps/backend/src/modules/streaming/{pipelines,sources}.ts`), with three
 * differences that follow from the sources model itself and are deliberate:
 *
 *  1. `Pipeline.description` — the registry stores `SOURCE_DESCRIPTIONS[id] ?? id`
 *     and the sources payload carries no counterpart. We project the backend's
 *     own fallback (`id`). No frontend surface reads it: `getPipelineDisplayName`
 *     only reaches `description` when `name` is empty, and `name` is always the
 *     pipeline id.
 *  2. Probed caps come from `StreamSource.modes`, which the backend already
 *     folded from `CaptureDevice.caps` — so they are grouped by
 *     (width, height, media_type) and their framerates are normalized ladder
 *     rungs. Rendering is byte-identical for on-ladder rates (`formatProbedCap`
 *     is reused verbatim); off-ladder rates were already dropped at fold time.
 *  3. Audio-only devices contribute no row: `buildSources` publishes video
 *     devices only, by construction.
 */

import { MEDIA_TYPE_H265, mediaTypeToSourceKind } from "@ceraui/rpc";
import type {
	CaptureStreamSource,
	Pipeline,
	Pipelines,
	SourcesMessage,
	StreamSource,
} from "@ceraui/rpc/schemas";

import {
	type CapLabelTranslator,
	formatProbedCap,
	type ProbedCapsSummary,
	type UvcH265Source,
} from "$lib/components/streaming/ValidationAdapter";

/** The capture rows of a sources snapshot, in broadcast order. */
function captureRows(
	message: SourcesMessage | undefined,
): CaptureStreamSource[] {
	if (!message) return [];
	return message.sources.filter(
		(source): source is CaptureStreamSource => source.origin === "capture",
	);
}

/** Project one source row onto the pipeline-level facets of its pipeline. */
function toPipeline(source: StreamSource): Pipeline {
	const pipeline: Pipeline = {
		name: source.pipelineId,
		description: source.pipelineId,
		supportsAudio: source.supportsAudio,
		supportsResolutionOverride: source.supportsResolutionOverride,
		supportsFramerateOverride: source.supportsFramerateOverride,
		audio_kind: source.audioKind,
	};
	if (source.defaultResolution !== undefined) {
		pipeline.defaultResolution = source.defaultResolution;
	}
	if (source.defaultFramerate !== undefined) {
		pipeline.defaultFramerate = source.defaultFramerate;
	}
	if (source.origin === "network") {
		pipeline.requires_gateway = source.requiresGateway;
	}
	return pipeline;
}

/**
 * Reconstruct the legacy `pipelines` registry from a sources snapshot.
 *
 * Every source row carries the pipeline-level facets of its `pipelineId`
 * verbatim — `buildSources` copies them from the same coarse capability row —
 * so rows sharing a pipeline always agree and the first one wins.
 *
 * `undefined` in, `undefined` out: an unhydrated snapshot must stay
 * unhydrated, because consumers treat an absent registry as "cannot validate
 * yet" rather than "empty registry".
 */
export function pipelinesFromSources(
	message: SourcesMessage | undefined,
): Pipelines | undefined {
	if (!message) return undefined;
	const pipelines: Pipelines = {};
	for (const source of message.sources) {
		if (pipelines[source.pipelineId] !== undefined) continue;
		pipelines[source.pipelineId] = toPipeline(source);
	}
	return pipelines;
}

/**
 * Summarise the probed formats each connected capture device advertises.
 *
 * Mirrors `summarizeProbedCaps` over the sources model: one entry per capture
 * row that has at least one renderable format, labels deduped (identical labels
 * carry identical information).
 */
export function probedCapsFromSources(
	message: SourcesMessage | undefined,
	t?: CapLabelTranslator,
): ProbedCapsSummary[] {
	const out: ProbedCapsSummary[] = [];
	for (const source of captureRows(message)) {
		const labels = new Set<string>();
		for (const mode of source.modes) {
			for (const framerate of mode.framerates) {
				const label = formatProbedCap(
					{
						width: mode.width,
						height: mode.height,
						framerate: String(framerate),
						...(mode.media_type !== undefined
							? { media_type: mode.media_type }
							: {}),
					},
					t,
				);
				if (label.length > 0) labels.add(label);
			}
		}
		if (labels.size === 0) continue;
		out.push({
			inputId: source.id,
			displayName: source.displayName,
			caps: [...labels],
		});
	}
	return out;
}

/**
 * The capture devices that advertise an H.265 capture format, as offered UVC
 * sources. Mirrors `deriveUvcH265Sources` over the sources model: a device's
 * per-format ladders (`inputModes`) are authoritative when the engine reported
 * them, and the folded `modes` are the pre-0.11.0 fallback.
 */
export function uvcH265SourcesFromSources(
	message: SourcesMessage | undefined,
): UvcH265Source[] {
	const out: UvcH265Source[] = [];
	for (const source of captureRows(message)) {
		const advertisesH265 =
			source.inputModes !== undefined
				? source.inputModes.some((mode) => mode.mediaType === MEDIA_TYPE_H265)
				: source.modes.some((mode) => mode.media_type === MEDIA_TYPE_H265);
		if (!advertisesH265) continue;
		out.push({
			inputId: source.id,
			displayName: source.displayName,
			sourceKind:
				mediaTypeToSourceKind(MEDIA_TYPE_H265, source.id) ?? "uvc_h265",
		});
	}
	return out;
}
