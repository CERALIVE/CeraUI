<!--
  StreamTuningSection.svelte — the Stream Tuning card (SRT receive profiles).

  Presentational scaffold (Task 16): ServerDialog owns the receiver-capability
  derivation and passes the resolved `experience` (from
  `lib/streaming/receiver-experience` `deriveStreamTuningExperience`). This card
  only renders the two top-level states and the per-control gating.

  Two top-level states, keyed on the receiver kind:
   • CeraLive receiver  — full controls: latency + FEC + recovery mode + the
     profile-preset chips. FEC may still be disabled-with-reason when the
     receiver's libsrt build does not advertise it.
   • non-CeraLive        — latency only; FEC / recovery / presets are shown
     DISABLED with a reason tooltip (never hidden), plus a calm
     "Standard (BELABOX-compatible defaults)" banner.

  The latency, FEC, recovery, and preset CONTROLS themselves are filled in by the
  follow-up tasks (latency slider 17, FEC toggle 18, recovery mode 19, presets
  20). This scaffold establishes the card, the two states, and the
  disabled-with-reason contract; the inner control bodies are placeholders that
  reflect the current value and gating only.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { ChevronDown, Radio, ShieldCheck } from '@lucide/svelte';
import { PRESET_CONFIGS } from '@ceraui/rpc/schemas';
import type { StreamProfileId, StreamRecoveryPreference } from '@ceraui/rpc/schemas';

import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import { Label } from '$lib/components/ui/label';
import { Switch } from '$lib/components/ui/switch';
import {
	getPresetChips,
	matchActivePreset,
	type StreamTuningExperience,
} from '$lib/streaming/receiver-experience';
import { cn } from '$lib/utils';

interface Props {
	/** Resolved control state from `deriveStreamTuningExperience`. */
	experience: StreamTuningExperience;
	/** Current SRT latency the slider reflects (ms). */
	latencyMs: number;
	/** Negotiated latency read back from the device while streaming (ms). */
	effectiveLatencyMs?: number | undefined;
	/** Current FEC toggle value (default OFF). */
	fecEnabled?: boolean;
	/** Current recovery preference (default `standard`). */
	recoveryMode?: StreamRecoveryPreference;
	/** A live stream freezes tuning — every control is additionally locked. */
	isStreaming?: boolean;
	/** Continuous-latency change (ms). */
	onLatencyChange?: (value: number) => void;
	/** FEC toggle change. */
	onFecChange?: (value: boolean) => void;
	/** Recovery-preference change. */
	onRecoveryChange?: (value: StreamRecoveryPreference) => void;
}

let {
	experience,
	latencyMs,
	effectiveLatencyMs,
	fecEnabled = false,
	recoveryMode,
	isStreaming = false,
	onLatencyChange,
	onFecChange,
	onRecoveryChange,
}: Props = $props();

// Slider granularity — a UI step, not a validation bound (those come from
// `experience.latencyRange`). Fine enough to read as continuous, not bucketed.
const LATENCY_STEP = 50;

// Resolve a dot-path i18n key through the typed `$LL` proxy (mirrors the
// TransportBadge / EncoderDialog helper), so the reason copy stays in the i18n
// layer and `receiver-experience.ts` can hand back keys, not strings.
const t = (key: string): string => {
	let result: unknown = $LL;
	for (const part of key.split('.')) {
		if (result && typeof result === 'object' && part in result) {
			result = (result as Record<string, unknown>)[part];
		} else {
			return key;
		}
	}
	return typeof result === 'function' ? (result as () => string)() : key;
};

// A control is interactive only when its capability gate is open AND no stream
// is live. The gate (reason key) comes from the experience; streaming adds a
// blanket lock on top, explained by the dialog's stop-to-change banner.
const fecDisabled = $derived(!experience.fecEnabled || isStreaming);
const recoveryDisabled = $derived(!experience.recoveryModeEnabled || isStreaming);
const presetsDisabled = $derived(!experience.presetsEnabled || isStreaming);

