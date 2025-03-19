<script lang="ts">
import { cn } from '$lib/utils.js';

let className: string | undefined | null = undefined;
export { className as class };
</script>

<button
  id={$$props.identifier}
  class={'py-2 ' + cn($$props.isActive ? 'bg-muted text-primary font-medium' : 'text-foreground/60', className)}
  {...$$restProps}>
  <slot />
</button>
