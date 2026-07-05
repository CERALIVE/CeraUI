<!--
  AudioDialog.svelte — focused audio-configuration dialog for the Live destination.

  Scoped to ENCODING knobs only (Task 15): the audio-source SELECTION now lives
  exclusively in the unified Source section (`SourceSection.svelte`, the sole
  `asrc` writer). This dialog is a read-only CONSUMER of the active audio source
  and owns just two controls:
    • Audio codec  — Select (opus / aac / pcm) over the device-supported codecs.
    • Audio delay  — center-zero slider, bounds driven by
                     `streamingConstraints.audioDelay.{min,max}` (no literals).

  Above them a READ-ONLY line surfaces the active audio source (device label or
  the embedded-stream state) with a "change it in the Source section" hint — the
  operator changes the source there, not here. The `hasAudioSupport` gate (from
  `resolveAudioGateState`) is preserved verbatim.

  Persistence: Save persists the audio fields via `rpc.streaming.setConfig`
  (no stream restart) and also commits them optimistically to the caller via
  `onSave` so the Live summary updates immediately. `handleSave` writes ONLY
  `acodec`/`delay` — `asrc` is never in its payload. Audio is locked while
  streaming (the Live row's lock policy hides the Edit trigger mid-stream, so
  Save only runs while idle). Federation tolerance: the dialog mounts and saves
  with `asrc` absent from config.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { AudioCodec } from '@ceraui/rpc/schemas';
import { AUDIO_SOURCE_AUTO } from '@ceraui/rpc/schemas';
import { Volume2 } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import { AppDialog } from '$lib/components/dialogs';
import ComingSoon from '$lib/components/custom/ComingSoon.svelte';
import { Button } from '$lib/components/ui/button';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { streamingConstraints } from '$lib/components/streaming/ValidationAdapter';
import {
	resolveAudioGateState,
	resolveAudioPipelineKey,
} from '$lib/streaming/audioGate';
import {
	audioSourceLabel,
	resolveAudioSourceList,
	resolvedAudioLabel,
} from '$lib/streaming/sourceSummary';
import { rpc } from '$lib/rpc';
import { markPending, onRpcResolved } from '$lib/rpc/dirty-registry.svelte';
import {
	getAudioCodecs,
	getCapabilities,
	getConfig,
	getIsStreaming,
	getPipelines,
	getStatus,
} from '$lib/rpc/subscriptions.svelte';

export interface AudioConfigValues {
	/**
	 * Optional (Task 15): this dialog NEVER writes `asrc` — the Source section is
	 * the sole `asrc` writer. Kept optional so the shared override type used by
	 * LiveView's inline source-pick still carries it.
	 */
	asrc?: string;
	acodec: AudioCodec;
	delay: number;
}

interface Props {
	open?: boolean;
	/** Effective current values (override-or-config) seeded into the draft on open. */
	audioSource?: string;
	audioCodec?: AudioCodec;
	audioDelay?: number;
	/**
	 * Effective encoder pipeline driving the audio gate: the DRAFTED encoder
	 * source first, the saved config pipeline as fallback. When omitted the gate
	 * falls back to the saved device config alone.
	 */
	effectivePipeline?: string;
	/** Commit handler — receives the validated draft when Save is pressed. */
	onSave?: (values: AudioConfigValues) => void;
	/**
	 * Opens the Encoder dialog from the no-video-source gate (Todo 26): audio can
	 * only be configured once the encoder has a video source, so the gate offers a
	 * direct jump instead of leaving the operator to hunt for it.
	 */
	onOpenEncoder?: () => void;
}

let {
	open = $bindable(false),
	audioSource,
	audioCodec,
	audioDelay,
	effectivePipeline,
	onSave,
	onOpenEncoder,
}: Props = $props();

// Schema-driven slider bounds — single source of truth, zero literals.
const DELAY_MIN = streamingConstraints.audioDelay.min;
const DELAY_MAX = streamingConstraints.audioDelay.max;
const DELAY_STEP = 5;

// Live device state (non-deprecated subscriptions getters).
const config = $derived(getConfig());
const pipelines = $derived(getPipelines()?.pipelines);
const audioCodecs = $derived(getAudioCodecs());
const audioSources = $derived(getStatus()?.asrcs ?? []);
const audioSourceList = $derived(getStatus()?.audio_sources);
const capabilities = $derived(getCapabilities());
const isStreaming = $derived(getIsStreaming());

