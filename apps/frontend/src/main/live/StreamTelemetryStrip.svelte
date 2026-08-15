<script lang="ts">
import { LL } from '@ceraui/i18n/i18n-svelte5';

import EncoderStatus from '$lib/components/custom/EncoderStatus.svelte';
import type { EncoderLoadReading } from '$lib/streaming/encoder-load';

interface Props {
	/**
	 * The headline rate, already formatted: the MEASURED bond throughput when
	 * `bitrateMeasured` is true, otherwise the engine's target.
	 */
	bitrate: string;
	/**
	 * Whether `bitrate` is a real measurement. Drives the heading, because a
	 * setpoint rendered under a "Bitrate" label is the lie this card exists to
	 * stop telling — it reads the same whether media is flowing or not.
	 */
	bitrateMeasured?: boolean;
	/**
	 * The engine's target, formatted — supplied ONLY when the measurement has
	 * taken the headline, so the setpoint stays visible as context instead of
	 * masquerading as the reading.
	 */
	bitrateTarget?: string | undefined;
	/**
	 * The configured ceiling, formatted — supplied ONLY while the engine is
	 * proven to be encoding below it, so the operator can see their setting was
	 * honoured as a limit rather than ignored. Absent otherwise.
	 */
	bitrateLimit?: string | undefined;
	// Every value above is a bitrate, which is exactly why NONE of them may be
	// rendered as a bare number beside another. An operator reported reading
	// "1.8 Mbps  Target 1.6 Mbps / 4.5 Mbps" as one figure plus a fraction, and
	// asked what the third number counted. So each carries its own word label,
	// the headline says WHICH KIND of bitrate it is ("Sending" vs "Target"), and
	// the two qualifiers drop to their own line rather than sharing the
	// headline's baseline.
	tempSensor?: string;
	uptimeSensor?: string;
	/**
	 * Per-core encoder load — the TYPED reading, not a formatted string.
	 * Pre-formatting it in LiveView would flatten the three-state model into
	 * text and let the two densities drift apart; the strip stays store-free and
	 * hands the reading straight to the same widget Settings renders.
	 */
	encoderLoad?: EncoderLoadReading | undefined;
}

const {
	bitrate,
	bitrateMeasured = false,
	bitrateTarget,
	bitrateLimit,
	tempSensor,
	uptimeSensor,
	encoderLoad,
}: Props = $props();
</script>

<!-- Live telemetry strip — only meaningful while streaming -->
<section
	aria-label={$LL.live.overview()}
	class="bg-card flex flex-wrap items-center gap-x-10 gap-y-4 rounded-xl border px-5 py-4"
>
	<div class="space-y-1">
		<p
			class="text-muted-foreground text-xs font-medium tracking-wide uppercase"
			data-testid="telemetry-bitrate-heading"
			title={bitrateMeasured ? $LL.hud.bitrateMeasuredHint() : $LL.hud.bitrateTargetHint()}
		>
			{bitrateMeasured ? $LL.hud.bitrateSending() : $LL.hud.bitrateTarget()}
		</p>
		<p class="font-mono text-lg font-semibold">
			<span data-testid="telemetry-bitrate" style="color: var(--status-live);">{bitrate}</span>
		</p>
		{#if bitrateTarget || bitrateLimit}
			<p class="text-muted-foreground/70 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
				{#if bitrateTarget}
					<span data-testid="telemetry-bitrate-target" title={$LL.hud.bitrateTargetHint()}>
						{$LL.hud.bitrateTarget()}
						<span class="font-mono">{bitrateTarget}</span>
					</span>
				{/if}
				{#if bitrateTarget && bitrateLimit}
					<span aria-hidden="true" class="text-muted-foreground/40">·</span>
				{/if}
				{#if bitrateLimit}
					<span data-testid="telemetry-bitrate-limit" title={$LL.hud.bitrateBelowLimitHint()}>
						{$LL.hud.bitrateLimit()}
						<span class="font-mono">{bitrateLimit}</span>
					</span>
				{/if}
			</p>
		{/if}
	</div>
	{#if tempSensor}
		<div class="space-y-1">
			<p class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
				{$LL.hud.temperature()}
			</p>
			<p class="font-mono text-lg font-semibold">{tempSensor}</p>
		</div>
	{/if}
	{#if uptimeSensor}
		<div class="space-y-1">
			<p class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
				{$LL.hud.uptime()}
			</p>
			<p class="font-mono text-lg font-semibold">{uptimeSensor}</p>
		</div>
	{/if}
	{#if encoderLoad}
		<!--
			The encoder cell lives HERE, in the cockpit body, and never in HudBar or
			its expanded Sheet: the persistent strip is capped at four facts, and the
			Sheet is that cap's overflow rather than a general telemetry drawer.
			This container already wraps, so the fourth cell degrades by wrapping
			instead of overflowing the 1024x600 kiosk viewport.
		-->
		<div class="min-w-0 space-y-1" data-testid="telemetry-encoder">
			<p class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
				{$LL.hud.encoder()}
			</p>
			<EncoderStatus density="inline" reading={encoderLoad} />
		</div>
	{/if}
</section>
