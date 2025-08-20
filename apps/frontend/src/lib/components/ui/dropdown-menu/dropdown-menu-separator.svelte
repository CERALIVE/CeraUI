<script lang="ts">
import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';

import { cn } from '$lib/utils.js';

let {
  ref = $bindable(null),
  class: className,
  ...restProps
}: DropdownMenuPrimitive.SeparatorProps = $props();
</script>

<DropdownMenuPrimitive.Separator
  class={cn('bg-muted -mx-1 my-1 h-px', className)}
  bind:ref
  {...restProps}
/>