// Gate follows the DRAFTED encoder pipeline first, the saved config second —
// so picking an audio-capable pipeline in the Encoder dialog clears the gate
// immediately, without waiting for a stream (re)start to persist it.
const pipelineKey = $derived(
	resolveAudioPipelineKey(effectivePipeline, config?.pipeline),
);
const gateState = $derived(resolveAudioGateState(pipelineKey, pipelines));
const hasAudioSupport = $derived(gateState === 'enabled');

// Typed audio-source model (Task 13): pseudo-sources translated + grouped last,
// device entries keep their hardware name + backend order. Used ONLY to resolve
// the READ-ONLY active-source label — the selection itself lives in SourceSection.
const audioSourceEntries = $derived(resolveAudioSourceList(audioSourceList, audioSources));

// Embedded network-ingest audio (Task 13): with the `network_embedded_audio`
// capability, an rtmp/srt pipeline routes its muxed audio and the source is
// read-only; without it the ALSA picker stays and we show a ComingSoon pill.
const selectedPipelineAudioKind = $derived(
	pipelineKey ? pipelines?.[pipelineKey]?.audio_kind : undefined,
);
const audioEmbeddedActive = $derived(
	selectedPipelineAudioKind === 'embedded' && capabilities?.network_embedded_audio === true,
);
const audioEmbeddedComingSoon = $derived(
	selectedPipelineAudioKind === 'embedded' && capabilities?.network_embedded_audio !== true,
);

// ---- Draft state (seeded from props each time the dialog opens) ----
// `asrc` is NO LONGER drafted here — the Source section owns it.
let draftCodec = $state<AudioCodec | undefined>(undefined);
let draftDelay = $state(0);
let wasOpen = $state(false);

$effect(() => {
	if (open && !wasOpen) {
		// Opening: seed the draft from the effective current values.
		draftCodec = audioCodec ?? 'aac';
		draftDelay = clampDelay(audioDelay ?? 0);
	}
	wasOpen = open;
});

// The ACTIVE audio source (effective override-or-config value from the caller).
// Federation-tolerant: `undefined` when `asrc` is absent from config.
const activeAudioSource = $derived(audioSource);

// Save gate: the audio-support gate + streaming lock. Source selection is no
// longer validated here (the Source section owns it), so no source-missing block.
const saveDisabled = $derived(!hasAudioSupport || isStreaming);

// Reason for the locked codec select: streaming (cannot apply without a restart)
// or no active source yet. Mirrors the Select.Root `disabled` condition.
const codecHasSource = $derived(audioEmbeddedActive || Boolean(activeAudioSource));
const codecDisabledReason = $derived(
	isStreaming
		? $LL.settings.codecDisabledReason.streaming()
		: !codecHasSource
			? $LL.settings.codecDisabledReason.noSource()
			: undefined,
);

function clampDelay(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(DELAY_MIN, Math.min(DELAY_MAX, value));
}

// Center-zero slider geometry — generalised over the schema bounds.
const delayRange = DELAY_MAX - DELAY_MIN;
function pct(value: number): number {
	const p = ((clampDelay(value) - DELAY_MIN) / delayRange) * 100;
	return Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 50;
}
const zeroPct = $derived(pct(0));
const thumbPct = $derived(pct(draftDelay));
const fillLeft = $derived(Math.min(zeroPct, thumbPct));
const fillWidth = $derived(Math.abs(thumbPct - zeroPct));

// i18n key resolver (mirrors the EncoderDialog helper) — lets the pure
// sourceSummary helpers resolve localized keys without a store/rune dependency.
const t = (key: string): string => {
	const parts = key.split('.');
	let result: unknown = $LL;
	for (const part of parts) {
		if (result && typeof result === 'object' && part in result) {
			result = (result as Record<string, unknown>)[part];
		} else {
			return key;
		}
	}
	return typeof result === 'function' ? (result as () => string)() : key;
};

// Resolved-audio display (single owner): an active Auto selection surfaces
// "Auto → device"; the embedded reason surfaces the embedded state.
const resolvedAudio = $derived(
	resolvedAudioLabel({ asrc: activeAudioSource }, getStatus(), audioSourceEntries, t),
);

