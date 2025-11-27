<script lang="ts">
import { Signal, SignalHigh, SignalLow, SignalMedium } from '@lucide/svelte';

import { cn } from '$lib/utils';

interface Props {
	signal?: number;
	class?: string;
}

let { signal = 0, class: className }: Props = $props();
</script>

{#if signal >= 75}
	<span title="Excellent">
		<SignalHigh class={cn('text-green-600 dark:text-green-400', className)} />
	</span>
{:else if signal >= 50}
	<span title="Good">
		<SignalMedium class={cn('text-green-600 dark:text-green-400', className)} />
	</span>
{:else if signal >= 25}
	<span title="Fair">
		<SignalLow class={cn('text-yellow-600 dark:text-yellow-400', className)} />
	</span>
{:else}
	<span title="Poor">
		<Signal class={cn('text-red-600 dark:text-red-400', className)} />
	</span>
{/if}
