<!--
  AudioMixer.svelte — one strip per audio input (Live screen contract, change 4).

  Renders NOTHING unless the engine advertises `audio_mix`: an engine that
  cannot mix leaves no node behind. SourceSection mounts it in the idle Audio
  card under the picker; LiveCockpit mounts it in the live `audio-card`.

  Every bound is the capability's: gain from `gain_db_min` to `gain_db_max`,
  delay from 0 to `delay_ms_max`, one chip per track up to `max_tracks`, and at
  most `max_inputs` enabled strips. The input picked above is the main input:
  its strip is always on, and it is in the mix Start sends even when the saved
  mix lacks it (the backend's effective mix); showing it never saves anything.

  Idle, a change saves `streaming.setConfig({ audio_inputs })` with every enabled
  strip, main input first, and `null` once only the main input is left at its
  defaults (the backend's own rule, so a default setup stays on today's path).
  Live on a mix session (`status.audio_mix_active`), level, mute and delay go to
  `streaming.setAudioMix` and the device's applied values win; membership and
  tracks wait for the next start. Live without a mix, every control waits.

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
import { AUDIO_SOURCE_AUTO } from '@ceraui/rpc/schemas';
import { Activity, RotateCcw, Volume2, VolumeX } from '@lucide/svelte';
import { Slider as SliderPrimitive } from 'bits-ui';

import AudioLevelMeter from '$lib/components/preview/AudioLevelMeter.svelte';
import LiveAudioMeter from '$lib/components/preview/LiveAudioMeter.svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Switch } from '$lib/components/ui/switch';
import { rpc } from '$lib/rpc';
import {
	getAudioLevel,
	getIsConnected,
	getSources,
	getStatus,
} from '$lib/rpc/subscriptions.svelte';
import { defaultAudioInput as defaults, effectiveAudioInputs } from '$lib/streaming/audio-mix';
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

const mix = $derived(capabilities?.audio_mix);
const status = $derived(getStatus());
const mixLive = $derived(isStreaming && status?.audio_mix_active === true);
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
		.filter((source) => source.kind === 'device' && source.unavailable_reason === undefined)
		.map((source) => ({ id: source.id, label: audioSourceLabel(source, t) }));
	return embeddedId === undefined
		? devices
		: [{ id: embeddedId, label: m['live.source.audioEmbedded']() }, ...devices];
});
const hasPrimary = $derived(strips.some((strip) => strip.id === primaryId));

// An idle save not answered yet shows as the choice; `null` is a save of null.
let pending = $state<AudioInputSetting[] | null | undefined>(undefined);
let saveSeq = 0;

const inputs = $derived.by(() => {
	const source = pending !== undefined ? pending : config?.audio_inputs;
	return (
		effectiveAudioInputs(source, hasPrimary ? primaryId : undefined, mix?.max_inputs ?? 0) ??
		(hasPrimary && primaryId !== undefined ? [defaults(primaryId)] : [])
	);
});

function isEnabled(id: string): boolean {
	return id === primaryId || inputs.some((input) => input.id === id);
}

function entryFor(id: string): AudioInputSetting {
	return inputs.find((input) => input.id === id) ?? defaults(id);
}

const enabledCount = $derived(strips.filter((strip) => isEnabled(strip.id)).length);
const full = $derived(mix !== undefined && enabledCount >= mix.max_inputs);

// The device's answer to the latest live change, per input; it wins over the
// saved value until the session ends.
let liveApplied = $state<Record<string, Values>>({});
$effect(() => {
	if (!mixLive) liveApplied = {};
});

function shown(id: string): AudioInputSetting {
	const entry = entryFor(id);
	const applied = mixLive ? liveApplied[id] : undefined;
	return applied === undefined ? entry : { ...entry, ...applied };
}

let errors = $state<Record<string, string>>({});

function setError(id: string, token: string | undefined): void {
	errors = { ...errors, [id]: token ?? 'refused' };
}

function clearError(id: string): void {
	if (!(id in errors)) return;
	const { [id]: _cleared, ...rest } = errors;
	errors = rest;
}

