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
import { Radio, ShieldCheck } from '@lucide/svelte';
import type { StreamProfileId, StreamProfilePreset } from '@ceraui/rpc/schemas';

import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import { Label } from '$lib/components/ui/label';
import type { StreamTuningExperience } from '$lib/streaming/receiver-experience';
import { cn } from '$lib/utils';

interface Props {
	/** Resolved control state from `deriveStreamTuningExperience`. */
	experience: StreamTuningExperience;
	/** Current SRT latency to display (the slider lands in Task 17). */
	latencyMs: number;
	/** A live stream freezes tuning — every control is additionally locked. */
	isStreaming?: boolean;
	/** Active profile id; defaults to the experience's seed profile. */
	activeProfile?: StreamProfileId;
}

let { experience, latencyMs, isStreaming = false, activeProfile }: Props = $props();

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

const rowBase =
	'flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors';
const rowIdle = 'border-border';
const rowDisabled = 'border-border opacity-60';
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

	<!-- Latency — honoured by every receiver, so always available. -->
	<div class={cn(rowBase, rowIdle)} data-testid="stream-tuning-latency">
		<span class="flex min-w-0 flex-col gap-0.5">
			<span class="text-foreground text-sm font-medium">{$LL.settings.streamTuning.latency()}</span>
			<span class="text-muted-foreground text-xs leading-snug">
				{experience.latencyRange.min}–{experience.latencyRange.max} {$LL.units.ms()}
			</span>
		</span>
		<span class="bg-primary/10 text-primary rounded-md px-2 py-1 font-mono text-xs">
			{latencyMs} {$LL.units.ms()}
		</span>
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

	<!-- FEC — CeraLive + FEC-capable libsrt only; else disabled-with-reason. -->
	<div class={cn(rowBase, fecDisabled ? rowDisabled : rowIdle)}>
		<span class="flex min-w-0 flex-col gap-0.5">
			<span class="text-foreground text-sm font-medium">{$LL.settings.streamTuning.fec()}</span>
			{#if fecReason}
				<span class="text-muted-foreground text-xs leading-snug" data-testid="stream-tuning-fec-reason">
					{fecReason}
				</span>
			{/if}
		</span>
		<button
			aria-disabled={fecDisabled}
			class="border-border text-muted-foreground rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
			data-testid="stream-tuning-fec"
			disabled={fecDisabled}
			title={fecReason}
			type="button"
		>
			{$LL.settings.streamTuning.fec()}
		</button>
	</div>

	<!-- Recovery mode — CeraLive only; else disabled-with-reason. -->
	<div class={cn(rowBase, recoveryDisabled ? rowDisabled : rowIdle)}>
		<span class="flex min-w-0 flex-col gap-0.5">
			<span class="text-foreground text-sm font-medium"
				>{$LL.settings.streamTuning.recoveryMode()}</span
			>
			{#if recoveryReason}
				<span
					class="text-muted-foreground text-xs leading-snug"
					data-testid="stream-tuning-recovery-reason"
				>
					{recoveryReason}
				</span>
			{/if}
		</span>
		<button
			aria-disabled={recoveryDisabled}
			class="border-border text-muted-foreground rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
			data-testid="stream-tuning-recovery"
			disabled={recoveryDisabled}
			title={recoveryReason}
			type="button"
		>
			{$LL.settings.streamTuning.recoveryMode()}
		</button>
	</div>

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
