import type { AudioInputConfig } from "@ceralive/cerastream";
import {
	AUDIO_SOURCE_AUTO,
	type AudioInputSetting,
	type AudioMixExcludedInput,
	type AudioSource,
	audioMixWithPrimary,
	defaultAudioInput,
} from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import {
	type AudioModeSelection,
	DEFAULT_AUDIO_ID,
	deriveAudioSources,
	getAudioCaptureCardIds,
	getAudioDevices,
	NO_AUDIO_ID,
	resolveAudioMode,
} from "./audio.ts";
import { resolveAutoAsrc } from "./auto-audio.ts";
import { getLastCapabilities } from "./capabilities.ts";
import { isEmbeddedAudioPipeline } from "./embedded-audio.ts";
import { isNetworkIngestPipeline } from "./pipelines.ts";
import { getEngineAudioDevices, getSourcesMessage } from "./sources.ts";
import {
	StreamStartFailure,
	typedStartFailure,
} from "./start-failure-taxonomy.ts";

function requiresAudioInput(id: string | undefined): boolean {
	return (
		id !== undefined &&
		id !== NO_AUDIO_ID &&
		id !== DEFAULT_AUDIO_ID &&
		id !== AUDIO_SOURCE_AUTO
	);
}

export function canPickAudioInput(config: RuntimeConfig, id: string): boolean {
	return !requiresAudioInput(id) || availableAudioInputIds(config).has(id);
}

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

export function audioInputEngineId(
	id: string,
	config: RuntimeConfig,
): string | undefined {
	if (
		isEmbeddedAudioPipeline(config.pipeline) &&
		id === (config.source ?? config.pipeline)
	)
		return "embedded";
	if (isNetworkIngestPipeline(id)) return undefined;
	return resolveAudioMode(id, false, getAudioDevices()).device ?? id;
}

function availableAudioInputIds(
	config: RuntimeConfig,
	sources = deriveAudioSources(),
): Set<string> {
	const available = new Set(
		sources
			.filter(
				(source) =>
					source.kind === "device" &&
					source.unavailable_reason === undefined &&
					!isNetworkIngestPipeline(source.id),
			)
			.map((source) => source.id),
	);
	if (isEmbeddedAudioPipeline(config.pipeline)) {
		const embedded = config.source ?? config.pipeline;
		if (embedded !== undefined) available.add(embedded);
	}
	return available;
}

export function excludedAudioInputs(
	config: RuntimeConfig,
	sources: AudioSource[] = deriveAudioSources(),
): AudioMixExcludedInput[] {
	const available = availableAudioInputIds(config, sources);
	return (config.audio_inputs ?? []).flatMap<AudioMixExcludedInput>(
		({ id }) => {
			if (available.has(id)) return [];
			return isNetworkIngestPipeline(id)
				? [{ id, reason: "other_source", label: id.toUpperCase() }]
				: [
						{
							id,
							reason: "unplugged",
							label: sources.find((source) => source.id === id)?.label ?? id,
						},
					];
		},
	);
}

