<!--
  AudioMixer.svelte — one strip per audio input (Live screen contract, change 4).

  Renders NOTHING unless the engine advertises `audio_mix`: an engine that
  cannot mix leaves no node behind. SourceSection mounts it in the idle Audio
  card under the picker; LiveCockpit mounts it in the live `audio-card`.

  Every bound is the capability's: gain from `gain_db_min` to `gain_db_max`,
  delay from 0 to `delay_ms_max`, one chip per track up to `max_tracks`, and at
  most `max_inputs` inputs in the mix, with or without a strip. The input
  picked above is the main input:
  its strip is always on, and it is in the mix Start sends even when the saved
  mix lacks it (the backend's effective mix); showing it never saves anything.

  Idle, each change sends only that input's delta to `streaming.setAudioMix`: a
  level, mute or delay value, one track on or off, or the input in or out. The
  device composes it on its own saved mix, so an edit never carries a stale copy
  of the other inputs. Each control shows its own pending choice, then the
  applied value or the device's saved config.
  Live on a mix session (`status.audio_mix_active`), level, mute and delay go to
  `streaming.setAudioMix` and the device's applied values win until a config
  broadcast changes that input after the change was sent (another tab's write,
  or the change's own echo with the same values); membership and tracks wait
  for the next start. Live without a mix, every control waits.

  A refusal is shown beside its strip as the copy of the backend token that
  names it. The UI refuses a track change the backend would refuse with the same
  token and the same copy, so the operator never meets two wordings for one rule.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type {
	AudioInputSetting,
	CapabilitiesMessage,
	ConfigMessage,
	SetAudioMixInput,
} from '@ceraui/rpc/schemas';
import {
	AUDIO_SOURCE_AUTO,
	audioMixWithPrimary,
	defaultAudioInput as defaults,
} from '@ceraui/rpc/schemas';
import { Activity, RotateCcw, Volume2, VolumeX } from '@lucide/svelte';
import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

import LabeledSlider from '$lib/components/custom/LabeledSlider.svelte';
import AudioLevelMeter from '$lib/components/preview/AudioLevelMeter.svelte';
import LiveAudioMeter from '$lib/components/preview/LiveAudioMeter.svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Switch } from '$lib/components/ui/switch';
import { rpc } from '$lib/rpc';
import { getStreamSessionEpoch } from '$lib/rpc/session-epoch.svelte';
import {
	getAudioLevel,
	getIsConnected,
	getSources,
	getStatus,
} from '$lib/rpc/subscriptions.svelte';
import { audioSourceLabel, resolveAudioSourceList } from '$lib/streaming/sourceSummary';
import { pipelinesFromSources } from '$lib/streaming/sources-view-model';

interface Props {
	config: ConfigMessage | undefined;
	capabilities: CapabilitiesMessage | undefined;
	isStreaming: boolean;
}

const { config, capabilities, isStreaming }: Props = $props();

// The backend's literal for the pseudo-source that defers to the pipeline.
const PIPELINE_DEFAULT = 'Pipeline default';
const GAIN_SEND_INTERVAL_MS = 100;
const DELAY_STEP_MS = 10;
const SAVE_FAILED = 'save_failed';

const uid = $props.id();
const t = resolveMessageKey;

type Values = Pick<AudioInputSetting, 'gain_db' | 'mute' | 'delay_ms'>;
const VALUE_FIELDS = ['gain_db', 'mute', 'delay_ms'] as const;
type ValueField = (typeof VALUE_FIELDS)[number];
type Field = ValueField | 'include' | number;
type Delta = Omit<SetAudioMixInput, 'id'>;

const mix = $derived(capabilities?.audio_mix);
const status = $derived(getStatus());
const excluded = $derived(status?.audio_mix_excluded?.filter(
	(row) => config?.audio_inputs?.some(({ id }) => id === row.id),
) ?? []);
const isExcluded = (id: string) => excluded.some((row) => row.id === id);
const mixLive = $derived(isStreaming && status?.audio_mix_active === true);
const liveEpoch = $derived(mixLive ? getStreamSessionEpoch() : undefined);
// Live without a mix, level, mute and delay wait for the next start too.
const valuesLocked = $derived(isStreaming && !mixLive);

// The backend sends a network source's embedded audio as the engine's
// `embedded` input under the source id; mirror its gate exactly.
const embeddedId = $derived.by(() => {
	const pipeline = config?.pipeline;
	if (pipeline === undefined) return undefined;
	const embedded =
		pipelinesFromSources(getSources())?.[pipeline]?.audio_kind === 'embedded' &&
		capabilities?.network_embedded_audio === true;
	return embedded ? (config?.source ?? pipeline) : undefined;
});

// The backend's `primaryAudioInputId`: the picker's input, Auto's resolution,
// or the embedded audio when the picker defers to the source.
const primaryId = $derived.by(() => {
	const asrc = config?.asrc;
	if (
		embeddedId !== undefined &&
		(asrc === undefined || asrc === AUDIO_SOURCE_AUTO || asrc === PIPELINE_DEFAULT)
	)
		return embeddedId;
	if (asrc !== AUDIO_SOURCE_AUTO) return asrc;
	return status?.resolved_asrc ?? undefined;
});

const strips = $derived.by(() => {
	const devices = resolveAudioSourceList(status?.audio_sources, status?.asrcs ?? [])
		.filter((source) => source.kind === 'device' && source.unavailable_reason === undefined && !isExcluded(source.id))
		.map((source) => ({ id: source.id, label: audioSourceLabel(source, t) }));
	return embeddedId === undefined || isExcluded(embeddedId)
		? devices
		: [{ id: embeddedId, label: m['live.source.audioEmbedded']() }, ...devices];
});
const hasPrimary = $derived(strips.some((strip) => strip.id === primaryId));

interface Intent {
	readonly id: string;
	readonly delta: Delta;
	readonly generation: number;
	readonly epoch: number | undefined;
}

const fieldKey = (id: string, field: Field) => JSON.stringify([id, field]);
const intents = new SvelteMap<string, Intent>();
const appliedValues = new SvelteMap<string, { values: Partial<Values>; epoch: number | undefined }>();
const errors = new SvelteMap<
	string,
	{ id: string; field: Field; token: string; epoch: number | undefined }
>();
let generation = 0;

function withTrack(entry: AudioInputSetting, number: number, on: boolean): AudioInputSetting {
	const tracks = entry.tracks.filter((track) => track !== number);
	if (on) tracks.push(number);
	return { ...entry, tracks: tracks.sort((a, b) => a - b) };
}

const inputs = $derived.by(() => {
	let entries =
		audioMixWithPrimary(
			config?.audio_inputs?.filter(({ id }) => !isExcluded(id)),
			hasPrimary ? primaryId : undefined,
			mix?.max_inputs ?? 0,
		) ??
		(hasPrimary && primaryId !== undefined ? [defaults(primaryId)] : [])
	if (isStreaming) return entries;
	// Rebase only outstanding membership and track changes on the newest saved mix.
	for (const { id, delta } of [...intents.values()].sort((a, b) => a.generation - b.generation)) {
		if (delta.include === false) entries = entries.filter((entry) => entry.id !== id);
		if (delta.include === true && !entries.some((entry) => entry.id === id))
			entries = [...entries, defaults(id)];
		const track = delta.track;
		if (track !== undefined)
			entries = entries.map((entry) => entry.id === id ? withTrack(entry, track.number, track.on) : entry);
	}
	return entries;
});

function isEnabled(id: string): boolean {
	return id === primaryId || inputs.some((input) => input.id === id);
}

function entryFor(id: string): AudioInputSetting {
	return inputs.find((input) => input.id === id) ?? defaults(id);
}

const full = $derived(mix !== undefined && inputs.length >= mix.max_inputs);

// The level the device was last sent or answered, per input; asking for that same
// level again sends nothing. A broadcast that changes the input replaces it with
// the saved level, which is what the device now holds.
const gainSent: Record<string, number> = {};

// Count changes per field: another field's echo cannot supersede this answer.
const broadcasts = new SvelteMap<string, number>();
let lastSaved = new Map<string, AudioInputSetting>();
const defaultValues = defaults('');
$effect.pre(() => {
	const saved = new Map(config?.audio_inputs?.map((input) => [input.id, input]));
	untrack(() => {
		for (const id of new Set([...lastSaved.keys(), ...saved.keys()])) {
			const before = lastSaved.get(id) ?? defaultValues;
			const after = saved.get(id) ?? defaultValues;
			for (const field of VALUE_FIELDS) {
				if (before[field] === after[field]) continue;
				const key = fieldKey(id, field);
				broadcasts.set(key, (broadcasts.get(key) ?? 0) + 1);
				appliedValues.delete(key);
				if (field === 'gain_db') gainSent[id] = after.gain_db;
			}
		}
		lastSaved = saved;
	});
});

$effect.pre(() => {
	const epoch = liveEpoch;
	untrack(() => {
		for (const [key, state] of intents)
			if (state.epoch !== epoch) intents.delete(key);
		for (const [key, state] of appliedValues)
			if (state.epoch !== epoch) appliedValues.delete(key);
		for (const [key, state] of errors)
			if (state.epoch !== epoch) errors.delete(key);
	});
	// A queued live intent ends with its session or this component.
	return () => {
		for (const id of Object.keys(gainTimer)) {
			clearTimeout(gainTimer[id]);
			gainTimer[id] = undefined;
			dragging[id] = false;
			dropDraft(id);
		}
		for (const id of Object.keys(gainSent)) delete gainSent[id];
		for (const id of Object.keys(gainSentAt)) delete gainSentAt[id];
	};
});

function shown(id: string): AudioInputSetting {
	const entry = { ...entryFor(id) };
	for (const field of VALUE_FIELDS) {
		const applied = appliedValues.get(fieldKey(id, field));
		if (applied !== undefined && applied.epoch === liveEpoch) Object.assign(entry, applied.values);
	}
	return entry;
}

function pendingDelta(id: string, field: Field): Delta | undefined {
	const intent = intents.get(fieldKey(id, field));
	return intent !== undefined && intent.epoch === liveEpoch ? intent.delta : undefined;
}

function setError(id: string, field: Field, token: string | undefined): void {
	errors.set(fieldKey(id, field), { id, field, token: token ?? 'refused', epoch: liveEpoch });
}

function fieldDescription(id: string, field: Field, fallback?: string): string | undefined {
	const error = errors.get(fieldKey(id, field));
	if (error === undefined || error.epoch !== liveEpoch) return fallback;
	const errorId = fieldErrorId(id, field);
	return fallback === undefined ? errorId : `${fallback} ${errorId}`;
}

const fieldErrorId = (id: string, field: Field) => `${uid}-error-${encodeURIComponent(id)}-${field}`;

const ERROR_COPY: Record<string, () => string> = {
	audio_mix_unsupported: () => m['live.audioMixer.error.audio_mix_unsupported'](),
	audio_input_unknown: () => m['live.audioMixer.error.audio_input_unknown'](),
	audio_input_primary: () => m['live.audioMixer.error.audio_input_primary'](),
	audio_inputs_empty: () => m['live.audioMixer.error.audio_inputs_empty'](),
	audio_input_duplicate: () => m['live.audioMixer.error.audio_input_duplicate'](),
	audio_inputs_too_many: () => m['live.audioMixer.error.audio_inputs_too_many'](),
	audio_tracks_invalid: () => m['live.audioMixer.error.audio_tracks_invalid'](),
	audio_tracks_gap: () => m['live.audioMixer.error.audio_tracks_gap'](),
	audio_gain_range: () =>
		m['live.audioMixer.error.audio_gain_range']({
			min: mix?.gain_db_min ?? 0,
			max: mix?.gain_db_max ?? 0,
		}),
	audio_delay_range: () =>
		m['live.audioMixer.error.audio_delay_range']({ max: mix?.delay_ms_max ?? 0 }),
	[SAVE_FAILED]: () => m['notifications.saveFailed'](),
};

// An unmapped token is an engine refusal: honest generic copy, never the token.
function errorCopy(token: string): string {
	return Object.hasOwn(ERROR_COPY, token)
		? (ERROR_COPY[token] as () => string)()
		: m['live.audioMixer.error.refused']();
}

// The backend's track rule, in its order: every input needs distinct tracks
// within 1..max_tracks, and together they must use 1..k with no gap.
function tracksError(next: readonly AudioInputSetting[]): string | undefined {
	const maxTracks = mix?.max_tracks ?? 0;
	const used = new Set<number>();
	for (const input of next) {
		if (
			input.tracks.length === 0 ||
			new Set(input.tracks).size !== input.tracks.length ||
			input.tracks.some((track) => !Number.isInteger(track) || track < 1 || track > maxTracks)
		)
			return 'audio_tracks_invalid';
		for (const track of input.tracks) used.add(track);
	}
	for (let track = 1; track <= used.size; track++) {
		if (!used.has(track)) return 'audio_tracks_gap';
	}
	return undefined;
}

async function edit(id: string, field: Field, delta: Delta): Promise<void> {
	const key = fieldKey(id, field);
	const seq = ++generation;
	const epoch = liveEpoch;
	const sentAt = broadcasts.get(key);
	const current = () => intents.get(key)?.generation === seq && epoch === liveEpoch;
	intents.set(key, { id, delta, generation: seq, epoch });
	if (epoch !== undefined && delta.gain_db !== undefined) gainSent[id] = delta.gain_db;
	errors.delete(key);
	try {
		const result = await rpc.streaming.setAudioMix({ id, ...delta });
		if (!current()) return;
		if (!result.success) {
			setError(id, field, result.error);
			if (field === 'gain_db') delete gainSent[id];
		} else if (
			field !== 'include' &&
			typeof field !== 'number' &&
			result.applied !== undefined &&
			sentAt === broadcasts.get(key)
		) {
			// A broadcast that changed this field, including a clear, wins over its late reply.
			appliedValues.set(key, { values: { [field]: result.applied[field] }, epoch });
			if (field === 'gain_db' && epoch !== undefined) gainSent[id] = result.applied.gain_db;
		}
	} catch {
		if (current()) {
			setError(id, field, SAVE_FAILED);
			if (field === 'gain_db') delete gainSent[id];
		}
	} finally {
		if (current()) {
			intents.delete(key);
			if (field === 'gain_db' && !dragging[id]) dropDraft(id);
		}
	}
}

function toggleInput(id: string, on: boolean): void {
	if (isStreaming || id === primaryId) return;
	if (on && (!hasPrimary || full)) return;
	void edit(id, 'include', { include: on });
}

function toggleTrack(id: string, track: number): void {
	if (isStreaming) return;
	const on = !entryFor(id).tracks.includes(track);
	const next = inputs.map((entry) => entry.id === id ? withTrack(entry, track, on) : entry);
	// With an excluded leg the backend knows which gaps predate this edit.
	const refusal = excluded.length ? undefined : tracksError(next);
	if (refusal !== undefined) {
		setError(id, track, refusal);
		return;
	}
	void edit(id, track, { track: { number: track, on } });
}

// The level previews while it moves. Live, it is sent at most every
// GAIN_SEND_INTERVAL_MS while dragging and once more on release; idle, it is
// saved once, on release.
let gainDraft = $state<Record<string, number>>({});
const gainSentAt: Record<string, number> = {};
const gainTimer: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const dragging: Record<string, boolean> = {};

function dropDraft(id: string): void {
	if (!(id in gainDraft)) return;
	const { [id]: _dropped, ...rest } = gainDraft;
	gainDraft = rest;
}

// A level control that goes away mid-drag (its strip leaves, or its input leaves
// the mix) never sees its release: end that drag, so the level shows the device's
// values again when the control returns. Same condition the markup renders it on.
$effect(() => {
	const controls = new Set(
		mix === undefined
			? []
			: strips.filter((strip) => isEnabled(strip.id)).map((strip) => strip.id),
	);
	untrack(() => {
		for (const id of Object.keys(gainDraft)) {
			if (controls.has(id)) continue;
			dragging[id] = false;
			clearTimeout(gainTimer[id]);
			gainTimer[id] = undefined;
			dropDraft(id);
		}
	});
});

function latestSentGain(id: string): number | undefined {
	return pendingDelta(id, 'gain_db')?.gain_db ?? gainSent[id];
}

function sendGain(id: string): void {
	const value = gainDraft[id];
	// A queued level is sent only while its session is still live.
	if (!mixLive || value === undefined || value === latestSentGain(id)) return;
	gainSentAt[id] = Date.now();
	void edit(id, 'gain_db', { gain_db: value });
}

function moveGain(id: string, value: number): void {
	if (valuesLocked) return;
	dragging[id] = true;
	gainDraft = { ...gainDraft, [id]: value };
	if (!mixLive || gainTimer[id] !== undefined) return;
	const wait = (gainSentAt[id] ?? Number.NEGATIVE_INFINITY) + GAIN_SEND_INTERVAL_MS - Date.now();
	if (wait <= 0) {
		sendGain(id);
		return;
	}
	const epoch = liveEpoch;
	gainTimer[id] = setTimeout(() => {
		gainTimer[id] = undefined;
		if (epoch === liveEpoch) sendGain(id);
	}, wait);
}

function commitGain(id: string, value: number): void {
	if (valuesLocked) return;
	dragging[id] = false;
	clearTimeout(gainTimer[id]);
	gainTimer[id] = undefined;
	if (mixLive) {
		gainDraft = { ...gainDraft, [id]: value };
		if (value !== latestSentGain(id)) sendGain(id);
		else if (pendingDelta(id, 'gain_db') === undefined) dropDraft(id);
		return;
	}
	dropDraft(id);
	if (value !== (pendingDelta(id, 'gain_db')?.gain_db ?? shown(id).gain_db))
		void edit(id, 'gain_db', { gain_db: value });
}

function resetGain(id: string): void {
	if (valuesLocked) return;
	void edit(id, 'gain_db', { gain_db: 0 });
}

function toggleMute(id: string): void {
	if (valuesLocked) return;
	const mute = !(pendingDelta(id, 'mute')?.mute ?? shown(id).mute);
	void edit(id, 'mute', { mute });
}

function changeDelay(id: string, field: HTMLInputElement): void {
	if (valuesLocked) return;
	const raw = field.value.trim();
	const value = Number(raw);
	const max = mix?.delay_ms_max ?? 0;
	if (raw === '' || !Number.isInteger(value) || value < 0 || value > max) {
		setError(id, 'delay_ms', 'audio_delay_range');
		field.value = String(pendingDelta(id, 'delay_ms')?.delay_ms ?? shown(id).delay_ms);
		return;
	}
	void edit(id, 'delay_ms', { delay_ms: value });
}

function formatDb(value: number): string {
	return `${value > 0 ? '+' : ''}${value} dB`;
}

function levelOf(id: string) {
	if (!getIsConnected()) return undefined;
	return getAudioLevel()?.inputs?.find((input) => input.input_id === id);
}

const nextStartId = `${uid}-next-start`;
const headingId = `${uid}-heading`;
</script>

{#if mix}
	<div class="space-y-3" data-testid="audio-mixer">
		<div class="space-y-1">
			<h3 class="text-sm font-medium" id={headingId}>{m['live.audioMixer.label']()}</h3>
			{#if isStreaming}
				<p
					class="text-muted-foreground text-xs"
					data-testid="audio-mixer-next-start"
					id={nextStartId}
				>
					{m['live.encoder.appliesNextStart']()}
				</p>
			{/if}
		</div>

		{#if !isStreaming && !hasPrimary}
			<!-- No strip carries today's meter, so it stays above the strips. -->
			<LiveAudioMeter />
		{/if}

		<ul aria-labelledby={headingId} class="divide-y border-y">
			{#each [...strips, ...excluded] as strip, index (strip.id)}
				{const unavailable = $derived('reason' in strip ? strip.reason : undefined)}
				{const isPrimary = $derived(strip.id === primaryId)}
				{const enabled = $derived(isEnabled(strip.id))}
				{const values = $derived(shown(strip.id))}
				{const gain = $derived(gainDraft[strip.id] ?? pendingDelta(strip.id, 'gain_db')?.gain_db ?? values.gain_db)}
				{const muted = $derived(pendingDelta(strip.id, 'mute')?.mute ?? values.mute)}
				{const delay = $derived(pendingDelta(strip.id, 'delay_ms')?.delay_ms ?? values.delay_ms)}
				{const reading = $derived(levelOf(strip.id))}
				{const reasonId = `${uid}-reason-${index}`}
				{const reason = $derived.by(() => {
					if (unavailable === 'unplugged') return m['live.audioMixer.unplugged']();
					if (unavailable) return m['live.audioMixer.otherSource']({ source: strip.label });
					if (isPrimary) return m['live.audioMixer.primary']();
					if (enabled || isStreaming) return undefined;
					if (!hasPrimary) return m['live.audioMixer.needsPrimary']();
					return full ? errorCopy('audio_inputs_too_many') : undefined;
				})}
				{const describedBy = $derived(
					[reason === undefined ? undefined : reasonId, isStreaming ? nextStartId : undefined]
						.filter(Boolean)
						.join(' ') || undefined,
				)}
				<li
					class="space-y-3 py-3"
					data-audio-strip={strip.id}
					data-enabled={enabled ? 'true' : 'false'}
					data-testid={`audio-strip-${strip.id}`}
				>
					<div class="flex items-center gap-3">
						<div class="min-w-0 flex-1 space-y-0.5">
							<p
								class="truncate text-sm font-medium {enabled ? '' : 'text-muted-foreground'}"
								title={strip.label}
							>
								{strip.label}
							</p>
							{#if reason !== undefined}
								<p
									class="text-muted-foreground text-xs"
									data-testid={`audio-strip-reason-${strip.id}`}
									id={reasonId}
								>
									{reason}
								</p>
							{/if}
						</div>
						{#if unavailable}
							{const removeLabel = $derived(m['live.audioMixer.remove']())}
							<Button
								aria-describedby={fieldDescription(strip.id, 'include', describedBy)}
								aria-label={`${removeLabel} ${strip.label}`}
								class="min-h-(--touch-target-min) min-w-(--touch-target-min)"
								disabled={pendingDelta(strip.id, 'include') !== undefined}
								onclick={() => void edit(strip.id, 'include', { include: false })}
								size="sm"
								variant="outline"
							>
								{removeLabel}
							</Button>
						{:else}
							<Switch
								aria-describedby={fieldDescription(strip.id, 'include', describedBy)}
								aria-label={m['live.audioMixer.enable']({ name: strip.label })}
								checked={enabled}
								data-testid={`audio-strip-enable-${strip.id}`}
								disabled={isPrimary || isStreaming || (!enabled && (!hasPrimary || full))}
								onCheckedChange={(on) => toggleInput(strip.id, on)}
							/>
						{/if}
					</div>

					{#if !unavailable && !isStreaming}
						{#if isPrimary}
							<LiveAudioMeter />
						{:else}
							<p class="text-muted-foreground text-xs">
								{m['live.audioMixer.meterWhenLive']()}
							</p>
						{/if}
					{:else if !unavailable && mixLive && enabled}
						<AudioLevelMeter
							peakDb={reading?.peak_db ?? []}
							rmsDb={reading?.rms_db ?? []}
							unavailable={reading === undefined}
						/>
					{/if}

					{#if !unavailable && enabled}
						<div class="flex items-center gap-3">
							<span class="text-muted-foreground w-10 shrink-0 text-xs font-medium">
								{m['live.audioMixer.gain']()}
							</span>
							<LabeledSlider
								data-testid={`audio-strip-gain-${strip.id}`}
								describedBy={fieldDescription(strip.id, 'gain_db', describedBy)}
								disabled={valuesLocked}
								label={m['live.audioMixer.gainFor']({ name: strip.label })}
								max={mix.gain_db_max}
								min={mix.gain_db_min}
								onValueChange={(value) => moveGain(strip.id, value)}
								onValueCommit={(value) => commitGain(strip.id, value)}
								step={1}
								value={gain}
								valueText={formatDb(gain)}
							/>
							<!-- A signed measurement keeps its own order in right-to-left locales. -->
							<span
								class="bg-primary/10 text-primary w-16 shrink-0 rounded-md px-2 py-1 text-center font-mono text-xs tabular-nums"
								data-testid={`audio-strip-gain-value-${strip.id}`}
								dir="ltr"
							>
								{formatDb(gain)}
							</span>
							<Button
								aria-describedby={fieldDescription(strip.id, 'gain_db', describedBy)}
								aria-label={m['live.audioMixer.gainReset']({ name: strip.label })}
								class="min-w-(--touch-target-min)"
								data-testid={`audio-strip-gain-reset-${strip.id}`}
								disabled={valuesLocked}
								onclick={() => resetGain(strip.id)}
								size="icon-sm"
								variant="ghost"
							>
								<RotateCcw aria-hidden={true} class="rtl:-scale-x-100" />
							</Button>
						</div>

						<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
							<Button
								aria-describedby={fieldDescription(strip.id, 'mute', describedBy)}
								aria-label={m['live.audioMixer.muteFor']({ name: strip.label })}
								aria-pressed={muted}
								class={muted
									? 'border-status-warning/60 bg-status-warning/15 hover:bg-status-warning/20'
									: ''}
								data-testid={`audio-strip-mute-${strip.id}`}
								disabled={valuesLocked}
								onclick={() => toggleMute(strip.id)}
								size="sm"
								variant="outline"
							>
								{#if muted}
									<!-- The tint and the icon carry the warning; the word stays foreground (AA). -->
									<VolumeX aria-hidden={true} class="text-status-warning" />
								{:else}
									<Volume2 aria-hidden={true} />
								{/if}
								{m['live.audioMixer.mute']()}
							</Button>

							<div class="flex items-center gap-2">
								<span class="text-muted-foreground text-xs font-medium" aria-hidden="true">
									{m['live.audioMixer.delay']()}
								</span>
								<Input
									aria-describedby={fieldDescription(strip.id, 'delay_ms', describedBy)}
									aria-label={m['live.audioMixer.delayFor']({ name: strip.label })}
									class="min-h-(--touch-target-min) w-20 font-mono tabular-nums"
									data-testid={`audio-strip-delay-${strip.id}`}
									disabled={valuesLocked}
									inputmode="numeric"
									max={mix.delay_ms_max}
									min={0}
									onchange={(event) => changeDelay(strip.id, event.currentTarget)}
									step={DELAY_STEP_MS}
									type="number"
									value={delay}
								/>
								<span class="text-muted-foreground font-mono text-xs" aria-hidden="true">ms</span>
							</div>

							<fieldset class="m-0 flex min-w-0 items-center gap-2 border-0 p-0">
								<legend class="sr-only">
									{m['live.audioMixer.tracksFor']({ name: strip.label })}
								</legend>
								<span class="text-muted-foreground text-xs font-medium" aria-hidden="true">
									{m['live.audioMixer.tracks']()}
								</span>
								{#each Array.from({ length: mix.max_tracks }, (_, i) => i + 1) as track (track)}
									{const on = $derived(values.tracks.includes(track))}
									<Button
										aria-describedby={fieldDescription(strip.id, track, isStreaming ? nextStartId : undefined)}
										aria-label={m['live.audioMixer.track']({ n: track })}
										aria-pressed={on}
										class="min-w-(--touch-target-min) font-mono {on
											? 'bg-primary/10 text-primary ring-primary hover:bg-primary/15 hover:text-primary ring-1'
											: 'text-muted-foreground'}"
										data-testid={`audio-strip-track-${strip.id}-${track}`}
										disabled={isStreaming}
										onclick={() => toggleTrack(strip.id, track)}
										size="icon-sm"
										variant="outline"
									>
										{track}
									</Button>
								{/each}
							</fieldset>
						</div>
					{/if}

					<!-- Mounted for the strip's whole life, so a refusal is announced the
					     moment it lands, and described only by the control it concerns. -->
					<div aria-live="assertive" data-testid={`audio-strip-error-${strip.id}`} role="alert">
						{#each [...errors.values()].filter((error) => error.id === strip.id && error.epoch === liveEpoch) as error (error.field)}
							<div
								class="border-status-warning/50 bg-status-warning/10 flex items-start gap-2 rounded-lg border p-2.5"
							>
								<Activity aria-hidden={true} class="text-status-warning mt-0.5 size-4 shrink-0" />
								<p class="text-foreground min-w-0 text-xs" id={fieldErrorId(strip.id, error.field)}>
									{errorCopy(error.token)}
								</p>
							</div>
						{/each}
					</div>
				</li>
			{/each}
		</ul>

		<p class="text-muted-foreground text-xs" data-testid="audio-mixer-track-hint">
			{m['live.audioMixer.trackHint']()}
		</p>
	</div>
{/if}
