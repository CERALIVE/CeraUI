import type { AudioInputConfig } from "@ceralive/cerastream";
import { AUDIO_SOURCE_AUTO, type AudioInputSetting } from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import {
	deriveAudioSources,
	getAudioCaptureCardIds,
	getAudioDevices,
	resolveAudioMode,
} from "./audio.ts";
import { resolveAutoAsrc } from "./auto-audio.ts";
import { getLastCapabilities } from "./capabilities.ts";
import { isEmbeddedAudioPipeline } from "./embedded-audio.ts";
import { getEngineAudioDevices, getSourcesMessage } from "./sources.ts";

export function primaryAudioInputId(config: RuntimeConfig): string | undefined {
	if (
		isEmbeddedAudioPipeline(config.pipeline) &&
		(config.asrc === undefined ||
			config.asrc === AUDIO_SOURCE_AUTO ||
			config.asrc === "Pipeline default")
	)
		return config.source ?? config.pipeline;
	if (config.asrc !== AUDIO_SOURCE_AUTO) return config.asrc;
	return (
		resolveAutoAsrc({
			source: getSourcesMessage().sources.find(
				(source) => source.id === config.source,
			),
			audioDevices: getAudioDevices(),
			engineAudio: getEngineAudioDevices(),
			networkEmbeddedAudio: getLastCapabilities()?.network_embedded_audio,
			captureCapableCardIds: getAudioCaptureCardIds(),
		}).asrcKey ?? undefined
	);
}

export function audioInputEngineId(id: string, config: RuntimeConfig): string {
	if (
		isEmbeddedAudioPipeline(config.pipeline) &&
		id === (config.source ?? config.pipeline)
	)
		return "embedded";
	return resolveAudioMode(id, false, getAudioDevices()).device ?? id;
}

function availableAudioInputIds(config: RuntimeConfig): Set<string> {
	const available = new Set(
		deriveAudioSources()
			.filter(
				(source) =>
					source.kind === "device" && source.unavailable_reason === undefined,
			)
			.map((source) => source.id),
	);
	if (isEmbeddedAudioPipeline(config.pipeline)) {
		const embedded = config.source ?? config.pipeline;
		if (embedded !== undefined) available.add(embedded);
	}
	return available;
}

export function validateAudioInputs(
	inputs: readonly AudioInputSetting[],
	config: RuntimeConfig,
): string | undefined {
	const capability = getLastCapabilities()?.audio_mix;
	if (!capability) return "audio_mix_unsupported";
	if (inputs.length === 0) return "audio_inputs_empty";
	if (inputs.length > capability.max_inputs) return "audio_inputs_too_many";
	const available = availableAudioInputIds(config);
	const ids = new Set<string>();
	const tracks = new Set<number>();
	for (const input of inputs) {
		if (ids.has(input.id)) return "audio_input_duplicate";
		ids.add(input.id);
		if (!available.has(input.id)) return "audio_input_unknown";
		if (
			input.tracks.length === 0 ||
			new Set(input.tracks).size !== input.tracks.length ||
			input.tracks.some(
				(track) =>
					!Number.isInteger(track) ||
					track < 1 ||
					track > capability.max_tracks,
			)
		)
			return "audio_tracks_invalid";
		for (const track of input.tracks) tracks.add(track);
		const error = validateAudioInputValues(input);
		if (error !== undefined) return error;
	}
	for (let track = 1; track <= tracks.size; track++) {
		if (!tracks.has(track)) return "audio_tracks_gap";
	}
	return undefined;
}

export function validateAudioInputValues(
	input: Pick<AudioInputSetting, "gain_db" | "delay_ms">,
): string | undefined {
	const capability = getLastCapabilities()?.audio_mix;
	if (!capability) return "audio_mix_unsupported";
	if (
		!Number.isFinite(input.gain_db) ||
		input.gain_db < capability.gain_db_min ||
		input.gain_db > capability.gain_db_max
	)
		return "audio_gain_range";
	if (
		!Number.isInteger(input.delay_ms) ||
		input.delay_ms < 0 ||
		input.delay_ms > capability.delay_ms_max
	)
		return "audio_delay_range";
	return undefined;
}

export function storedAudioInputs(
	inputs: AudioInputSetting[] | null,
	config: RuntimeConfig,
): AudioInputSetting[] | undefined {
	const only = inputs?.[0];
	if (
		inputs === null ||
		(inputs.length === 1 &&
			only !== undefined &&
			only.id === primaryAudioInputId(config) &&
			only.gain_db === 0 &&
			!only.mute &&
			only.delay_ms === 0 &&
			only.tracks.length === 1 &&
			only.tracks[0] === 1)
	)
		return undefined;
	return inputs;
}

/**
 * The mix Start sends and live changes address: the saved entries with the
 * main input in them. A main input outside the saved mix joins first on Track
 * 1, or in a full mix takes the first entry's place and tracks (the UI saves the
 * main input first). Nothing is written here: the saved mix changes only when
 * the operator edits it, so loading never rewrites it.
 */
export function effectiveAudioInputs(
	config: RuntimeConfig,
): AudioInputSetting[] | undefined {
	const saved = config.audio_inputs;
	const capability = getLastCapabilities()?.audio_mix;
	const primary = primaryAudioInputId(config);
	if (
		!capability ||
		!saved?.length ||
		primary === undefined ||
		saved.some((input) => input.id === primary) ||
		!availableAudioInputIds(config).has(primary)
	)
		return saved;
	const entry = {
		id: primary,
		tracks: [1],
		gain_db: 0,
		mute: false,
		delay_ms: 0,
	};
	if (saved.length < capability.max_inputs) return [entry, ...saved];
	const [replaced, ...others] = saved;
	return [{ ...entry, tracks: [...(replaced?.tracks ?? [1])] }, ...others];
}

export function engineAudioInputs(
	config: RuntimeConfig,
): AudioInputConfig[] | undefined {
	const inputs = effectiveAudioInputs(config);
	if (!getLastCapabilities()?.audio_mix || !inputs?.length) return undefined;
	const primary = primaryAudioInputId(config);
	const ordered = [
		...inputs.filter((input) => input.id === primary),
		...inputs.filter((input) => input.id !== primary),
	];
	return ordered.map(({ id, ...input }) => ({
		input_id: audioInputEngineId(id, config),
		...input,
	}));
}
