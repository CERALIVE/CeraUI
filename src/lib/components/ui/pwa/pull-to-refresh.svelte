<script lang="ts">
import { RefreshCw } from '@lucide/svelte';
import { onMount } from 'svelte';
import { _, locale } from 'svelte-i18n';

import { rtlLanguages } from '../../../../i18n';

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

  const clientY = e.touches[0]?.clientY;
  if (!isFinite(clientY)) return; // Prevent NaN coordinates

  startY = clientY;
  isPulling = true;
};

const handleTouchMove = (e: TouchEvent) => {
  if (!isPulling || window.scrollY > 0) return;

  const clientY = e.touches[0]?.clientY;
  if (!isFinite(clientY) || !isFinite(startY)) return; // Prevent NaN coordinates

  currentY = clientY;
  const rawPullDistance = currentY - startY;
  pullDistance = isFinite(rawPullDistance) ? Math.max(0, rawPullDistance) : 0;

  if (pullDistance > threshold) {
    canRefresh = true;
  } else {
    canRefresh = false;
  }

  // Prevent default scrolling when pulling
  if (pullDistance > 0) {
    e.preventDefault();
  }

  // Apply transform with resistance (from -48px hidden to 0px visible) - NaN safe
  const safePullDistance = isFinite(pullDistance) ? pullDistance : 0;
  const safeThreshold = isFinite(threshold) && threshold > 0 ? threshold : 80;
  const safeDistance = isFinite(distance) ? distance : 150;

  const resistance = Math.min(safePullDistance / 2, safeDistance);
  const safeResistance = isFinite(resistance) ? resistance : 0;

  const transformCalculation = -48 + Math.min((safeResistance * 48) / safeThreshold, 48);
  const transformY = isFinite(transformCalculation) ? transformCalculation : -48;

  const opacityCalculation = Math.min(safePullDistance / safeThreshold, 1);
  const opacity = isFinite(opacityCalculation) ? opacityCalculation : 0;

  if (refreshElement) {
    refreshElement.style.transform = `translateY(${transformY}px)`;
    refreshElement.style.opacity = opacity.toString();
    // Enable pointer events when visible and allow clicking to cancel refresh
    refreshElement.style.pointerEvents = pullDistance > threshold ? 'auto' : 'none';
    refreshElement.style.cursor = pullDistance > threshold ? 'pointer' : 'default';
  }
};

const handleTouchEnd = async () => {
  if (!isPulling) return;

  isPulling = false;

  if (canRefresh && !isRefreshing) {
    isRefreshing = true;

    // Make clickeable during refresh for cancellation
    if (refreshElement) {
      refreshElement.style.pointerEvents = 'auto';
      refreshElement.style.cursor = 'pointer';
    }

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
        refreshElement.style.pointerEvents = 'none';
        refreshElement.style.cursor = 'default';
      }
    }
  } else {
    // Reset without refreshing
    canRefresh = false;
    pullDistance = 0;

    if (refreshElement) {
      refreshElement.style.transform = 'translateY(-48px)';
      refreshElement.style.opacity = '0';
      refreshElement.style.pointerEvents = 'none';
      refreshElement.style.cursor = 'default';
    }
  }
};

onMount(() => {
  // Only add touch listeners on mobile/tablet devices (including iPad) with NaN safety
  const maxTouchPoints = navigator.maxTouchPoints;
  const hasTouchScreen = 'ontouchstart' in window || (isFinite(maxTouchPoints) && maxTouchPoints > 0);
  const userAgent = navigator.userAgent || '';
  const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);
  const isMobile = hasTouchScreen || isMobileUA;

  if (isMobile) {
    // Add touch event listeners
    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }
});
</script>

<!-- Pull to Refresh Indicator -->
<div
  bind:this={refreshElement}
  class="bg-background/95 supports-backdrop-filter:bg-background/80 pointer-events-none fixed top-0 right-0 left-0 z-[60] flex h-12 transform items-center justify-center border-b opacity-0 shadow-sm backdrop-blur-sm transition-all duration-300"
  style="transform: translateY(-48px); margin-top: 56px;"
  role="button"
  tabindex="-1"
  onclick={() => {
    if (isRefreshing) {
      // Allow canceling refresh by clicking
      isRefreshing = false;
      canRefresh = false;
      pullDistance = 0;
      if (refreshElement) {
        refreshElement.style.transform = 'translateY(-48px)';
        refreshElement.style.opacity = '0';
        refreshElement.style.pointerEvents = 'none';
        refreshElement.style.cursor = 'default';
      }
    }
  }}
  onkeydown={e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isRefreshing) {
        // Allow canceling refresh by keyboard
        isRefreshing = false;
        canRefresh = false;
        pullDistance = 0;
        if (refreshElement) {
          refreshElement.style.transform = 'translateY(-48px)';
          refreshElement.style.opacity = '0';
          refreshElement.style.pointerEvents = 'none';
          refreshElement.style.cursor = 'default';
        }
      }
    }
  }}>
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
