<script lang="ts">
import { Tabs as TabsPrimitive } from 'bits-ui';

import { cn } from '$lib/utils.js';

let { ref = $bindable(null), class: className, ...restProps }: TabsPrimitive.ListProps = $props();
</script>

<TabsPrimitive.List
  class={cn(
    'bg-muted text-muted-foreground inline-flex h-9 items-center justify-center rounded-lg p-1',
    className
  )}
  bind:ref
  {...restProps}
/>
