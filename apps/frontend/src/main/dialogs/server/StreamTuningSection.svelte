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
import type {
	StreamProfileId,
	StreamProfilePreset,
	StreamRecoveryPreference,
} from '@ceraui/rpc/schemas';

import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import { Label } from '$lib/components/ui/label';
import { Switch } from '$lib/components/ui/switch';
import type { StreamTuningExperience } from '$lib/streaming/receiver-experience';
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
	/** Active profile id; defaults to the experience's seed profile. */
	activeProfile?: StreamProfileId;
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
	activeProfile,
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

const PROFILE_LABEL_KEYS: Record<StreamProfilePreset, string> = {
	balanced: 'settings.streamTuning.profileNames.balanced',
	'low-latency': 'settings.streamTuning.profileNames.lowLatency',
	resilient: 'settings.streamTuning.profileNames.resilient',
	classic: 'settings.streamTuning.profileNames.classic',
	'low-latency-fec': 'settings.streamTuning.profileNames.lowLatencyFec',
};

const selectedProfile = $derived<StreamProfileId>(activeProfile ?? experience.defaultProfile);

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
const presetsReason = $derived(
	experience.presetsDisabledReasonKey ? t(experience.presetsDisabledReasonKey) : undefined,
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

const rowBase =
	'flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors';
const rowIdle = 'border-border';
const rowDisabled = 'border-border opacity-60';
const segmentBase =
	'flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
</script>

<section
	class="space-y-3 rounded-xl border p-3.5"
	data-receiver-kind={experience.isCeraLiveReceiver ? 'ceralive' : 'non-ceralive'}
	data-testid="stream-tuning"
>
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-1">
			<span class="text-sm font-medium">{$LL.settings.streamTuning.title()}</span>
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
				aria-valuemax={range.max}
				aria-valuemin={range.min}
				aria-valuenow={sliderLatency}
				class="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
				data-testid="stream-tuning-latency-slider"
				disabled={isStreaming}
				max={range.max}
				min={range.min}
				oninput={(e) => onLatencyChange?.(Number.parseInt(e.currentTarget.value, 10))}
				step={LATENCY_STEP}
				type="range"
				value={sliderLatency}
			/>
		</div>
		<div class="text-muted-foreground flex justify-between text-xs">
			<span>{formatSeconds(range.min)} · {$LL.settings.lowerLatency()}</span>
			<span>{$LL.settings.higherLatency()} · {formatSeconds(range.max)}</span>
		</div>
	</div>

	<!-- Profile presets — chips. CeraLive: the advertised set, enabled. Other
	     receivers: Classic only, disabled-with-reason (never hidden). -->
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
			{#each experience.availableProfiles as profile (profile)}
				<button
					aria-pressed={profile === selectedProfile}
					class={cn(
						'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
						profile === selectedProfile
							? 'border-primary bg-primary/10 text-foreground'
							: 'border-border text-muted-foreground hover:text-foreground',
					)}
					data-profile={profile}
					data-testid={`stream-tuning-preset-${profile}`}
					disabled={presetsDisabled}
					title={presetsReason}
					type="button"
				>
					{t(PROFILE_LABEL_KEYS[profile])}
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
			class="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium"
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
					'border-border flex gap-1 rounded-lg border p-1',
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