// READ-ONLY label for the active audio source: the embedded-stream state, the
// resolved "Auto → device" preview, an em-dash for an unresolved Auto (old
// backend), the resolved device/pseudo-source label, or a calm "none" fallback
// when `asrc` is absent (federation tolerance).
const activeAudioSourceLabel = $derived.by(() => {
	if (audioEmbeddedActive || resolvedAudio.embedded) return $LL.live.source.audioEmbedded();
	if (resolvedAudio.current) return resolvedAudio.current;
	if (activeAudioSource === AUDIO_SOURCE_AUTO) return '\u2014';
	if (!activeAudioSource) return $LL.settings.noAudioSourceSelected();
	const entry = audioSourceEntries.find((e) => e.id === activeAudioSource);
	return entry ? audioSourceLabel(entry, t) : activeAudioSource;
});
const codecTriggerLabel = $derived(
	draftCodec && audioCodecs
		? (audioCodecs[draftCodec]?.name ?? $LL.settings.selectAudioCodec())
		: $LL.settings.selectAudioCodec(),
);

async function handleSave() {
	if (saveDisabled) return;
	// Codec + delay ONLY — `asrc` is NEVER in this payload (the Source section
	// is the sole `asrc` writer).
	const values: AudioConfigValues = {
		acodec: draftCodec ?? 'aac',
		delay: draftDelay,
	};
	// Optimistic local commit so the Live summary updates immediately…
	onSave?.(values);
	// …then persist via the dedicated config RPC (no stream restart). Lock each
	// changed field BEFORE the RPC so a stale echo can't revert the edit, and
	// release after it settles (resolve or reject) to avoid a permanent lock.
	const input = { acodec: values.acodec, delay: values.delay };
	const fields = Object.entries(input).filter(([, value]) => value !== undefined);
	for (const [field, value] of fields) markPending(field, value);
	try {
		await rpc.streaming.setConfig(input);
	} catch {
		toast.error($LL.notifications.saveFailed());
	} finally {
		for (const [field] of fields) onRpcResolved(field);
	}
}
</script>

<AppDialog
	bind:open
	icon={Volume2}
	onPrimary={handleSave}
	primaryDisabled={saveDisabled}
	primaryLabel={$LL.dialogs.save()}
	title={$LL.general.audioSettings()}
