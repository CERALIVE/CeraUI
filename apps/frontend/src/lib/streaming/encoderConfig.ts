/**
 * Encoder draft → setConfig payload mapper — SINGLE SOURCE OF TRUTH (Task 14).
 *
 * Maps the EncoderDialog draft (owned by LiveView) onto the streaming
 * `setConfig` RPC input, mirroring how the Audio/Server dialogs assemble their
 * own `StreamingConfigInput` before persisting.
 *
 * Field mapping:
 *   draft.source         → pipeline
 *   draft.bitrateOverlay → bitrate_overlay
 *   draft.bitrate        → max_br
 *   draft.resolution     → resolution  (CAPABILITY-GATED)
 *   draft.framerate      → framerate   (CAPABILITY-GATED)
 *
 * Resolution/framerate are only forwarded when the selected pipeline advertises
 * the matching override support (`supportsResolutionOverride` /
 * `supportsFramerateOverride`). Sending them for a pipeline that cannot honour
 * the override would push invalid hardware state to the encoder.
 *
 * Pure (no runes, no RPC, no Svelte) so it can be imported by the view and
 * unit-tested without side effects.
 */
import type { Pipeline, StreamingConfigInput } from "@ceraui/rpc/schemas";

import type { EncoderConfig } from "$main/dialogs/EncoderDialog.svelte";

/**
 * Per-field capability verdict for the two pipeline-gated override fields.
 * `true` means the selected pipeline advertises the capability and the FE may
 * let the operator set it; `false` means the field must be marked
 * disabled/invalid and dropped before it reaches the encoder.
 */
export type OverrideGate = {
	resolution: boolean;
	framerate: boolean;
};

/**
 * SINGLE SOURCE OF TRUTH for override capability gating (Task 28).
 *
 * Both the EncoderDialog UI (to disable/mark-invalid the resolution/framerate
 * controls) and {@link buildEncoderSetConfig} (to drop unsupported overrides)
 * derive their verdict from this one predicate, so the visual gate and the
 * payload gate can never drift apart. A missing/unknown pipeline gates both
 * fields off — an unrecognised source supports no overrides.
 */
export function getOverrideGate(pipeline: Pipeline | undefined): OverrideGate {
	return {
		resolution: Boolean(pipeline?.supportsResolutionOverride),
		framerate: Boolean(pipeline?.supportsFramerateOverride),
	};
}

/**
 * Assemble the `setConfig` payload from an encoder draft and the selected
 * pipeline's capability metadata. Undefined draft fields are omitted so the
 * backend only persists what the operator actually set.
 */
export function buildEncoderSetConfig(
	draft: EncoderConfig,
	pipeline: Pipeline | undefined,
): StreamingConfigInput {
	const input: StreamingConfigInput = {};

	if (draft.source !== undefined) input.pipeline = draft.source;
	if (draft.bitrateOverlay !== undefined) {
		input.bitrate_overlay = draft.bitrateOverlay;
	}
	if (draft.bitrate !== undefined) input.max_br = draft.bitrate;

	// Capability-gated overrides: only forward when the pipeline supports them.
	const gate = getOverrideGate(pipeline);
	if (gate.resolution && draft.resolution !== undefined) {
		input.resolution = draft.resolution;
	}
	if (gate.framerate && draft.framerate !== undefined) {
		input.framerate = draft.framerate;
	}

	return input;
}
