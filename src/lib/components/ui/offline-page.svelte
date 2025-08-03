<script lang="ts">
import { RefreshCw, Smartphone, WifiOff } from '@lucide/svelte';
import { locale } from 'svelte-i18n';

import { Button } from '$lib/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
import { wsManager } from '$lib/stores/websocket-enhanced';

import { rtlLanguages } from '../../../i18n';

// RTL support (for future enhancements)
const _isRTL = $derived(rtlLanguages.includes($locale));

function handleRetry() {
  // Try to reconnect WebSocket
  wsManager.reconnect();

  // Reload the page as fallback
  setTimeout(() => {
    window.location.reload();
  }, 2000);
}

function goBack() {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.href = '/';
  }
}
</script>

<div class="bg-background flex min-h-screen items-center justify-center p-4">
  <Card class="mx-auto w-full max-w-md">
    <CardHeader class="text-center">
      <div class="bg-muted mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full">
        <WifiOff class="text-muted-foreground h-8 w-8" />
      </div>
      <CardTitle class="text-xl">You're Offline</CardTitle>
      <CardDescription>CeraUI needs an internet connection to manage your BELABOX device.</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <div class="text-muted-foreground space-y-2 text-sm">
        <p>Please check:</p>
        <ul class="ml-2 list-inside list-disc space-y-1">
          <li>Your Wi-Fi connection</li>
          <li>Your device is on the same network</li>
          <li>BELABOX device is powered on</li>
        </ul>
      </div>

      <div class="flex flex-col gap-2">
        <Button onclick={handleRetry} class="w-full">
          <RefreshCw class="mr-2 h-4 w-4" />
          Try Again
        </Button>
        <Button variant="outline" onclick={goBack} class="w-full">Go Back</Button>
      </div>

      <div class="border-t pt-4">
        <div class="text-muted-foreground flex items-center gap-2 text-xs">
          <Smartphone class="h-4 w-4" />
          <span>This app works best when installed on your device</span>
        </div>
      </div>
    </CardContent>
  </Card>
</div>