const ERROR_COPY: Record<string, () => string> = {
	audio_mix_unsupported: () => m['live.audioMixer.error.audio_mix_unsupported'](),
	audio_input_unknown: () => m['live.audioMixer.error.audio_input_unknown'](),
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

function isDefault(input: AudioInputSetting): boolean {
	return (
		input.gain_db === 0 &&
		!input.mute &&
		input.delay_ms === 0 &&
		input.tracks.length === 1 &&
		input.tracks[0] === 1
	);
}

/** Every enabled strip after `change`, main input first. */
function nextInputs(
	change: (entries: AudioInputSetting[]) => AudioInputSetting[],
): AudioInputSetting[] {
	const enabled = strips.filter((strip) => isEnabled(strip.id)).map((strip) => entryFor(strip.id));
	return change(enabled).sort(
		(a, b) => Number(b.id === primaryId) - Number(a.id === primaryId),
	);
}

async function save(id: string, next: AudioInputSetting[]): Promise<void> {
	const only = next[0];
	const value =
		next.length === 0 ||
		(next.length === 1 && only !== undefined && only.id === primaryId && isDefault(only))
			? null
			: next;
	const seq = ++saveSeq;
	pending = value;
	clearError(id);
	try {
		const result = await rpc.streaming.setConfig({ audio_inputs: value });
		if (!result.success) setError(id, result.error);
	} catch {
		setError(id, SAVE_FAILED);
	} finally {
		if (seq === saveSeq) pending = undefined;
	}
}

function saveEntry(id: string, fields: Partial<AudioInputSetting>): void {
	void save(
		id,
		nextInputs((entries) =>
			entries.map((entry) => (entry.id === id ? { ...entry, ...fields } : entry)),
		),
	);
}

function toggleInput(id: string, on: boolean): void {
	if (isStreaming || id === primaryId) return;
	if (on && (!hasPrimary || full)) return;
	void save(
		id,
		nextInputs((entries) =>
			on ? [...entries, defaults(id)] : entries.filter((entry) => entry.id !== id),
		),
	);
}

function toggleTrack(id: string, track: number): void {
	if (isStreaming) return;
	const next = nextInputs((entries) =>
		entries.map((entry) =>
			entry.id !== id
				? entry
				: {
						...entry,
						tracks: entry.tracks.includes(track)
							? entry.tracks.filter((existing) => existing !== track)
							: [...entry.tracks, track].sort((a, b) => a - b),
					},
		),
	);
	const refusal = tracksError(next);
	if (refusal !== undefined) {
		setError(id, refusal);
		return;
	}
	void save(id, next);
}

// Live writes: the latest answer per input wins; an older one is dropped.
const liveSeq: Record<string, number> = {};
const inflight: Record<string, number> = {};

async function sendLive(id: string, update: Omit<SetAudioMixInput, 'id'>): Promise<void> {
	const seq = (liveSeq[id] ?? 0) + 1;
	liveSeq[id] = seq;
	inflight[id] = (inflight[id] ?? 0) + 1;
	clearError(id);
	try {
		const result = await rpc.streaming.setAudioMix({ id, ...update });
		if (seq !== liveSeq[id]) return;
		if (!result.success) {
			setError(id, result.error);
			delete gainSent[id];
		} else if (result.applied !== undefined) {
			const { gain_db, mute, delay_ms } = result.applied;
			liveApplied = { ...liveApplied, [id]: { gain_db, mute, delay_ms } };
			gainSent[id] = gain_db;
		}
	} catch {
		if (seq === liveSeq[id]) {
			setError(id, SAVE_FAILED);
			delete gainSent[id];
		}
	} finally {
		inflight[id] = (inflight[id] ?? 1) - 1;
		if (seq === liveSeq[id] && !dragging[id]) dropDraft(id);
	}
}

// The level previews while it moves. Live, it is sent at most every
// GAIN_SEND_INTERVAL_MS while dragging and once more on release; idle, it is
// saved once, on release.
let gainDraft = $state<Record<string, number>>({});
const gainSent: Record<string, number> = {};
const gainSentAt: Record<string, number> = {};
const gainTimer: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const dragging: Record<string, boolean> = {};

function dropDraft(id: string): void {
	if (!(id in gainDraft)) return;
	const { [id]: _dropped, ...rest } = gainDraft;
	gainDraft = rest;
}

function sendGain(id: string): void {
	const value = gainDraft[id];
	if (value === undefined || value === gainSent[id]) return;
	gainSentAt[id] = Date.now();
	gainSent[id] = value;
	void sendLive(id, { gain_db: value });
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
	gainTimer[id] = setTimeout(() => {
		gainTimer[id] = undefined;
		sendGain(id);
	}, wait);
}

function commitGain(id: string, value: number): void {
	if (valuesLocked) return;
	dragging[id] = false;
	clearTimeout(gainTimer[id]);
	gainTimer[id] = undefined;
	if (mixLive) {
		gainDraft = { ...gainDraft, [id]: value };
		if (value !== gainSent[id]) sendGain(id);
		else if (!inflight[id]) dropDraft(id);
		return;
	}
	dropDraft(id);
	if (value !== entryFor(id).gain_db) saveEntry(id, { gain_db: value });
}

function resetGain(id: string): void {
	if (valuesLocked) return;
	if (mixLive) void sendLive(id, { gain_db: 0 });
	else saveEntry(id, { gain_db: 0 });
}

function toggleMute(id: string): void {
	if (valuesLocked) return;
	const mute = !shown(id).mute;
	if (mixLive) void sendLive(id, { mute });
	else saveEntry(id, { mute });
}

function changeDelay(id: string, field: HTMLInputElement): void {
	if (valuesLocked) return;
	const raw = field.value.trim();
	const value = Number(raw);
	const max = mix?.delay_ms_max ?? 0;
	if (raw === '' || !Number.isInteger(value) || value < 0 || value > max) {
		setError(id, 'audio_delay_range');
		field.value = String(shown(id).delay_ms);
		return;
	}
	if (mixLive) void sendLive(id, { delay_ms: value });
	else saveEntry(id, { delay_ms: value });
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
			{#each strips as strip, index (strip.id)}
				{const isPrimary = $derived(strip.id === primaryId)}
				{const enabled = $derived(isEnabled(strip.id))}
				{const values = $derived(shown(strip.id))}
				{const gain = $derived(gainDraft[strip.id] ?? values.gain_db)}
				{const reading = $derived(levelOf(strip.id))}
				{const reasonId = `${uid}-reason-${index}`}
				{const reason = $derived(
					isPrimary
						? m['live.audioMixer.primary']()
						: enabled || isStreaming
							? undefined
							: !hasPrimary
								? m['live.audioMixer.needsPrimary']()
								: full
									? errorCopy('audio_inputs_too_many')
									: undefined,
				)}
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
						<Switch
							aria-describedby={describedBy}
							aria-label={m['live.audioMixer.enable']({ name: strip.label })}
							checked={enabled}
							data-testid={`audio-strip-enable-${strip.id}`}
							disabled={isPrimary || isStreaming || (!enabled && (!hasPrimary || full))}
							onCheckedChange={(on) => toggleInput(strip.id, on)}
						/>
					</div>

					{#if !isStreaming}
						{#if isPrimary}
							<LiveAudioMeter />
						{:else}
							<p class="text-muted-foreground font-mono text-[11px] tracking-wide">
								{m['live.audioMixer.meterWhenLive']()}
							</p>
						{/if}
					{:else if mixLive && enabled}
						<AudioLevelMeter
							peakDb={reading?.peak_db ?? []}
							rmsDb={reading?.rms_db ?? []}
							unavailable={reading === undefined}
						/>
					{/if}

					{#if enabled}
						<div class="flex items-center gap-3">
							<span class="text-muted-foreground w-10 shrink-0 text-xs font-medium">
								{m['live.audioMixer.gain']()}
							</span>
							<SliderPrimitive.Root
								class="relative flex min-h-6 w-full min-w-0 touch-none items-center select-none data-disabled:opacity-50"
								data-slot="slider"
								data-testid={`audio-strip-gain-${strip.id}`}
								disabled={valuesLocked}
								max={mix.gain_db_max}
								min={mix.gain_db_min}
								onValueChange={(value: number) => moveGain(strip.id, value)}
								onValueCommit={(value: number) => commitGain(strip.id, value)}
								step={1}
								type="single"
								value={gain}
							>
								{#snippet children({ thumbItems })}
									<span
										class="bg-muted relative h-1 w-full grow overflow-hidden rounded-full"
										data-slot="slider-track"
									>
										<SliderPrimitive.Range class="bg-primary absolute h-full select-none" />
									</span>
									{#each thumbItems as thumb (thumb.index)}
										<SliderPrimitive.Thumb
											aria-describedby={describedBy}
											aria-label={m['live.audioMixer.gainFor']({ name: strip.label })}
											aria-valuetext={formatDb(gain)}
											class="border-ring ring-ring/50 relative block size-3 shrink-0 rounded-full border bg-white transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50"
											data-slot="slider-thumb"
											index={thumb.index}
										/>
									{/each}
								{/snippet}
							</SliderPrimitive.Root>
							<!-- A signed measurement keeps its own order in right-to-left locales. -->
							<span
								class="bg-primary/10 text-primary w-16 shrink-0 rounded-md px-2 py-1 text-center font-mono text-xs tabular-nums"
								data-testid={`audio-strip-gain-value-${strip.id}`}
								dir="ltr"
							>
								{formatDb(gain)}
							</span>
							<Button
								aria-describedby={describedBy}
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
								aria-describedby={describedBy}
								aria-label={m['live.audioMixer.muteFor']({ name: strip.label })}
								aria-pressed={values.mute}
								class={values.mute
									? 'border-status-warning/60 bg-status-warning/15 text-status-warning hover:bg-status-warning/20 hover:text-status-warning'
									: ''}
								data-testid={`audio-strip-mute-${strip.id}`}
								disabled={valuesLocked}
								onclick={() => toggleMute(strip.id)}
								size="sm"
								variant="outline"
							>
								{#if values.mute}
									<VolumeX aria-hidden={true} />
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
									aria-describedby={describedBy}
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
									value={values.delay_ms}
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
										aria-describedby={isStreaming ? nextStartId : undefined}
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
					     moment it lands, below the controls it concerns. -->
					<div aria-live="assertive" data-testid={`audio-strip-error-${strip.id}`} role="alert">
						{#if errors[strip.id] !== undefined}
							<div
								class="border-status-warning/50 bg-status-warning/10 flex items-start gap-2 rounded-lg border p-2.5"
							>
								<Activity aria-hidden={true} class="text-status-warning mt-0.5 size-4 shrink-0" />
								<p class="text-foreground min-w-0 text-xs">{errorCopy(errors[strip.id] as string)}</p>
							</div>
						{/if}
					</div>
				</li>
			{/each}
		</ul>

		<p class="text-muted-foreground text-xs" data-testid="audio-mixer-track-hint">
			{m['live.audioMixer.trackHint']()}
		</p>
	</div>
{/if}
