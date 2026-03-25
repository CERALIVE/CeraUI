<script lang="ts">
import { Wifi, WifiHigh, WifiLow, WifiZero } from '@lucide/svelte';

import { cn } from '$lib/utils';

interface Props {
	signal?: number;
	class?: string;
}

let { signal = 0, class: className }: Props = $props();
</script>

{#if signal >= 80}
	<span title="High">
		<Wifi class={cn('text-signal-excellent', className)} />
	</span>
{:else if signal >= 60}
	<span title="Medium">
		<WifiHigh class={cn('text-signal-good', className)} />
	</span>
{:else if signal >= 40}
	<span title="Low">
		<WifiLow class={cn('text-signal-fair', className)} />
	</span>
{:else}
	<span title="Poor">
		<WifiZero class={cn('text-signal-weak', className)} />
	</span>
{/if}
