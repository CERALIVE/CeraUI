<!--
  SourceSection.svelte — unified Source surface for the Live destination (Task 8).

  Brings the hotplug VIDEO input picker and the pipeline-reported AUDIO source
  into one coherent section, fronted by a compact capability summary
  (res / fps / codec / audio) derived from the engine `get-capabilities`
  broadcast, and an explicit lost-device explanation (badge + body + recovery
  hint) instead of a silent "Lost" label.

  Composition, not a new subsystem: the video block is the existing InputPicker;
  the audio block reuses the pipeline source list. Audio selection is PRE-START
  only — live audio switching is gated (Task 10), so while streaming (or with a
  single source) the audio source renders READ-ONLY, never a misleading dropdown.

  Presentational: every datum + handler is a prop, so it renders deterministically
  under vitest with no subscription/runtime dependency.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type {
	ActiveEncode,
	CaptureDevice,
	CapabilitiesMessage,
	ConfigMessage,
} from '@ceraui/rpc/schemas';
import { TriangleAlert, Video, Volume2 } from '@lucide/svelte';

import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import InputPicker from '$lib/components/custom/InputPicker.svelte';
import SourcePreference from '$lib/components/custom/SourcePreference.svelte';
import * as Card from '$lib/components/ui/card';
import * as Select from '$lib/components/ui/select';
import type { FailoverEvent } from '$lib/streaming/source-preference';
import {
	deriveActiveSummary,
	deriveCapabilitySummary,
	formatCodec,
	resolveAudioSourceMode,
	resolveDisplayedAudioSource,
} from '$lib/streaming/sourceSummary';

interface Props {
	// ── Video (forwarded to InputPicker) ──
	devices?: CaptureDevice[];
	activeInput?: string | undefined;
	selectedInput?: string | undefined;
	isStreaming?: boolean;
	switchingInput?: string | undefined;
	/** Forwarded to InputPicker: gates the live audio-switch affordance (G2). */
	audioLiveSwitchEnabled?: boolean;
	/** Forwarded to InputPicker: field-sync key driving the audio-switch glyph. */
	audioLiveSwitchField?: string;
	onSelect?: (id: string) => void;
	onSwitch?: (id: string) => void;
	// ── Audio ──
	audioSources?: string[];
	selectedAudioSource?: string | undefined;
	onSelectAudioSource?: (id: string) => void;
	// ── Capability summary ──
	capabilities?: CapabilitiesMessage | undefined;
	// ── Active-config truth (Todo 23) ──
	/** Saved config — the IDLE source of res/fps/codec/transport. */
	config?: ConfigMessage | undefined;
	/** Engine `active_encode` — WINS while streaming (engine truth over requested). */
	activeEncode?: ActiveEncode | null | undefined;
	// ── Source preference + fallback state (Task 11) ──
	sourceOrder?: string[];
	sourceFailover?: FailoverEvent | null;
	sourcePreferenceField?: string;
	onReorderSource?: (id: string, direction: 'up' | 'down') => void;
}

let {
	devices = [],
	activeInput,
	selectedInput,
	isStreaming = false,
	switchingInput,
	audioLiveSwitchEnabled = false,
	audioLiveSwitchField,
	onSelect,
	onSwitch,
	audioSources = [],
	selectedAudioSource,
	onSelectAudioSource,
	capabilities,
	config,
	activeEncode,
	sourceOrder = [],
	sourceFailover = null,
	sourcePreferenceField = 'source_preference',
	onReorderSource,
}: Props = $props();

// Capability summary (res / fps / codec / audio) — compact, telemetry-style.
const summary = $derived(deriveCapabilitySummary(capabilities));
const capChips = $derived.by(() => {
	if (!summary) return [] as string[];
	const chips: string[] = [];
	if (summary.maxResolution) chips.push(summary.maxResolution);
	if (summary.maxFramerate) chips.push(`${summary.maxFramerate}fps`);
	for (const codec of summary.codecs) chips.push(formatCodec(codec));
	return chips;
});

// Active-config truth (Todo 23): engine `active_encode` while streaming, else the
// saved config. Distinct from the capability chips above — these are settings.
const activeSummary = $derived(deriveActiveSummary(config, activeEncode, capabilities));
const activeParts = $derived.by(() => {
	const parts: string[] = [];
	if (activeSummary.source) parts.push(activeSummary.source);
	if (activeSummary.resolution) parts.push(activeSummary.resolution);
	if (typeof activeSummary.framerate === 'number') parts.push(`${activeSummary.framerate}fps`);
	if (activeSummary.codec) parts.push(activeSummary.codec);
	parts.push(activeSummary.transport);
	return parts;
});
const hasActiveConfig = $derived(
	activeSummary.live ||
		Boolean(activeSummary.source || activeSummary.resolution || activeSummary.codec),
);

// Audio source: single → read-only, multiple → selectable (pre-start only).
const audioMode = $derived(resolveAudioSourceMode(audioSources));
const displayedAudioSource = $derived(
	resolveDisplayedAudioSource(selectedAudioSource, audioSources),
);
// Live audio switch is gated (Task 10): force read-only while streaming.
const audioReadOnly = $derived(audioMode === 'single' || isStreaming);
const audioComingSoon = $derived(isStreaming && audioMode === 'multiple');

// Lost-device explanation: any reported device that vanished mid-session. The
// active source being lost is the critical case but any lost device warrants
// the explicit explanation + recovery hint (not just the per-row "Lost" badge).
const lostDevices = $derived(devices.filter((d) => d.lost));
const hasLostDevice = $derived(lostDevices.length > 0);
</script>

