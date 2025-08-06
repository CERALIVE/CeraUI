<script lang="ts">
import { cn } from '$lib/utils.js';

let className: string | undefined | null = undefined;
export { className as class };
</script>

<button
  id={$$props.identifier}
  class={cn(
    'group relative w-full cursor-pointer rounded-lg px-4 py-3 text-left transition-all duration-200',
    'hover:bg-accent/50',
    $$props.isActive
      ? 'bg-accent text-primary border-border/30 border font-medium'
      : 'text-foreground/80 hover:text-foreground font-medium',
    className,
  )}
  {...$$restProps}>
  {#if $$props.isActive}
    <!-- Simple active indicator -->
    <div class="bg-primary absolute top-1/2 left-0 h-8 w-1 -translate-y-1/2 rounded-r-full"></div>
  {/if}

  <!-- Clean content -->
  <span class="relative block pl-3">
    <slot />
  </span>
</button>