export function validateAudioInputs(
	inputs: readonly AudioInputSetting[],
	config: RuntimeConfig,
	edit?: { readonly id: string; readonly valuesOnly?: true },
): string | undefined {
	const capability = getLastCapabilities()?.audio_mix;
	if (!capability) return "audio_mix_unsupported";
	const available = availableAudioInputIds(config);
	const saved = config.audio_inputs ?? [];
	// An unavailable leg still needs its saved slot when it returns.
	const exceedsSavedLimit =
		inputs.length > capability.max_inputs &&
		inputs.some(({ id }) => !saved.some((input) => input.id === id));
	const excluded = new Set(
		saved
			.filter(
				({ id }) => edit !== undefined && id !== edit.id && !available.has(id),
			)
			.map(({ id }) => id),
	);
	inputs = inputs.filter(({ id }) => !excluded.has(id));
	if (inputs.length === 0) return "audio_inputs_empty";
	if (exceedsSavedLimit || inputs.length > capability.max_inputs)
		return "audio_inputs_too_many";
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
	// Losing or explicitly removing a device can leave a gap. Keep existing
	// gaps for value edits; no edit may create a new gap.
	const previousTracks =
		excluded.size > 0 || edit?.valuesOnly
			? saved
					.filter(({ id }) => available.has(id))
					.flatMap(({ tracks }) => tracks)
			: [];
	for (let track = 1; track < Math.max(...tracks); track++) {
		if (
			!tracks.has(track) &&
			(previousTracks.includes(track) || track > Math.max(0, ...previousTracks))
		)
			return "audio_tracks_gap";
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
		inputs.length === 0 ||
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
 * The saved mix with the available main input included (`audioMixWithPrimary`).
 * Nothing is written here, so loading and Start never rewrite the saved mix.
 */
export function effectiveAudioInputs(
	config: RuntimeConfig,
	pinnedPrimary?: string,
): AudioInputSetting[] | undefined {
	const capability = getLastCapabilities()?.audio_mix;
	const primary = pinnedPrimary ?? primaryAudioInputId(config);
	if (
		!capability ||
		primary === undefined ||
		config.audio_inputs?.some(({ id }) => id === primary)
	)
		return config.audio_inputs;
	const available = availableAudioInputIds(config);
	if (pinnedPrimary !== undefined) available.add(pinnedPrimary);
	if (!available.has(primary)) return config.audio_inputs;
	return mixWithAvailablePrimary(
		config.audio_inputs,
		primary,
		capability.max_inputs,
		available,
	);
}

function mixWithAvailablePrimary(
	saved: AudioInputSetting[] | undefined,
	primary: string,
	maxInputs: number,
	available: Set<string>,
	previous?: string,
): AudioInputSetting[] | undefined {
	if (!saved?.length) return undefined;
	const present = saved.filter(({ id }) => available.has(id));
	const [main = defaultAudioInput(primary), ...remaining] =
		audioMixWithPrimary(present, primary, maxInputs, previous) ?? [];
	return [
		main,
		...saved.filter(
			(input) => !available.has(input.id) || remaining.includes(input),
		),
	];
}

/**
 * The saved mix after an explicit pick of `asrc`, decided against the backend's
 * own current saved mix and current main input (Auto's resolution included), so
 * quick successive picks and a stale second tab compose. Undefined when the pick
 * changes no membership.
 */
export function pickedAudioInputs(
	asrc: string,
	config: RuntimeConfig,
): AudioInputSetting[] | undefined {
	const capability = getLastCapabilities()?.audio_mix;
	const saved = config.audio_inputs;
	const available = availableAudioInputIds(config);
	if (
		!capability ||
		!saved?.length ||
		saved.some((input) => input.id === asrc) ||
		!available.has(asrc)
	)
		return undefined;
	return mixWithAvailablePrimary(
		saved,
		asrc,
		capability.max_inputs,
		available,
		primaryAudioInputId(config),
	);
}

/**
 * The saved mix after one strip's membership or track edit, composed on the
 * device's current mix so an edit never carries a client's copy of the others.
 */
export function changedAudioInputs(
	config: RuntimeConfig,
	id: string,
	change: {
		include?: boolean | undefined;
		track?: { number: number; on: boolean } | undefined;
	},
): { inputs: AudioInputSetting[] } | { error: string } {
	const saved = config.audio_inputs;
	if (
		change.include === false &&
		saved?.some((input) => input.id === id) &&
		!availableAudioInputIds(config).has(id)
	)
		return { inputs: saved.filter((input) => input.id !== id) };
	const primary = primaryAudioInputId(config);
	if (change.include === false && id === primary)
		return { error: "audio_input_primary" };
	let next =
		effectiveAudioInputs(config) ??
		(primary === undefined ? [] : [defaultAudioInput(primary)]);
	if (change.include === true && !next.some((input) => input.id === id))
		next = [...next, defaultAudioInput(id)];
	if (change.include === false) next = next.filter((input) => input.id !== id);
	const { track } = change;
	if (track !== undefined) {
		if (!next.some((input) => input.id === id))
			return { error: "audio_input_unknown" };
		next = next.map((input) =>
			input.id !== id
				? input
				: {
						...input,
						tracks: track.on
							? [...new Set([...input.tracks, track.number])].sort(
									(a, b) => a - b,
								)
							: input.tracks.filter((existing) => existing !== track.number),
					},
		);
	}
	const error = validateAudioInputs(next, config, { id });
	return error === undefined ? { inputs: next } : { error };
}

/** Omit redundant legs; otherwise preserve the routing for the attempted Start. */
export function projectLaunchAudioInputs(
	config: RuntimeConfig,
	inputs: readonly AudioInputSetting[],
	resolveId: (id: string) => string | undefined = (id) => id,
): AudioInputSetting[] | undefined {
	const available = availableAudioInputIds(config);
	const primary = primaryAudioInputId(config);
	const resolved: AudioInputSetting[] = [];
	const projected: AudioInputSetting[] = [];
	let canOmit = true;
	for (const input of inputs) {
		const id = resolveId(input.id);
		const entry = id === undefined ? undefined : { ...input, id };
		if (entry !== undefined) resolved.push(entry);
		if (entry !== undefined && available.has(entry.id)) projected.push(entry);
		else if (input.id === primary) canOmit = false;
	}
	const tracks = new Set(projected.flatMap(({ tracks }) => tracks));
	if (
		canOmit &&
		inputs.every((input) => input.tracks.every((track) => tracks.has(track)))
	)
		return projected;
	// A key whose physical identity is no longer proven must not be sent.
	return resolved.length === inputs.length ? resolved : undefined;
}

function engineAudioInputs(
	config: RuntimeConfig,
): AudioInputConfig[] | undefined | null {
	const effective = effectiveAudioInputs(config);
	if (!getLastCapabilities()?.audio_mix || !effective?.length) return undefined;
	const inputs = projectLaunchAudioInputs(config, effective);
	const primary = primaryAudioInputId(config);
	const ordered = inputs && [
		...inputs.filter((input) => input.id === primary),
		...inputs.filter((input) => input.id !== primary),
	];
	const mapped = ordered?.flatMap(({ id, ...input }) => {
		const input_id = audioInputEngineId(id, config);
		return input_id === undefined ? [] : [{ input_id, ...input }];
	});
	return mapped !== undefined && mapped.length === ordered?.length
		? mapped
		: null;
}

export interface LaunchAudioPlan extends AudioModeSelection {
	inputs?: AudioInputConfig[];
}

/**
 * The audio a launch sends, decided once for the engine start, the persisted
 * engine config and the mock engine: nothing, the saved mix, the engine's
 * default or one device. `audioOff: true` starts this stream without audio and
 * saves nothing; `false` says a "No audio" in `config` is only what Auto resolved
 * to, so a saved mix is still sent; absent, the pick in `config` decides.
 * Undefined when no `asrc` is set and no mix is saved, so the start keeps the
 * engine's legacy inference.
 */
type LaunchAudioOptions = {
	readonly audioOff?: boolean | undefined;
	readonly embeddedAudioActive?: boolean;
};

export function planLaunchAudio(
	config: RuntimeConfig,
	{
		audioOff = config.asrc === NO_AUDIO_ID,
		embeddedAudioActive = isEmbeddedAudioPipeline(config.pipeline),
	}: LaunchAudioOptions = {},
): LaunchAudioPlan | undefined | null {
	if (audioOff) return { mode: "none" };
	const inputs = engineAudioInputs(config);
	if (inputs === null) return null;
	if (inputs !== undefined) return { mode: "default", inputs };
	return config.asrc === undefined
		? undefined
		: resolveAudioMode(config.asrc, embeddedAudioActive);
}

export function unavailableAudioRoute(attemptId: string): StreamStartFailure {
	return new StreamStartFailure(
		typedStartFailure(
			attemptId,
			"params",
			"audio_source_unavailable",
			"audio_source_probe_failed",
		),
	);
}

export function launchAudioPlan(
	config: RuntimeConfig,
	options: LaunchAudioOptions & { readonly attemptId?: string } = {},
): LaunchAudioPlan | undefined {
	const plan = planLaunchAudio(config, options);
	if (plan === null)
		throw unavailableAudioRoute(options.attemptId ?? "backend-start");
	return plan;
}
