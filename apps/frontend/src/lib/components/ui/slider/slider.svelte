<script lang="ts">
import { Slider as SliderPrimitive, type WithoutChildrenOrChild } from 'bits-ui';

import { cn } from '$lib/utils.js';

let {
  ref = $bindable(null),
  value = $bindable(),
  orientation = 'horizontal',
  class: className,
  ...restProps
}: WithoutChildrenOrChild<SliderPrimitive.RootProps> = $props();
</script>

<!--
Discriminated Unions + Destructing (required for bindable) do not
get along, so we shut typescript up by casting `value` to `never`.
-->
<SliderPrimitive.Root
  class={cn(
    "relative flex touch-none items-center select-none data-[orientation='horizontal']:w-full data-[orientation='vertical']:h-full data-[orientation='vertical']:min-h-44 data-[orientation='vertical']:w-auto data-[orientation='vertical']:flex-col",
    className
  )}
  {orientation}
  bind:ref
  bind:value={value as never}
  {...restProps}
>
  {#snippet children({ thumbs })}
    <span
      class="bg-primary/20 relative grow overflow-hidden rounded-full data-[orientation='horizontal']:h-1.5 data-[orientation='horizontal']:w-full data-[orientation='vertical']:h-full data-[orientation='vertical']:w-1.5"
      data-orientation={orientation}
    >
      <SliderPrimitive.Range
        class="bg-primary absolute data-[orientation='horizontal']:h-full data-[orientation='vertical']:w-full"
      />
    </span>
    {#each thumbs as thumb}
      <SliderPrimitive.Thumb
        class="border-primary/50 bg-background focus-visible:ring-ring block size-4 rounded-full border shadow-sm transition-colors focus-visible:ring-1 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
        index={thumb}
      />
    {/each}
  {/snippet}
</SliderPrimitive.Root>
