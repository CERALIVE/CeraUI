<script lang="ts">
import CardSimIcon from '@lucide/svelte/icons/card-sim';
import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
import RadarIcon from '@lucide/svelte/icons/radar';
import SignalIcon from '@lucide/svelte/icons/signal';
import SignalHighIcon from '@lucide/svelte/icons/signal-high';
import SignalLowIcon from '@lucide/svelte/icons/signal-low';
import SignalMediumIcon from '@lucide/svelte/icons/signal-medium';
import SignalZeroIcon from '@lucide/svelte/icons/signal-zero';
import WifiIcon from '@lucide/svelte/icons/wifi';
import WifiHighIcon from '@lucide/svelte/icons/wifi-high';
import WifiLowIcon from '@lucide/svelte/icons/wifi-low';
import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
import WifiZeroIcon from '@lucide/svelte/icons/wifi-zero';

import { getSignalCategory, linkVisualState, signalTextClass } from '$lib/helpers/signal';
import { cn } from '$lib/utils';

interface Props {
	/** Signal percentage 0–100, or null when no data */
	signal: number | null;
	/** Link type drives glyph selection and color rules */
	type: 'modem' | 'wifi' | 'ethernet';
	/** Connection state for null-signal glyph selection */
	connectionState?: 'connected' | 'scanning' | 'disconnected' | 'no_sim';
	/** Required for shape='bars': selects var(--link-{linkIndex+1}) identity color */
	linkIndex?: number;
	/** Rendering mode: bars (identity color) or icon (quality color) */
	shape?: 'bars' | 'icon';
	/** Fixed-box size */
	size?: 'sm' | 'md' | 'lg';
	/** Append "{signal}%" text after icon — only for shape='icon' when signal is not null */
	showPercent?: boolean;
	class?: string;
}

const {
	signal,
	type,
	connectionState = 'connected',
	linkIndex,
	shape = 'bars',
	size = 'sm',
	showPercent = false,
	class: className = undefined,
}: Props = $props();

// Fixed-box geometry per size. `glyphPx` matches the tallest bar so every
// fallback glyph occupies the same optical height as the bar cluster — the
// indicator never grows, shrinks, or shifts as its state changes.
function getSizeConfig(s: 'sm' | 'md' | 'lg') {
	switch (s) {
		case 'md':
			return { h: 16, w: 18, barW: 4, gap: 2, barH: [6, 10, 13] as const, glyphClass: 'size-4', glyphPx: 14 };
		case 'lg':
			return { h: 20, w: 22, barW: 5, gap: 2, barH: [8, 13, 17] as const, glyphClass: 'size-5', glyphPx: 18 };
		default:
			return { h: 14, w: 16, barW: 4, gap: 2, barH: [5, 8, 11] as const, glyphClass: 'size-3.5', glyphPx: 12 };
	}
}

const sizeConfig = $derived(getSizeConfig(size));

const visualState = $derived(linkVisualState({ type, connectionState, signal }));

const identityColor = $derived(
	linkIndex != null ? `var(--link-${linkIndex + 1})` : 'var(--muted-foreground)',
);

const qualityClass = $derived(signalTextClass(signal));
</script>

{#snippet barCluster(filled: number)}
	<span class="flex items-end" style:gap="{sizeConfig.gap}px" dir="ltr">
		{#each [0, 1, 2] as barIdx (barIdx)}
			<span
				class="rounded-[1px]"
				style:width="{sizeConfig.barW}px"
				style:height="{sizeConfig.barH[barIdx]}px"
				style:background-color={barIdx < filled ? identityColor : 'var(--link-bar-empty)'}
			></span>
		{/each}
	</span>
{/snippet}

{#if shape === 'icon' && signal !== null}
	<span class={cn('inline-flex items-center gap-1', className)} aria-hidden="true">
		{#if type === 'wifi'}
			{#if getSignalCategory(signal) === 'excellent'}
				<WifiIcon class={cn(sizeConfig.glyphClass, qualityClass)} aria-hidden="true" />
			{:else if getSignalCategory(signal) === 'good'}
				<WifiHighIcon class={cn(sizeConfig.glyphClass, qualityClass)} aria-hidden="true" />
			{:else if getSignalCategory(signal) === 'fair'}
				<WifiLowIcon class={cn(sizeConfig.glyphClass, qualityClass)} aria-hidden="true" />
			{:else}
				<WifiZeroIcon class={cn(sizeConfig.glyphClass, qualityClass)} aria-hidden="true" />
			{/if}
		{:else}
			{#if getSignalCategory(signal) === 'excellent'}
				<SignalHighIcon class={cn(sizeConfig.glyphClass, qualityClass)} aria-hidden="true" />
			{:else if getSignalCategory(signal) === 'good'}
				<SignalMediumIcon class={cn(sizeConfig.glyphClass, qualityClass)} aria-hidden="true" />
			{:else if getSignalCategory(signal) === 'fair'}
				<SignalLowIcon class={cn(sizeConfig.glyphClass, qualityClass)} aria-hidden="true" />
			{:else}
				<SignalIcon class={cn(sizeConfig.glyphClass, qualityClass)} aria-hidden="true" />
			{/if}
		{/if}
		{#if showPercent}
			<span class={cn('font-mono text-xs tabular-nums', qualityClass)}>{signal}%</span>
		{/if}
	</span>
{:else}
	<span
		aria-hidden="true"
		style:width="{sizeConfig.w}px"
		style:height="{sizeConfig.h}px"
		class={cn('inline-flex items-end justify-center', className)}
	>
		{#if visualState.kind === 'bars'}
			{@render barCluster(visualState.filled)}
		{:else if visualState.kind === 'ethernet'}
			<!-- Wired link is full-strength: render as three filled identity bars so
			     it shares the bar cluster's exact geometry and brightness (no oversized
			     or brighter glyph next to wireless links). -->
			{@render barCluster(3)}
		{:else if visualState.kind === 'no-sim'}
			<CardSimIcon size={sizeConfig.glyphPx} class="text-muted-foreground" aria-hidden="true" />
		{:else if visualState.kind === 'scanning'}
			<RadarIcon
				size={sizeConfig.glyphPx}
				class="text-muted-foreground motion-safe:animate-pulse"
				aria-hidden="true"
			/>
		{:else if visualState.kind === 'acquiring'}
			<LoaderCircleIcon
				size={sizeConfig.glyphPx}
				class="text-muted-foreground motion-safe:animate-spin"
				aria-hidden="true"
			/>
		{:else if visualState.kind === 'wifi-off'}
			<WifiOffIcon size={sizeConfig.glyphPx} class="text-muted-foreground" aria-hidden="true" />
		{:else}
			<SignalZeroIcon size={sizeConfig.glyphPx} class="text-muted-foreground" aria-hidden="true" />
		{/if}
	</span>
{/if}
