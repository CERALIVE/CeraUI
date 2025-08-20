<script lang="ts">
import { Avatar as AvatarPrimitive } from 'bits-ui';

import { cn } from '$lib/utils.js';

let {
  class: className,
  src,
  alt,
  ref = $bindable(null),
  ...restProps
}: AvatarPrimitive.ImageProps = $props();
</script>

<AvatarPrimitive.Image
  class={cn('aspect-square size-full', className)}
  {alt}
  {src}
  bind:ref
  {...restProps}
/>
