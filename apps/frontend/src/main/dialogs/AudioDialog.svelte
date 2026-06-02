<!--
  AudioDialog.svelte — focused audio-configuration dialog for the Live destination.

  Rebuild of the old `main/shared/AudioCard.svelte` audio block as a self-contained
  dialog composed on the shared `AppDialog` chrome (Task 18). Three controls:
    • Audio source  — Select over the pipeline-reported sources (status.asrcs).
    • Audio codec   — Select (opus / aac / pcm) over the device-supported codecs.
    • Audio delay   — center-zero slider, bounds driven by
                      `streamingConstraints.audioDelay.{min,max}` (no literals).

  Validation is now EXPLICIT, not implicit: when the selected pipeline supports
  audio but no source is chosen, a visible inline error is rendered AND the Save
  action is disabled — the field is never silently hidden or bypassed.

  Persistence: Save persists the audio fields via `rpc.streaming.setConfig`
  (no stream restart) and also commits them optimistically to the caller via
  `onSave` so the Live summary updates immediately. Audio is locked while
  streaming (matching the original card's `disabled` behaviour); the Live row's
  lock policy hides the Edit trigger mid-stream, so Save only runs while idle.
  The codec RPC itself is untouched.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { AudioCodec } from '@ceraui/rpc/schemas';
import { Volume2 } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { AppDialog } from '$lib/components/dialogs';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { streamingConstraints } from '$lib/components/streaming/ValidationAdapter';
import {
	resolveAudioGateState,
	resolveAudioPipelineKey,
} from '$lib/streaming/audioGate';
import { rpc } from '$lib/rpc';
import {
	getAudioCodecs,
	getConfig,
	getIsStreaming,
	getPipelines,
	getStatus,
} from '$lib/rpc/subscriptions.svelte';

export interface AudioConfigValues {
	asrc: string | undefined;
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
}

let {
	open = $bindable(false),
	audioSource,
	audioCodec,
	audioDelay,
	effectivePipeline,
	onSave,
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
const isStreaming = $derived(getIsStreaming());

// Gate follows the DRAFTED encoder pipeline first, the saved config second —
// so picking an audio-capable pipeline in the Encoder dialog clears the gate
// immediately, without waiting for a stream (re)start to persist it.
const pipelineKey = $derived(
	resolveAudioPipelineKey(effectivePipeline, config?.pipeline),
);
const gateState = $derived(resolveAudioGateState(pipelineKey, pipelines));
const hasAudioSupport = $derived(gateState === 'enabled');

// ---- Draft state (seeded from props each time the dialog opens) ----
let draftSource = $state<string | undefined>(undefined);
let draftCodec = $state<AudioCodec | undefined>(undefined);
let draftDelay = $state(0);
let wasOpen = $state(false);

$effect(() => {
	if (open && !wasOpen) {
		// Opening: seed the draft from the effective current values.
		draftSource = audioSource;
		draftCodec = audioCodec ?? 'aac';
		draftDelay = clampDelay(audioDelay ?? 0);
	}
	wasOpen = open;
});

// A source the saved config references but the pipeline no longer reports.
const notAvailableAudioSource = $derived(
	draftSource && !audioSources.includes(draftSource) ? draftSource : undefined,
);

// EXPLICIT required-source validation (visible, never silently hidden).
const sourceMissing = $derived(hasAudioSupport && !draftSource);
const saveDisabled = $derived(!hasAudioSupport || sourceMissing || isStreaming);

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

const sourceTriggerLabel = $derived(
	!draftSource
		? $LL.settings.selectAudioSource()
		: draftSource === notAvailableAudioSource
			? `${draftSource} (${$LL.settings.notAvailableAudioSource()})`
			: draftSource,
);
const codecTriggerLabel = $derived(
	draftCodec && audioCodecs
		? (audioCodecs[draftCodec]?.name ?? $LL.settings.selectAudioCodec())
		: $LL.settings.selectAudioCodec(),
);

async function handleSave() {
	if (saveDisabled) return;
	const values: AudioConfigValues = {
		asrc: draftSource,
		acodec: draftCodec ?? 'aac',
		delay: draftDelay,
	};
	// Optimistic local commit so the Live summary updates immediately…
	onSave?.(values);
	// …then persist via the dedicated config RPC (no stream restart).
	try {
		await rpc.streaming.setConfig({
			asrc: values.asrc,
			acodec: values.acodec,
			delay: values.delay,
		});
	} catch {
		toast.error($LL.notifications.saveFailed());
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
		<!-- No pipeline drafted or saved yet — audio cannot be configured. -->
		<div class="bg-muted/50 rounded-lg px-4 py-3 text-center">
			<p class="text-muted-foreground text-sm">{$LL.settings.selectPipelineFirst()}</p>
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

			<!-- Audio Source -->
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="audioSource">
					{$LL.settings.audioSource()}
				</Label>
				<Select.Root
					disabled={isStreaming}
					onValueChange={(value) => (draftSource = value)}
					type="single"
					value={draftSource}
				>
					<Select.Trigger
						id="audioSource"
						aria-invalid={sourceMissing}
						class="w-full {sourceMissing ? 'border-destructive' : ''}"
					>
						{sourceTriggerLabel}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each audioSources as source (source)}
								<Select.Item label={source} value={source}></Select.Item>
							{/each}
							{#if notAvailableAudioSource}
								<Select.Item
									label={`${notAvailableAudioSource} (${$LL.settings.notAvailableAudioSource()})`}
									value={notAvailableAudioSource}
								></Select.Item>
							{/if}
						</Select.Group>
					</Select.Content>
				</Select.Root>
				{#if sourceMissing}
					<!-- EXPLICIT inline error: audio supported but no source chosen. -->
					<p class="text-destructive flex items-center gap-1.5 text-sm" role="alert">
						{$LL.settings.errors.audioSourceRequired()}
					</p>
				{/if}
			</div>

			<!-- Audio Codec (depends on a chosen source) -->
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="audioCodec">
					{$LL.settings.audioCodec()}
				</Label>
				<Select.Root
					disabled={isStreaming || !draftSource}
					onValueChange={(value) => (draftCodec = value as AudioCodec)}
					type="single"
					value={draftCodec}
				>
					<Select.Trigger id="audioCodec" class="w-full">
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

			<!-- Audio Delay (schema-driven center-zero slider) -->
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
							class="bg-muted absolute inset-y-0 top-1/2 right-0 left-0 h-2 -translate-y-1/2 rounded-full"
						></div>
						<!-- Center marker (zero) -->
						<div
							style={`left: ${zeroPct}%;`}
							class="bg-muted-foreground/40 absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2"
						></div>
						<!-- Fill from zero toward thumb -->
						{#if fillWidth > 0}
							<div
								style={`left: ${fillLeft}%; width: ${fillWidth}%;`}
								class={`absolute top-1/2 h-2 -translate-y-1/2 rounded-full transition-all duration-200 ${
									draftDelay < 0 ? 'bg-muted-foreground' : 'bg-primary'
								}`}
							></div>
						{/if}
						<!-- Thumb -->
						<div
							style={`left: ${thumbPct}%; transition: left 200ms ease-out, background-color 200ms ease-out;`}
							class={`border-background absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md transition-all duration-200 ${
								draftDelay === 0
									? 'bg-muted-foreground'
									: draftDelay < 0
										? 'bg-muted-foreground'
										: 'bg-primary'
							} ${isStreaming ? '' : 'cursor-pointer hover:scale-110'}`}
						></div>
						<!-- Interaction layer -->
						<input
							id="audioDelay"
							class="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
							disabled={isStreaming}
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
