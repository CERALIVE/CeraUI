<style>
/* Enhanced mobile touch interactions */
button {
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}

/* Smooth hardware-accelerated animations */
@media (prefers-reduced-motion: no-preference) {
  button {
    will-change: transform, background-color;
  }
}

/* Enhanced disabled state */
button:disabled {
  cursor: not-allowed;
}

/* Better focus visible styles for accessibility */
button:focus-visible {
  transform: scale(1.02);
}
</style>

<script lang="ts">
import { cubicInOut } from 'svelte/easing';
import { fly, scale } from 'svelte/transition';

import { cn } from '$lib/utils.js';

interface Props {
  class?: string;
  identifier?: string;
  disabled?: boolean;
  isActive?: boolean;
  loading?: boolean;
  onclick?: () => void;
  children?: import('svelte').Snippet;
  [key: string]: any;
}

let {
  class: className = undefined,
  identifier,
  disabled = false,
  isActive = false,
  loading = false,
  onclick,
  children,
  ...restProps
}: Props = $props();

// Enhanced props for reactive states
let isHovered = $state(false);
let isPressed = $state(false);

// Handle mouse/touch interactions for better feedback
const handleMouseDown = () => (isPressed = true);
const handleMouseUp = () => (isPressed = false);
const handleMouseLeave = () => {
  isPressed = false;
  isHovered = false;
};
</script>

<button
  id={identifier}
  {disabled}
  onmouseenter={() => (isHovered = true)}
  onmouseleave={handleMouseLeave}
  onmousedown={handleMouseDown}
  onmouseup={handleMouseUp}
  ontouchstart={handleMouseDown}
  ontouchend={handleMouseUp}
  {onclick}
  class={cn(
    'group relative w-full cursor-pointer rounded-lg px-4 py-3 text-left transition-all duration-300',
    'hover:bg-accent/50 focus-visible:bg-accent/60',
    'focus-visible:ring-primary/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
    isActive
      ? 'bg-accent text-primary border-border/30 border font-medium shadow-sm'
      : 'text-foreground/80 hover:text-foreground font-medium',
    // Enhanced interactive states
    isHovered && !isActive && 'bg-accent/40 scale-[1.02]',
    isPressed && 'scale-[0.98]',
    disabled && 'pointer-events-none opacity-60',
    className,
  )}
  {...restProps}>
  {#if isActive}
    <!-- Enhanced active indicator with smooth animation -->
    <div
      class="bg-primary absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full transition-all duration-300"
      class:h-8={!isHovered}
      class:h-10={isHovered}
      in:scale={{ duration: 300, start: isFinite(0.5) ? 0.5 : 1, easing: cubicInOut }}
      out:scale={{ duration: 200, start: isFinite(1) ? 1 : 1, easing: cubicInOut }}>
    </div>

    <!-- Subtle pulse effect for active items -->
    <div class="bg-primary/30 absolute top-1/2 left-0 h-8 w-1 -translate-y-1/2 animate-pulse rounded-r-full"></div>
  {/if}

  <!-- Enhanced content with reactive animations -->
  <div class={cn('relative block pl-3 transition-all duration-200', isActive && 'pl-4', isHovered && 'translate-x-1')}>
    <!-- Content slot with enhanced typography -->
    <span
      class={cn(
        'transition-all duration-200',
        isActive && 'font-semibold tracking-wide',
        isHovered && isActive && 'text-primary/90',
      )}>
      {#if children}
        {@render children()}
      {/if}
    </span>

    <!-- Subtle hover effect line -->
    {#if isHovered && !isActive}
      <div
        class="bg-primary/60 absolute bottom-0 left-0 h-0.5 rounded-full transition-all duration-300"
        class:w-6={isHovered}
        in:fly={{ x: -10, duration: 200 }}
        out:fly={{ x: -10, duration: 150 }}>
      </div>
    {/if}
  </div>

  <!-- Loading state overlay -->
  {#if loading}
    <div class="bg-background/80 absolute inset-0 flex items-center justify-center rounded-lg backdrop-blur-[2px]">
      <div class="border-primary h-4 w-4 animate-spin rounded-full border-2 border-t-transparent"></div>
    </div>
  {/if}
</button>
