<script lang="ts">
import { cn } from '$lib/utils';

import SignalQuality from './SignalQuality.svelte';
import WifiQuality from './WifiQuality.svelte';

interface Props {
	signal: number;
	type?: 'wifi' | 'cellular';
	class?: string;
}

const { signal, type = 'cellular', class: className }: Props = $props();

// Signal color based on strength
const signalColor = $derived.by(() => {
	if (signal >= 70) return 'text-emerald-600 dark:text-emerald-400';
	if (signal >= 40) return 'text-amber-600 dark:text-amber-400';
	return 'text-red-600 dark:text-red-400';
});
</script>

<div class={cn('inline-flex items-end gap-1', className)}>
	{#if type === 'wifi'}
		<WifiQuality class="h-4 w-4" {signal} />
	{:else}
		<SignalQuality class="h-4 w-4" {signal} />
	{/if}
	<span
		class={cn(
			'translate-y-[2px] font-mono text-sm leading-none font-bold tabular-nums',
			signalColor,
		)}
	>
		{signal}%
	</span>
</div>
