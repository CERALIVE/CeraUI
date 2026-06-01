import type { Framerate, Pipelines, Resolution } from "@ceraui/rpc/schemas";

import { streamingConstraints } from "./ValidationAdapter";

/**
 * Shape of the form values consumed by {@link validateStreamingForm}.
 * Exported so unit tests (and the Streaming view) can build fixtures against
 * a single source of truth.
 */
export type StreamingFormProperties = {
	source: string | undefined;
	resolution: Resolution | undefined;
	framerate: Framerate | undefined;
	bitrate: number | undefined;
	srtLatency: number | undefined;
	audioDelay: number | undefined;
	relayServer: string | undefined;
	srtlaServerAddress: string | undefined;
	srtlaServerPort: number | undefined;
	pipeline: keyof Pipelines | undefined;
	audioSource: string | undefined;
	audioCodec: string | undefined;
};

type ValidationOptions = {
	pipelines: Pipelines | undefined;
};

export interface ValidationResult {
	isValid: boolean;
	errors: Record<string, string>;
}

const PORT_MIN = 1;
const PORT_MAX = 65535;

/**
 * Pure, side-effect-free validation for the streaming form.
 *
 * - All numeric bounds are sourced from {@link streamingConstraints}
 *   (schema-derived via `ValidationAdapter`), never hardcoded literals.
 * - Returns a `{ isValid, errors }` result keyed by field name. It does NOT
 *   raise toasts or touch any global state — the component renders the
 *   per-field messages inline.
 * - `t` resolves an i18n key (e.g. `validation.required`) to a localized
 *   string. Injecting it keeps this function trivially unit-testable
 *   (pass an identity function to assert on the raw keys).
 */
export function validateStreamingForm(
	properties: StreamingFormProperties,
	t: (key: string) => string,
	options?: ValidationOptions,
): ValidationResult {
	const { bitrate, srtLatency, audioDelay } = streamingConstraints;
	const errors: Record<string, string> = {};

	// Video source is always required.
	if (!properties.source) {
		errors.source = t("validation.required");
	}

	// Bitrate must sit within the canonical hardware window.
	if (
		properties.bitrate === undefined ||
		properties.bitrate < bitrate.min ||
		properties.bitrate > bitrate.max
	) {
		errors.bitrate = t("validation.bitrateRange");
	}

	// SRT latency is optional, but when present must be within range.
	if (
		properties.srtLatency !== undefined &&
		(properties.srtLatency < srtLatency.min ||
			properties.srtLatency > srtLatency.max)
	) {
		errors.srtLatency = t("validation.invalid");
	}

	// Audio delay is optional, but when present must be within range.
	if (
		properties.audioDelay !== undefined &&
		(properties.audioDelay < audioDelay.min ||
			properties.audioDelay > audioDelay.max)
	) {
		errors.audioDelay = t("validation.invalid");
	}

	// Audio source/codec are required only when the pipeline supports audio.
	if (options?.pipelines && properties.pipeline) {
		const pipelineData = options.pipelines[properties.pipeline];
		if (pipelineData?.supportsAudio) {
			if (!properties.audioSource) {
				errors.audioSource = t("validation.required");
			}
			if (!properties.audioCodec) {
				errors.audioCodec = t("validation.required");
			}
		}
	}

	// Receiver configuration: manual SRTLA vs. relay-server selection.
	if (properties.relayServer === "-1" || properties.relayServer === undefined) {
		if (
			!properties.srtlaServerAddress ||
			properties.srtlaServerAddress.trim() === ""
		) {
			errors.srtlaServerAddress = t("validation.required");
		}

		if (
			!properties.srtlaServerPort ||
			!Number.isInteger(properties.srtlaServerPort) ||
			properties.srtlaServerPort < PORT_MIN ||
			properties.srtlaServerPort > PORT_MAX
		) {
			errors.srtlaServerPort = t("validation.portRange");
		}
	} else if (!properties.relayServer) {
		errors.relayServer = t("validation.required");
	}

	return {
		isValid: Object.keys(errors).length === 0,
		errors,
	};
}