<Card.Root data-testid="source-section">
	<Card.Content class="space-y-5 p-4 sm:p-6">
		<!-- Section header + compact capability summary -->
		<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
			<div class="flex items-center gap-1">
				<Video aria-hidden={true} class="text-primary size-4 shrink-0" />
				<span class="text-sm font-semibold">{$LL.live.source.label()}</span>
				<InfoPopover
					body={$LL.live.education.field.source.body()}
					testId="info-source"
					title={$LL.live.education.field.source.title()}
				/>
			</div>
			{#if capChips.length || summary?.audioSupported}
				<div
					class="flex flex-wrap items-center gap-1.5"
					data-testid="source-capabilities"
					aria-label={$LL.live.source.capabilities()}
				>
					<span
						class="text-muted-foreground text-[0.65rem] font-semibold tracking-wide uppercase"
						data-testid="cap-device-max"
					>
						{$LL.live.source.deviceMax()}
					</span>
					<InfoPopover
						body={$LL.live.education.field.mode.body()}
						testId="info-mode"
						title={$LL.live.education.field.mode.title()}
					/>
					{#each capChips as chip (chip)}
						<span
							class="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs"
						>
							{chip}
						</span>
					{/each}
					{#if summary?.audioSupported}
						<span
							class="bg-primary/10 text-primary inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium"
							data-testid="cap-audio"
						>
							<Volume2 aria-hidden={true} class="size-3" />
							{$LL.settings.audioSource()}
						</span>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Active-config line (Todo 23): what the device is DOING (engine truth while
		     streaming) or the saved config it will start with — visually distinct from
		     the capability chips above, which are the hardware ceiling, not settings. -->
		{#if hasActiveConfig}
			<div
				class="bg-muted/30 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2"
				data-testid="source-active-config"
			>
				<span
					class={`inline-flex items-center gap-1 text-xs font-semibold ${
						activeSummary.live ? 'text-primary' : 'text-muted-foreground'
					}`}
				>
					{#if activeSummary.live}
						<span aria-hidden={true} class="bg-primary size-1.5 rounded-full"></span>
					{/if}
					{activeSummary.live ? $LL.live.source.activeLive() : $LL.live.source.activeConfigured()}
				</span>
				<span class="text-foreground truncate font-mono text-sm" data-testid="active-config-value">
					{activeParts.join(' \u00b7 ')}
				</span>
			</div>
		{/if}

		<!-- Lost-device explanation: explicit badge + body + recovery hint -->
		{#if hasLostDevice}
			<div
				class="border-destructive/30 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3"
				data-testid="source-lost-banner"
				role="status"
			>
				<TriangleAlert aria-hidden={true} class="text-destructive mt-0.5 size-4 shrink-0" />
				<div class="min-w-0 space-y-0.5">
					<p class="text-destructive text-sm font-medium">{$LL.live.source.lostTitle()}</p>
					<p class="text-muted-foreground text-xs">{$LL.live.source.lostBody()}</p>
				</div>
			</div>
		{/if}

		<!-- Video input (hotplug picker, unchanged) -->
		<InputPicker
			{activeInput}
			{audioLiveSwitchEnabled}
			{audioLiveSwitchField}
			{devices}
			{isStreaming}
			{onSelect}
			{onSwitch}
			{selectedInput}
			{switchingInput}
		/>

		<!-- Operator-ordered source preference + fallback state (Task 11) -->
		{#if sourceOrder.length > 0}
			<div class="border-t pt-5">
				<SourcePreference
					{activeInput}
					{devices}
					failover={sourceFailover}
					onReorder={onReorderSource}
					order={sourceOrder}
					syncField={sourcePreferenceField}
				/>
			</div>
		{/if}

		<!-- Audio source -->
		<div class="space-y-2 border-t pt-5" data-testid="source-audio">
			<div class="flex items-center gap-1">
				<Volume2 aria-hidden={true} class="text-muted-foreground size-4 shrink-0" />
				<span class="text-sm font-medium">{$LL.settings.audioSource()}</span>
				<InfoPopover
					body={$LL.live.education.field.audio.body()}
					testId="info-audio"
					title={$LL.live.education.field.audio.title()}
				/>
				{#if audioComingSoon}
					<span
						class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium"
						title={$LL.live.comingSoon.hint()}
					>
						{$LL.live.comingSoon.label()}
					</span>
				{/if}
			</div>

			{#if audioMode === 'none'}
				<p class="text-muted-foreground text-sm" data-testid="audio-source-none">
					{$LL.live.source.audioNone()}
				</p>
			{:else if audioReadOnly}
				<!-- Single source, or streaming (live switch gated) → read-only. -->
				<div
					class="bg-muted/40 flex min-h-11 items-center rounded-lg border px-3 py-2"
					data-testid="audio-source-readonly"
				>
					<span class="truncate font-mono text-sm">
						{displayedAudioSource ?? $LL.live.source.audioNone()}
					</span>
				</div>
			{:else}
				<!-- Multiple sources, pre-start → selectable. -->
				<Select.Root
					onValueChange={(value) => onSelectAudioSource?.(value)}
					type="single"
					value={selectedAudioSource}
				>
					<Select.Trigger
						class="min-h-11 w-full"
						data-testid="audio-source-select"
						id="sourceAudioSelect"
					>
						{displayedAudioSource ?? $LL.settings.selectAudioSource()}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each audioSources as source (source)}
								<Select.Item label={source} value={source}></Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			{/if}
		</div>
	</Card.Content>
</Card.Root>
