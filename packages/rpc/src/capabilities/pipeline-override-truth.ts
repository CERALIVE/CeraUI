/**
 * Which geometry overrides a pipeline can actually honor.
 *
 * `intersectCaps` already collapses a non-override source's offering to its own
 * `default_resolution` / `default_framerate`, so the UI never presents a choice
 * for such a source — an rtmp/srt ingest carries whatever the publisher sends.
 * A `resolution`/`framerate` sitting on one of those configs is therefore always
 * RESIDUE from a previous source, never an operator intent, and the device is
 * the only party that can say so: the wire cannot distinguish a value the caller
 * typed from one it merely echoed back.
 *
 * Shared by the save path and the start path for the reason `device-mode-truth`
 * is shared: a start that dies on a field the save path was happy to persist —
 * naming an axis the operator's own source row does not even display — is the
 * defect this closes.
 */

export const PIPELINE_OVERRIDE_FIELDS = ['resolution', 'framerate'] as const;

export type PipelineOverrideField = (typeof PIPELINE_OVERRIDE_FIELDS)[number];

export interface PipelineOverrideSupport {
	readonly supportsResolutionOverride: boolean;
	readonly supportsFramerateOverride: boolean;
}

export function supportsPipelineOverride(
	support: PipelineOverrideSupport,
	field: PipelineOverrideField,
): boolean {
	return field === 'resolution'
		? support.supportsResolutionOverride
		: support.supportsFramerateOverride;
}

/**
 * The carried override fields this pipeline cannot honor.
 *
 * Only fields that are actually PRESENT are reported — an absent override is
 * nothing to reconcile, so a config that never had one is left untouched.
 */
export function unsupportedPipelineOverrides(
	support: PipelineOverrideSupport,
	carried: { resolution?: unknown; framerate?: unknown },
): PipelineOverrideField[] {
	return PIPELINE_OVERRIDE_FIELDS.filter(
		(field) => carried[field] !== undefined && !supportsPipelineOverride(support, field),
	);
}
