<!--
  LatencySection.svelte — the single honest tuning control.

  Latency is the SRT ARQ retransmit budget — the one real knob. Reliability is
  automatic (ARQ over SRTLA bonding, always on), so this replaces the old Stream
  Tuning card: no FEC, recovery, presets, banner, or cloud-override. The slider
  window (`range`) comes from `deriveLatencyRange` (engine caps or the default),
  never an inline literal. While streaming the pill reads back the negotiated
  value and the slider is locked (apply-on-reconnect).
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { LatencyRange } from '@ceraui/rpc/schemas';

import { Label } from '$lib/components/ui/label';

interface Props {
	latencyMs: number;
	range: LatencyRange;
	effectiveLatencyMs?: number | undefined;
	isStreaming?: boolean;
	onLatencyChange: (value: number) => void;
}

let { latencyMs, range, effectiveLatencyMs, isStreaming = false, onLatencyChange }: Props =
	$props();

const LATENCY_STEP = 50;

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
</script>

<div class="space-y-2.5" data-testid="latency-section">
	<div class="flex items-center justify-between gap-2">
		<Label class="text-sm font-medium" for="latency-slider">
			{$LL.settings.latency()}
		</Label>
		<span class="flex items-center gap-1.5">
			{#if showingNegotiated}
				<span class="text-muted-foreground text-micro uppercase tracking-wide">
					{$LL.settings.latencyNegotiated()}
				</span>
			{/if}
			<span
				class="bg-primary/10 text-primary rounded-md px-2 py-1 font-mono text-xs"
				data-testid="latency-value"
			>
				{formatSeconds(displayLatencyMs)}
			</span>
		</span>
	</div>
	<div class="relative h-10 w-full">
		<div class="bg-muted absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full"></div>
		<div
			class="bg-primary absolute top-1/2 h-2 -translate-y-1/2 rounded-full transition-all duration-150"
			style={`inset-inline-start: 0; width: ${latencyPercent}%;`}
		></div>
		<input
			id="latency-slider"
			aria-label={$LL.settings.latency()}
			aria-valuemax={range.max}
			aria-valuemin={range.min}
			aria-valuenow={sliderLatency}
			aria-valuetext={formatSeconds(displayLatencyMs)}
			class="peer absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
			data-testid="latency-slider"
			disabled={isStreaming}
			max={range.max}
			min={range.min}
			oninput={(e) => onLatencyChange(Number.parseInt(e.currentTarget.value, 10))}
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
