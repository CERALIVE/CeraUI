<script lang="ts">
import { Wifi, WifiHigh, WifiLow, WifiZero } from '@lucide/svelte';

import { getSignalCategory } from '$lib/helpers/signal';
import { cn } from '$lib/utils';

interface Props {
	signal?: number;
	class?: string;
}

let { signal = 0, class: className }: Props = $props();

const category = $derived(getSignalCategory(signal));
</script>

{#if category === 'excellent'}
	<Wifi class={cn('text-signal-excellent', className)} aria-hidden="true" />
{:else if category === 'good'}
	<WifiHigh class={cn('text-signal-good', className)} aria-hidden="true" />
{:else if category === 'fair'}
	<WifiLow class={cn('text-signal-fair', className)} aria-hidden="true" />
{:else}
	<WifiZero class={cn('text-signal-weak', className)} aria-hidden="true" />
{/if}
