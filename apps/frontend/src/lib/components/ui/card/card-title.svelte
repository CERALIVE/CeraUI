<script lang="ts">
import type { WithElementRef } from 'bits-ui';
import type { HTMLAttributes } from 'svelte/elements';

import { cn } from '$lib/utils.js';

let {
  ref = $bindable(null),
  class: className,
  level = 3,
  children,
  ...restProps
}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
  level?: 1 | 2 | 3 | 4 | 5 | 6;
} = $props();
</script>

<div
  bind:this={ref}
  class={cn('leading-none font-semibold tracking-tight', className)}
  aria-level={level}
  role="heading"
  {...restProps}
>
  {@render children?.()}
</div>
