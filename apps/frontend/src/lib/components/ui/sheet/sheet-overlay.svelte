<script lang="ts">
import { Dialog as SheetPrimitive } from 'bits-ui';

import { cn } from '$lib/utils.js';

let {
  ref = $bindable(null),
  class: className,
  ...restProps
}: SheetPrimitive.OverlayProps = $props();
</script>

<SheetPrimitive.Overlay
  class={cn(
    'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0  fixed inset-0 z-50 bg-black/80',
    className
  )}
  bind:ref
  {...restProps}
/>