const fecReason = $derived(
	experience.fecDisabledReasonKey ? t(experience.fecDisabledReasonKey) : undefined,
);
const recoveryReason = $derived(
	experience.recoveryModeDisabledReasonKey
		? t(experience.recoveryModeDisabledReasonKey)
		: undefined,
);

// Latency is honoured by every receiver, so the slider is locked only while a
// stream is live. The pill reads the negotiated value back while streaming
// (max(device, listener) applied at reconnect), not the staged slider value.
const range = $derived(experience.latencyRange);
const sliderLatency = $derived(Math.min(Math.max(latencyMs, range.min), range.max));
const showingNegotiated = $derived(isStreaming && effectiveLatencyMs !== undefined);
const displayLatencyMs = $derived(
	showingNegotiated ? (effectiveLatencyMs as number) : sliderLatency,
);
const latencyPercent = $derived(
	range.max > range.min
		? Math.max(0, Math.min(100, ((sliderLatency - range.min) / (range.max - range.min)) * 100))
		: 0,
);
const formatSeconds = (ms: number): string => {
	const seconds = ms / 1000;
	return Number.isInteger(seconds) ? `${seconds} s` : `${seconds.toFixed(1)} s`;
};

const fecChecked = $derived(fecDisabled ? false : fecEnabled);
const activeRecovery = $derived<StreamRecoveryPreference>(
	recoveryMode ?? experience.defaultRecoveryMode,
);

// Preset snap-chips: a named combination of the three controls above. Clicking a
// chip sets all three; the active chip is DERIVED from the live values, so any
// control edit drops the row to "Custom" with no extra wiring.
const presetChips = $derived(getPresetChips(experience));
const activeChip = $derived(
	matchActivePreset({
		latencyMs: sliderLatency,
		fecEnabled: fecChecked,
		recoveryMode: activeRecovery,
	}),
);

function selectPreset(presetId: StreamProfileId): void {
	if (presetId === 'custom') return;
	const preset = PRESET_CONFIGS[presetId];
	onLatencyChange?.(Math.min(Math.max(preset.latencyMs, range.min), range.max));
	onFecChange?.(preset.fecEnabled);
	onRecoveryChange?.(preset.recoveryMode);
}

const rowBase =
	'flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors';
const rowIdle = 'border-border';
const rowDisabled = 'border-border opacity-60';
const segmentBase =
	'flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50';
const focusRing =
	'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';
</script>

<section
	class="space-y-3 rounded-xl border p-3.5"
	aria-labelledby="stream-tuning-title"
	data-receiver-kind={experience.isCeraLiveReceiver ? 'ceralive' : 'non-ceralive'}
	data-testid="stream-tuning"
