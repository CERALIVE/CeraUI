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
	if (pipeline?.supportsResolutionOverride && draft.resolution !== undefined) {
		input.resolution = draft.resolution;
	}
	if (pipeline?.supportsFramerateOverride && draft.framerate !== undefined) {
		input.framerate = draft.framerate;
	}

	return input;
}
