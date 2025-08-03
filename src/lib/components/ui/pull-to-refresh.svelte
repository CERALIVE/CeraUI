<script lang="ts">
import { RefreshCw } from '@lucide/svelte';
import { onMount } from 'svelte';
import { _, locale } from 'svelte-i18n';

import { rtlLanguages } from '../../../i18n';

interface Props {
  onRefresh: () => Promise<void> | void;
  threshold?: number;
  distance?: number;
  children: import('svelte').Snippet;
}

let { onRefresh, threshold = 80, distance = 150, children }: Props = $props();

// RTL support (for future enhancements)
const _isRTL = $derived(rtlLanguages.includes($locale));

let containerElement: HTMLElement;
let refreshElement: HTMLElement;
let isRefreshing = $state(false);
let pullDistance = $state(0);
let isPulling = $state(false);
let canRefresh = $state(false);

let startY = 0;
let currentY = 0;

const handleTouchStart = (e: TouchEvent) => {
  if (window.scrollY > 0) return; // Only allow at top of page

  startY = e.touches[0].clientY;
  isPulling = true;
};

const handleTouchMove = (e: TouchEvent) => {
  if (!isPulling || window.scrollY > 0) return;

  currentY = e.touches[0].clientY;
  pullDistance = Math.max(0, currentY - startY);

  if (pullDistance > threshold) {
    canRefresh = true;
  } else {
    canRefresh = false;
  }

  // Prevent default scrolling when pulling
  if (pullDistance > 0) {
    e.preventDefault();
  }

  // Apply transform with resistance (from -48px hidden to 0px visible)
  const resistance = Math.min(pullDistance / 2, distance);
  const transformY = -48 + Math.min((resistance * 48) / threshold, 48);
  if (refreshElement) {
    refreshElement.style.transform = `translateY(${transformY}px)`;
    refreshElement.style.opacity = Math.min(pullDistance / threshold, 1).toString();
  }
};

const handleTouchEnd = async () => {
  if (!isPulling) return;

  isPulling = false;

  if (canRefresh && !isRefreshing) {
    isRefreshing = true;

    try {
      await onRefresh();
    } catch (error) {
      console.error('Refresh error:', error);
    } finally {
      isRefreshing = false;
      canRefresh = false;
      pullDistance = 0;

      // Reset transform (hide above header)
      if (refreshElement) {
        refreshElement.style.transform = 'translateY(-48px)';
        refreshElement.style.opacity = '0';
      }
    }
  } else {
    // Reset without refreshing
    canRefresh = false;
    pullDistance = 0;

    if (refreshElement) {
      refreshElement.style.transform = 'translateY(-48px)';
      refreshElement.style.opacity = '0';
    }
  }
};

onMount(() => {
  // Add touch event listeners
  document.addEventListener('touchstart', handleTouchStart, { passive: true });
  document.addEventListener('touchmove', handleTouchMove, { passive: false });
  document.addEventListener('touchend', handleTouchEnd, { passive: true });

  return () => {
    document.removeEventListener('touchstart', handleTouchStart);
    document.removeEventListener('touchmove', handleTouchMove);
    document.removeEventListener('touchend', handleTouchEnd);
  };
});
</script>

<!-- Pull to Refresh Indicator -->
<div
  bind:this={refreshElement}
  class="bg-background/95 supports-backdrop-filter:bg-background/80 fixed top-0 right-0 left-0 z-[60] flex h-12 transform items-center justify-center border-b opacity-0 shadow-sm backdrop-blur-sm transition-all duration-300"
  style="transform: translateY(-48px); margin-top: 56px;">
  <div class="text-muted-foreground flex items-center gap-2">
    <RefreshCw class="h-4 w-4 {isRefreshing ? 'animate-spin' : ''} {canRefresh ? 'text-primary' : ''}" />
    <span class="text-sm font-medium">
      {#if isRefreshing}
        {$_('pwa.refreshing')}
      {:else if canRefresh}
        {$_('pwa.releaseToRefresh')}
      {:else}
        {$_('pwa.pullToRefresh')}
      {/if}
    </span>
  </div>
</div>

<!-- Container for the main content -->
<div bind:this={containerElement}>
  {@render children()}
</div>
