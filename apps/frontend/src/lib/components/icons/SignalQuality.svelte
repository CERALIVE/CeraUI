<script lang="ts">
import { Signal, SignalHigh, SignalLow, SignalMedium } from '@lucide/svelte';
import type { HTMLAttributes } from 'svelte/elements';

import { cn } from '$lib/utils';

type $$Props = HTMLAttributes<HTMLDivElement> & { signal: number; class?: string };

export let signal: $$Props['signal'] = 0;
let className: $$Props['class'] = undefined;
export { className as class };
</script>

{#if signal >= 75}
  <span title="Excellent">
    <SignalHigh class={cn('text-green-600 dark:text-green-400', className)} {...$$restProps}
    ></SignalHigh>
  </span>
{:else if signal >= 50}
  <span title="Good">
    <SignalMedium class={cn('text-green-600 dark:text-green-400', className)} {...$$restProps}
    ></SignalMedium>
  </span>
{:else if signal >= 25}
  <span title="Fair">
    <SignalLow class={cn('text-yellow-600 dark:text-yellow-400', className)} {...$$restProps}
    ></SignalLow>
  </span>
{:else}
  <span title="Poor">
    <Signal class={cn('text-red-600 dark:text-red-400', className)} {...$$restProps}></Signal>
  </span>
{/if}
