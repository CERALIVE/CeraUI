<style>
/* Custom animations for better mobile experience */
@keyframes slide-in-from-top {
  from {
    transform: translateY(-100%);
  }
  to {
    transform: translateY(0);
  }
}

@keyframes slide-in-from-bottom {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}

.animate-in {
  animation-duration: 300ms;
  animation-timing-function: ease-out;
}

.slide-in-from-top {
  animation-name: slide-in-from-top;
}

.slide-in-from-bottom {
  animation-name: slide-in-from-bottom;
}
</style>

<script lang="ts">
import { Download, Share, Wifi, WifiOff } from '@lucide/svelte';
import { _, locale } from 'svelte-i18n';
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';
import { canInstall, installApp, isOnline, showIOSInstallPrompt } from '$lib/stores/pwa';
import { connectionState } from '$lib/stores/websocket-enhanced';

import { rtlLanguages } from '../../../i18n';

let showOfflineBanner = $state(false);
let showInstallBanner = $state(false);
let showIOSBanner = $state(false);

// RTL support
const isRTL = $derived(rtlLanguages.includes($locale));

// Device detection - includes tablets like iPad
const isMobile = $derived(() => {
  if (typeof window === 'undefined') return false;

  // Check for touch capability
  const hasTouchScreen = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // Check user agent for mobile/tablet devices
  const userAgent = navigator.userAgent;
  const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);

  // Combine touch capability with user agent detection
  return hasTouchScreen || isMobileUA;
});

// Reactive statements - consider both browser online state AND WebSocket connection
$effect(() => {
  const isFullyOffline = !$isOnline || $connectionState === 'disconnected' || $connectionState === 'error';

  if (isFullyOffline) {
    showOfflineBanner = true;
  } else if ($connectionState === 'connected' && $isOnline) {
    // Hide offline banner after a short delay when both are back online
    setTimeout(() => {
      showOfflineBanner = false;
    }, 2000);
  }
});

$effect(() => {
  showInstallBanner = $canInstall;
});

// Track banner state more carefully
let bannerDismissed = $state(false);

$effect(() => {
  // Show blue banner on all mobile devices (not just iOS Safari)
  if (isMobile() && !bannerDismissed) {
    // Don't show if app is already installed
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone;

    // Only show if not installed and not dismissed
    showIOSBanner = !isStandalone;
  } else {
    showIOSBanner = false;
  }
});

async function handleInstall() {
  try {
    const success = await installApp();
    if (success) {
      toast.success('App Installed', {
        description: 'CeraUI has been added to your home screen!',
      });
    } else {
      toast.info('Installation Cancelled', {
        description: 'You can install the app later from your browser menu.',
      });
    }
  } catch (error) {
    console.error('Installation failed:', error);
    toast.error('Installation Failed', {
      description: 'Unable to install the app. Please try again.',
    });
  }
}

function dismissInstallBanner() {
  showInstallBanner = false;
}

function dismissIOSBanner() {
  showIOSBanner = false;
  bannerDismissed = true;
  showIOSInstallPrompt.set(false);
}
</script>

<!-- Offline Status Banner -->
{#if showOfflineBanner}
  <div
    class="bg-destructive text-destructive-foreground animate-in slide-in-from-top fixed top-0 right-0 left-0 z-50 p-3 text-center">
    <div class="flex items-center justify-center gap-2">
      <WifiOff class="h-4 w-4" />
      <span class="text-sm font-medium">{$_('pwa.offline')}</span>
      <span class="text-xs opacity-80">• {$_('pwa.offlineDescription')}</span>
    </div>
  </div>
{/if}

<!-- Connection Status Indicator -->
<div class="fixed bottom-4 z-40 {isRTL ? 'right-4' : 'left-4'}">
  {#if $connectionState === 'connecting'}
    <div class="flex items-center gap-1 rounded-full bg-yellow-500 px-2 py-1 text-xs text-white">
      <div class="h-2 w-2 animate-pulse rounded-full bg-white"></div>
      {$_('pwa.connecting')}
    </div>
  {:else if $connectionState === 'disconnected' || $connectionState === 'error'}
    <div class="bg-destructive text-destructive-foreground flex items-center gap-1 rounded-full px-2 py-1 text-xs">
      <WifiOff class="h-3 w-3" />
      {$_('pwa.disconnected')}
    </div>
  {:else if $connectionState === 'connected'}
    <div class="flex items-center gap-1 rounded-full bg-green-500 px-2 py-1 text-xs text-white">
      <Wifi class="h-3 w-3" />
      {$_('pwa.connected')}
    </div>
  {/if}
</div>

<!-- Install App Banner - Only on desktop -->
{#if showInstallBanner && !isMobile()}
  <div
    class="bg-primary text-primary-foreground animate-in slide-in-from-bottom fixed right-0 bottom-0 left-0 z-50 p-4">
    <div class="mx-auto flex max-w-md items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <Download class="h-5 w-5" />
        <div>
          <p class="text-sm font-medium">{$_('pwa.installTitle')}</p>
          <p class="text-xs opacity-80">{$_('pwa.installDescription')}</p>
        </div>
      </div>
      <div class="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          onclick={dismissInstallBanner}
          class="text-primary-foreground hover:bg-primary-foreground/20">
          {$_('pwa.installLater')}
        </Button>
        <Button variant="secondary" size="sm" onclick={handleInstall}>{$_('pwa.installButton')}</Button>
      </div>
    </div>
  </div>
{/if}

<!-- Mobile Install App Banner - All mobile devices, fixed to bottom -->
{#if showIOSBanner && isMobile()}
  <div
    class="animate-in slide-in-from-bottom fixed right-0 left-0 z-50 bg-blue-500 p-4 text-white"
    style="
      bottom: 0px;
      bottom: env(safe-area-inset-bottom, 0px);
      padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
      -webkit-transform: translateZ(0);
      transform: translateZ(0);
      max-width: 100vw;
      width: 100%;
      box-sizing: border-box;
      overflow-x: hidden;
    ">
    <div class="mx-auto flex w-full max-w-sm items-center justify-between gap-3 px-2">
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <Download class="h-5 w-5 flex-shrink-0" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">{$_('pwa.installTitle')}</p>
          <p class="truncate text-xs opacity-80">
            {#if /iPad|iPhone|iPod/.test(navigator.userAgent)}
              Tap <Share class="mx-1 inline h-3 w-3" />
              {$_('pwa.installIosDescription')}
            {:else}
              {$_('pwa.installDescription')}
            {/if}
          </p>
        </div>
      </div>
      <div class="flex flex-shrink-0">
        <Button variant="ghost" size="sm" onclick={dismissIOSBanner} class="text-white hover:bg-white/20">
          {$_('pwa.installIosGotIt')}
        </Button>
      </div>
    </div>
  </div>
{/if}