>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="flex items-center gap-1">
			<span class="text-sm font-medium" id="stream-tuning-title"
				>{$LL.settings.streamTuning.title()}</span
			>
			<InfoPopover
				body={$LL.settings.streamTuning.hint()}
				testId="stream-tuning-info"
				title={$LL.settings.streamTuning.title()}
			/>
		</div>
		{#if experience.isCeraLiveReceiver}
			<span
				class="border-primary/30 bg-primary/10 text-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
				data-testid="stream-tuning-ceralive-badge"
			>
				<ShieldCheck aria-hidden={true} class="text-primary size-3.5" />
				{$LL.settings.streamTuning.ceraliveReceiver()}
			</span>
		{:else}
			<span
				class="border-status-warning/30 bg-status-warning/10 text-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
				data-testid="stream-tuning-belabox-badge"
			>
				<Radio aria-hidden={true} class="text-status-warning size-3.5" />
				{$LL.settings.streamTuning.belaboxBadge()}
			</span>
		{/if}
	</div>

	<!-- Latency — honoured by every receiver, so the slider is enabled for all;
	     a live stream locks it (apply-on-reconnect). The pill reads back the
	     negotiated value while streaming, not the staged slider value. -->
	<div class="space-y-2.5" data-testid="stream-tuning-latency">
		<div class="flex items-center justify-between gap-2">
			<Label class="text-sm font-medium" for="stream-tuning-latency-slider">
				{$LL.settings.streamTuning.latency()}
			</Label>
			<span class="flex items-center gap-1.5">
				{#if showingNegotiated}
					<span class="text-muted-foreground text-[10px] uppercase tracking-wide">
						{$LL.settings.streamTuning.latencyNegotiated()}
					</span>
				{/if}
				<span
					class="bg-primary/10 text-primary rounded-md px-2 py-1 font-mono text-xs"
					data-testid="stream-tuning-latency-value"
				>
					{formatSeconds(displayLatencyMs)}
				</span>
			</span>
		</div>
		<div class="relative h-10 w-full">
			<div class="bg-background absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full"></div>
			<div
				class="bg-primary absolute top-1/2 h-2 -translate-y-1/2 rounded-full transition-all duration-150"
				style={`inset-inline-start: 0; width: ${latencyPercent}%;`}
			></div>
			<input
				id="stream-tuning-latency-slider"
				aria-label={$LL.settings.streamTuning.latency()}
				aria-valuemax={range.max}
				aria-valuemin={range.min}
				aria-valuenow={sliderLatency}
				aria-valuetext={formatSeconds(displayLatencyMs)}
				class="peer absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
				data-testid="stream-tuning-latency-slider"
				disabled={isStreaming}
				max={range.max}
				min={range.min}
				oninput={(e) => onLatencyChange?.(Number.parseInt(e.currentTarget.value, 10))}
				step={LATENCY_STEP}
				type="range"
				value={sliderLatency}
			/>
			<div
				class="ring-ring/70 ring-offset-background pointer-events-none absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2"
			></div>
		</div>
		<div class="text-muted-foreground flex justify-between text-xs">
			<span>{formatSeconds(range.min)} · {$LL.settings.lowerLatency()}</span>
			<span>{$LL.settings.higherLatency()} · {formatSeconds(range.max)}</span>
		</div>
	</div>

	<!-- Preset snap-chips — named saved combinations of latency + FEC + recovery.
	     Clicking a chip sets all three; editing any control drops the active chip
	     to Custom. Capability-unavailable chips are disabled-with-reason, never
	     hidden (e.g. the FEC preset on a non-FEC receiver). -->
	<div class="space-y-1.5">
		<div class="flex items-center gap-1">
			<Label class="text-sm font-medium" id="stream-tuning-presets-label">
				{$LL.settings.streamTuning.presets()}
			</Label>
		</div>
		<div
			aria-labelledby="stream-tuning-presets-label"
			class="flex flex-wrap gap-1.5"
			data-testid="stream-tuning-presets"
			data-disabled={presetsDisabled}
			role="group"
		>
			{#each presetChips as chip (chip.presetId)}
				{@const pressed = chip.presetId === activeChip}
				{@const isCustom = chip.presetId === 'custom'}
				{@const disabled = chip.disabled || isStreaming || (isCustom && !pressed)}
				{@const reason = chip.reasonKey ? t(chip.reasonKey) : undefined}
				<button
					aria-pressed={pressed}
					class={cn(
						'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
						focusRing,
						pressed
							? 'border-primary bg-primary/10 text-foreground'
							: 'border-border text-muted-foreground hover:text-foreground',
					)}
					data-profile={chip.presetId}
					data-testid={`stream-tuning-preset-${chip.presetId}`}
					{disabled}
					onclick={() => selectPreset(chip.presetId)}
					title={reason}
					type="button"
				>
					{t(chip.labelKey)}
				</button>
			{/each}
		</div>
	</div>

	<!-- FEC toggle — default OFF; enabled only on a FEC-capable CeraLive
	     receiver, else disabled-with-reason (never against an unproven receiver). -->
	<div class={cn(rowBase, fecDisabled ? rowDisabled : rowIdle)}>
		<span class="flex min-w-0 flex-col gap-0.5">
			<span class="text-foreground text-sm font-medium">{$LL.settings.streamTuning.fec()}</span>
			<span
				class="text-muted-foreground text-xs leading-snug"
				data-testid="stream-tuning-fec-helper"
			>
				{fecReason ?? $LL.settings.streamTuning.fecHelper()}
			</span>
		</span>
		<Switch
			aria-label={$LL.settings.streamTuning.fec()}
			checked={fecChecked}
			data-testid="stream-tuning-fec"
			disabled={fecDisabled}
			onCheckedChange={(value) => onFecChange?.(value)}
			title={fecReason}
		/>
	</div>

	<!-- Advanced disclosure — Recovery segmented control. CeraLive only; for
	     other receivers it stays present but disabled-with-reason (never hidden). -->
	<details class="border-border group rounded-lg border px-3 py-2" data-testid="stream-tuning-advanced">
		<summary
			class={cn(
				'flex cursor-pointer list-none items-center justify-between gap-2 rounded-md text-sm font-medium',
				focusRing,
			)}
		>
			{$LL.settings.streamTuning.advanced()}
			<ChevronDown
				aria-hidden={true}
				class="text-muted-foreground size-4 transition-transform group-open:rotate-180"
			/>
		</summary>
		<div class="mt-3 space-y-2">
			<Label class="text-sm font-medium" id="stream-tuning-recovery-label">
				{$LL.settings.streamTuning.recovery()}
			</Label>
			<div
				aria-labelledby="stream-tuning-recovery-label"
				class={cn(
					'border-border flex flex-col gap-1 rounded-lg border p-1 sm:flex-row',
					recoveryDisabled && 'opacity-60',
				)}
				data-disabled={recoveryDisabled}
				data-testid="stream-tuning-recovery"
				role="group"
				title={recoveryReason}
			>
				<button
					aria-pressed={activeRecovery === 'standard'}
					class={cn(
						segmentBase,
						activeRecovery === 'standard'
							? 'bg-primary/10 text-foreground'
							: 'text-muted-foreground hover:text-foreground',
					)}
					data-testid="stream-tuning-recovery-standard"
					disabled={recoveryDisabled}
					onclick={() => onRecoveryChange?.('standard')}
					title={recoveryReason}
					type="button"
				>
					{$LL.settings.streamTuning.recoveryStandard()}
					<span class="text-muted-foreground ms-1 text-[10px]">
						{$LL.settings.streamTuning.recoveryStandardHint()}
					</span>
				</button>
				<button
					aria-pressed={activeRecovery === 'bandwidth-saver'}
					class={cn(
						segmentBase,
						activeRecovery === 'bandwidth-saver'
							? 'bg-primary/10 text-foreground'
							: 'text-muted-foreground hover:text-foreground',
					)}
					data-testid="stream-tuning-recovery-bandwidth-saver"
					disabled={recoveryDisabled}
					onclick={() => onRecoveryChange?.('bandwidth-saver')}
					title={recoveryReason}
					type="button"
				>
					{$LL.settings.streamTuning.recoveryBandwidthSaver()}
					<span class="text-muted-foreground ms-1 text-[10px]">
						{$LL.settings.streamTuning.recoveryBandwidthSaverHint()}
					</span>
				</button>
			</div>
			<span class="text-muted-foreground text-xs leading-snug">
				{recoveryReason ?? $LL.settings.streamTuning.recoveryHelper()}
			</span>
		</div>
	</details>

	{#if experience.showBelaboxBanner}
		<div
			class="border-border bg-muted/60 flex items-start gap-2 rounded-lg border px-3 py-2.5"
			data-testid="stream-tuning-belabox-banner"
			role="status"
		>
			<Radio aria-hidden={true} class="text-primary mt-0.5 size-4 shrink-0" />
			<span class="flex min-w-0 flex-col gap-0.5">
				<span class="text-foreground text-sm font-medium"
					>{$LL.settings.streamTuning.belaboxBannerTitle()}</span
				>
				<span class="text-muted-foreground text-xs leading-snug"
					>{$LL.settings.streamTuning.belaboxBannerBody()}</span
				>
			</span>
		</div>
	{/if}
</section>
