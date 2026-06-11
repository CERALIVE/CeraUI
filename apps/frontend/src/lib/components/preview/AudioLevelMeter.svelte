<!--
  AudioLevelMeter.svelte — per-channel RMS/peak audio meter for the live preview.

  Presentational: consumes the dBFS arrays from the cerastream `audio-level` event
  (per-channel, range (-inf, 0]; digital silence serialises as -1e6 per ADR-0002
  preview-ws addendum) and renders one horizontal bar per channel — an RMS fill
  with a peak tick. All datum is a prop, so it renders deterministically under
  vitest with no socket dependency. CSS transitions drive the bar motion, so the
  e-ink freeze stills them automatically (never JS-drive these).
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

import { cn } from '$lib/utils';

interface Props {
	rmsDb?: number[];
	peakDb?: number[];
	class?: string;
}

const { rmsDb = [], peakDb = [], class: className = undefined }: Props = $props();

// dBFS window mapped to the bar: -60 dBFS reads empty, 0 dBFS reads full.
const FLOOR_DB = -60;

function fraction(db: number | undefined): number {
	if (db === undefined || !Number.isFinite(db) || db <= FLOOR_DB) return 0;
	if (db >= 0) return 1;
	return (db - FLOOR_DB) / -FLOOR_DB;
}

const channelCount = $derived(Math.max(rmsDb.length, peakDb.length));

const channels = $derived(
	Array.from({ length: channelCount }, (_, i) => {
		const rms = fraction(rmsDb[i]);
		const peak = fraction(peakDb[i]);
		return { rms, peak };
	}),
);

const silent = $derived(channels.length === 0 || channels.every((c) => c.peak === 0));
</script>

<div
	data-testid="audio-level-meter"
	data-silent={silent ? 'true' : 'false'}
	data-channels={channelCount}
	class={cn('space-y-1.5', className)}
	role="group"
	aria-label={$LL.live.preview.audioLabel()}
>
	{#if silent}
		<p class="text-muted-foreground font-mono text-[11px] tracking-wide" data-testid="audio-silent">
			{$LL.live.preview.audioSilent()}
		</p>
	{:else}
		{#each channels as channel, i (i)}
			{@const clipping = channel.peak >= 0.97}
			<div
				class="bg-muted/60 relative h-2 overflow-hidden rounded-full"
				data-testid="audio-channel"
				data-channel-index={i}
				role="meter"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(channel.rms * 100)}
				aria-label={$LL.live.preview.channelAria({ n: i + 1 })}
			>
				<div
					class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-150 ease-out"
					style={`width:${channel.rms * 100}%;background-color:${clipping ? 'var(--status-error)' : 'var(--status-live)'};`}
				></div>
				<div
					class="absolute inset-y-0 w-0.5 transition-[left] duration-150 ease-out"
					style={`left:calc(${channel.peak * 100}% - 1px);background-color:${clipping ? 'var(--status-error)' : 'var(--status-standby)'};`}
				></div>
			</div>
		{/each}
	{/if}
</div>