>
	{#if gateState === 'no-pipeline'}
		<!-- No video source drafted or saved yet — audio cannot be configured until
		     the encoder has a source. Offer a direct jump to the Encoder dialog. -->
		<div class="bg-muted/50 flex flex-col items-center gap-3 rounded-lg px-4 py-5 text-center">
			<p class="text-muted-foreground text-sm">{$LL.settings.selectPipelineFirst()}</p>
			{#if onOpenEncoder}
				<Button
					data-testid="audio-gate-open-encoder"
					onclick={() => {
						open = false;
						onOpenEncoder?.();
					}}
					size="sm"
					variant="outline"
				>
					{$LL.settings.encoderSettings()}
				</Button>
			{/if}
		</div>
	{:else if gateState === 'no-audio-support'}
		<!-- Selected pipeline has no audio support. -->
		<div class="border-destructive/20 bg-destructive/5 rounded-lg border px-4 py-3">
			<h4 class="text-destructive text-sm font-medium">
				{$LL.settings.noAudioSettingSupport()}
			</h4>
			<p class="text-destructive/80 mt-1 text-xs">
				{$LL.settings.selectedPipelineNoAudio()}
			</p>
		</div>
	{:else}
		<div class="space-y-5">
			{#if isStreaming}
				<!-- Audio is locked while streaming (cannot apply without a restart). -->
				<div class="bg-muted/60 rounded-lg border px-4 py-2.5">
					<p class="text-muted-foreground text-xs">{$LL.settings.changeBitrateNotice()}</p>
				</div>
			{/if}

			<!-- Active audio source (READ-ONLY — the Source section owns the selection) -->
			<div class="space-y-2">
				<div class="flex items-center gap-1">
					<Label class="text-sm font-medium">{$LL.settings.activeAudioSource()}</Label>
					<InfoPopover
						body={$LL.live.education.field.audio.body()}
						testId="info-audio-source"
						title={$LL.live.education.field.audio.title()}
					/>
					{#if audioEmbeddedComingSoon}
						<!-- CI gate static marker (component renders data-debt-id dynamically): data-debt-id="TD-embedded-audio" -->
						<ComingSoon debtId="TD-embedded-audio" label={$LL.live.comingSoon.embeddedAudio()} />
					{/if}
				</div>
				<div
					class="bg-muted/40 flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
					data-testid="audio-source-active"
				>
					<span class="flex items-center gap-2">
						<Volume2 aria-hidden={true} class="text-muted-foreground size-4 shrink-0" />
						<span class="text-sm">{activeAudioSourceLabel}</span>
					</span>
					<span class="text-muted-foreground shrink-0 text-xs">
						{$LL.settings.changeAudioSourceHint()}
					</span>
				</div>
			</div>

			<!-- Audio Codec (depends on the active source) -->
			<div class="space-y-2">
				<div class="flex items-center justify-between gap-2">
					<div class="flex items-center gap-1">
						<Label class="text-sm font-medium" for="audioCodec">
							{$LL.settings.audioCodec()}
						</Label>
						<InfoPopover
							body={$LL.live.education.field.codec.body()}
							testId="info-audio-codec"
							title={$LL.live.education.field.codec.title()}
						/>
					</div>
					{#if isStreaming}
						<!-- CI gate static marker (component renders data-debt-id dynamically): data-debt-id="TD-live-audio-codec" -->
						<ComingSoon debtId="TD-live-audio-codec" />
					{/if}
				</div>
				<Select.Root
					disabled={isStreaming || !codecHasSource}
					onValueChange={(value) => (draftCodec = value as AudioCodec)}
					type="single"
					value={draftCodec}
				>
					<Select.Trigger id="audioCodec" class="w-full" title={codecDisabledReason}>
						{codecTriggerLabel}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each Object.entries(audioCodecs ?? {}) as [codec, meta] (codec)}
								<Select.Item label={meta.name} value={codec}></Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</div>

		<!-- Audio Delay (schema-driven center-zero slider; live-configurable via reload-config.audio.delay_ms) -->
		<div class="bg-muted/40 space-y-3 rounded-lg border p-4">
				<Label class="flex items-center justify-between gap-2 text-sm font-medium" for="audioDelay">
					<span>{$LL.settings.audioDelay()}</span>
					<span class="bg-primary/10 text-primary rounded-md px-2 py-1 font-mono text-xs">
						{draftDelay}ms
					</span>
				</Label>

				<div class="my-3">
					<div
						class="relative h-6 w-full rounded-lg [&:has(input:focus-visible)]:ring-2 [&:has(input:focus-visible)]:ring-ring [&:has(input:focus-visible)]:ring-offset-2"
					>
						<!-- Track -->
						<div
							class="bg-muted absolute inset-x-0 inset-y-0 top-1/2 h-2 -translate-y-1/2 rounded-full"
						></div>
						<!-- Center marker (zero) -->
						<div
							style={`inset-inline-start: ${zeroPct}%;`}
							class="bg-muted-foreground/40 absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rtl:translate-x-1/2"
						></div>
						<!-- Fill from zero toward thumb -->
						{#if fillWidth > 0}
							<div
								style={`inset-inline-start: ${fillLeft}%; width: ${fillWidth}%;`}
								class={`absolute top-1/2 h-2 -translate-y-1/2 rounded-full transition-all duration-200 ${
									draftDelay < 0 ? 'bg-muted-foreground' : 'bg-primary'
								}`}
							></div>
						{/if}
						<!-- Thumb -->
						<div
							style={`inset-inline-start: ${thumbPct}%; transition: inset-inline-start 200ms ease-out, background-color 200ms ease-out;`}
							class={`border-background absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md transition-all duration-200 rtl:translate-x-1/2 ${
								draftDelay === 0
									? 'bg-muted-foreground'
									: draftDelay < 0
										? 'bg-muted-foreground'
										: 'bg-primary'
							} cursor-pointer hover:scale-110`}
						></div>
						<!-- Interaction layer -->
						<input
							id="audioDelay"
							class="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
							max={DELAY_MAX}
							min={DELAY_MIN}
							oninput={(e) => {
								const v = parseInt(e.currentTarget.value, 10);
								if (!Number.isNaN(v)) draftDelay = clampDelay(v);
							}}
							step={DELAY_STEP}
							type="range"
							value={draftDelay}
						/>
					</div>

					<!-- Bound labels (schema-driven) -->
					<div class="text-muted-foreground mt-2 flex items-center justify-between text-xs">
						<span class="flex items-center gap-1">
							<span class="bg-muted-foreground h-2 w-2 rounded-full"></span>
							{DELAY_MIN}
						</span>
						<span class="text-foreground font-medium">{$LL.settings.perfectSync()}</span>
						<span class="flex items-center gap-1">
							+{DELAY_MAX}
							<span class="bg-primary h-2 w-2 rounded-full"></span>
						</span>
					</div>
				</div>

				<p class="text-muted-foreground text-center text-xs">
					{$LL.settings.audioDelayEarly()} ← 0ms → {$LL.settings.audioDelayLate()}
				</p>
			</div>
		</div>
	{/if}
</AppDialog>
