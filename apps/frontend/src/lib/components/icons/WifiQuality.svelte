<script lang="ts">
import { Wifi, WifiHigh, WifiLow, WifiZero } from '@lucide/svelte';
import type { HTMLAttributes } from 'svelte/elements';

import { cn } from '$lib/utils';

interface Props extends HTMLAttributes<HTMLDivElement> {
	signal?: number;
	class?: string;
}

let { signal = 0, class: className, ...restProps }: Props = $props();
</script>

{#if signal >= 80}
	<span title="High">
		<Wifi class={cn('text-green-500', className)} {...restProps}></Wifi>
	</span>
{:else if signal >= 60}
	<span title="Medium">
		<WifiHigh class={cn('text-green-500', className)} {...restProps}></WifiHigh>
	</span>
{:else if signal >= 40}
	<span title="Low">
		<WifiLow class={cn('text-yellow-700', className)} {...restProps}></WifiLow>
	</span>
{:else}
	<span title="Poor">
		<WifiZero class={cn('text-red-800', className)} {...restProps}></WifiZero>
	</span>
{/if}
