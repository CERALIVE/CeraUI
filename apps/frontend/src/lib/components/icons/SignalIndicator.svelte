<script lang="ts">
import { getSignalCategory } from '$lib/helpers/signal';
import { cn } from '$lib/utils';

import SignalQuality from './SignalQuality.svelte';
import WifiQuality from './WifiQuality.svelte';

interface Props {
	signal: number;
	type?: 'wifi' | 'cellular';
	class?: string;
}

const { signal, type = 'cellular', class: className }: Props = $props();

const signalColor = $derived.by(() => {
	const category = getSignalCategory(signal);
	switch (category) {
		case 'excellent':
			return 'text-signal-excellent';
		case 'good':
			return 'text-signal-good';
		case 'fair':
			return 'text-signal-fair';
		case 'weak':
			return 'text-signal-weak';
	}
});
</script>

<div class={cn('inline-flex items-center gap-1', className)}>
	{#if type === 'wifi'}
		<WifiQuality class="h-4 w-4" {signal} />
	{:else}
		<SignalQuality class="h-4 w-4" {signal} />
	{/if}
	<span
		class={cn(
			'font-mono text-sm leading-none font-bold tabular-nums',
			signalColor,
		)}
	>
		{signal}%
	</span>
</div>
