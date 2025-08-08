<script lang="ts">
import { Eye, EyeOff, Link, ScanSearch, Trash2, Unlink } from '@lucide/svelte';
import { _ } from 'svelte-i18n';
import { toast } from 'svelte-sonner';

import WifiQuality from '$lib/components/icons/WifiQuality.svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { ScrollArea } from '$lib/components/ui/scroll-area';
import SimpleAlertDialog from '$lib/components/ui/simple-alert-dialog.svelte';
import {
  connectToNewWifi,
  connectWifi,
  disconnectWifi,
  forgetWifi,
  getWifiUUID,
  networkRename,
  scanWifi,
} from '$lib/helpers/NetworkHelper.js';
import { WifiMessages } from '$lib/stores/websocket-store';
import type { ValueOf } from '$lib/types';
import type { StatusMessage } from '$lib/types/socket-messages';
import { cn } from '$lib/utils';

let { wifi, wifiId }: { wifi: ValueOf<StatusMessage['wifi']>; wifiId: number } = $props();
let networkPassword = $state('');
let showPassword = $state(false);
let open = $state(false);

let connecting: string | undefined = $state();
let scanning = $state(false);

WifiMessages.subscribe(wifiMessage => {
  if (wifiMessage) {
    if (wifiMessage.new?.error) {
      toast.error($_('wifiSelector.error.connectionFailed'), {
        description: $_('wifiSelector.error.connectionFailedDescription'),
      });
      connecting = undefined;
    } else if (wifiMessage.new?.success) {
      toast.success($_('wifiSelector.success.connected'), {
        description: $_('wifiSelector.success.connectedDescription'),
      });
      connecting = undefined;
      // Close dialog on successful connection
      open = false;
    } else {
      connecting = undefined;
    }
  }
});

$effect(() => {
  let internal: NodeJS.Timeout;
  if (open) {
    internal = setInterval(() => {
      console.log('Doing wifi scan');
      scanWifi(wifiId, false);
    }, 22000);
  }
  return () => clearInterval(internal);
});

const handleWifiScan = () => {
  scanWifi(wifiId);
  scanning = true;
  setTimeout(() => {
    scanning = false;
  }, 20000);
};

const handleWifiConnect = (uuid: string, wifi: ValueOf<StatusMessage['wifi']>['available'][number]) => {
  connecting = uuid;
  connectWifi(uuid, wifi);
  networkPassword = '';
};

const handleNewWifiConnect = (ssid: string, password: string) => {
  connecting = ssid;
  connectToNewWifi(wifiId, ssid, password);
  // Reset form state after initiating connection
  networkPassword = '';
  showPassword = false;
};
</script>

<SimpleAlertDialog
  buttonText={$_('wifiSelector.dialog.searchWifi')}
  confirmButtonText={$_('wifiSelector.dialog.close')}
  hiddeCancelButton={true}
  class="max-h-[90vh] max-w-[95vw] overflow-hidden sm:max-w-md lg:max-w-2xl"
  bind:open
  title={$_('wifiSelector.dialog.searchWifi')}
  extraButtonClasses="w-full bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white font-medium shadow-lg transition-all duration-300 transform hover:scale-[1.02]">
  {#snippet icon()}
    <ScanSearch></ScanSearch>
  {/snippet}
  {#snippet dialogTitle()}
    {$_('wifiSelector.dialog.availableNetworks', { values: { network: networkRename(wifi.ifname) } })}
  {/snippet}
  <div class="flex max-h-[75vh] flex-col space-y-3 overflow-hidden">
    <!-- Header with Network Info -->
    <div
      class="space-y-2 rounded-lg border border-blue-200 bg-gradient-to-r from-blue-50 to-indigo-50 p-3 text-center dark:border-blue-800 dark:from-blue-950/30 dark:to-indigo-950/30">
      <div
        class="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600">
        <ScanSearch class="h-5 w-5 text-white" />
      </div>
      <h3 class="text-foreground text-sm font-semibold">
        {$_('wifiSelector.dialog.availableNetworks', { values: { network: '' } })}
      </h3>
      <div class="rounded bg-white/50 px-2 py-1 dark:bg-black/20">
        <p class="font-mono text-xs break-all">{networkRename(wifi.ifname)}</p>
      </div>
      <p class="text-muted-foreground text-xs">{wifi.available.length} {$_('wifiSelector.networks.found')}</p>
    </div>

    <!-- WiFi Networks List -->
    <ScrollArea
      class="min-h-0 w-full flex-1 rounded-xl border-2 border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900/50"
      type="auto">
      <div class="space-y-1 p-2">
        {#each wifi.available as availableNetwork, _index}
          {@const uuid = getWifiUUID(availableNetwork, wifi.saved)}
          {@const isConnecting =
            connecting !== undefined && (connecting === uuid || connecting === availableNetwork.ssid)}
          <div
            class={cn(
              'flex items-center rounded-lg p-3 transition-all duration-200 hover:bg-gray-50 dark:hover:bg-gray-800/50',
              availableNetwork.active
                ? 'border-2 border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30'
                : 'border-2 border-transparent',
              uuid ? '' : 'cursor-pointer hover:border-blue-200 dark:hover:border-blue-700',
            )}>
            <!-- Signal Strength -->
            <div class="flex-shrink-0">
              <WifiQuality signal={availableNetwork.signal} class="h-8 w-8" />
            </div>

            <!-- Network Info -->
            <div class="ml-3 min-w-0 flex-1">
              <div class="mb-0.5 flex items-center gap-2">
                <!-- Network Name with Tooltip for Long Names -->
                <div class="min-w-0 flex-1">
                  {#if availableNetwork.ssid.length > 20}
                    <h4
                      class="text-foreground cursor-help truncate text-sm font-semibold"
                      title={availableNetwork.ssid}
                      class:text-green-700={availableNetwork.active}
                      class:dark:text-green-400={availableNetwork.active}>
                      {availableNetwork.ssid}
                    </h4>
                    <!-- Full name on next line for very long names -->
                    {#if availableNetwork.ssid.length > 32}
                      <p class="text-muted-foreground mt-0.5 text-xs leading-tight break-all">
                        {availableNetwork.ssid}
                      </p>
                    {/if}
                  {:else}
                    <h4
                      class="text-foreground text-sm font-semibold"
                      class:text-green-700={availableNetwork.active}
                      class:dark:text-green-400={availableNetwork.active}>
                      {availableNetwork.ssid}
                    </h4>
                  {/if}
                </div>

                <!-- Connection Status Badge - Removed as green border already indicates connection -->
              </div>

              <!-- Security and Signal Info -->
              <div class="text-muted-foreground flex items-center gap-1.5 text-xs">
                <span class="inline-flex min-w-0 items-center gap-1">
                  {#if availableNetwork.security.includes('WPA')}
                    <svg class="h-3 w-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fill-rule="evenodd"
                        d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                        clip-rule="evenodd" />
                    </svg>
                  {:else}
                    <svg class="h-3 w-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fill-rule="evenodd"
                        d="M10 1C5.03 1 1 5.03 1 10s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9zM9 5a4 4 0 100 8 4 4 0 000-8zM6.5 9.5a.5.5 0 11-1 0 .5.5 0 011 0z"
                        clip-rule="evenodd" />
                    </svg>
                  {/if}
                  <span class="max-w-[80px] truncate" title={availableNetwork.security}>
                    {availableNetwork.security.replaceAll(' ', ', ')}
                  </span>
                </span>
                <span class="flex-shrink-0">•</span>
                <span class="flex-shrink-0 font-medium">{availableNetwork.signal}%</span>
              </div>
            </div>

            <!-- Action Buttons -->
            <div class="ml-2 flex-shrink-0">
              {#if isConnecting}
                <div class="flex items-center gap-1 rounded-lg bg-blue-100 px-2 py-1 dark:bg-blue-900/30">
                  <div class="h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"></div>
                  <span class="text-xs font-medium text-blue-700 dark:text-blue-300"
                    >{$_('wifiSelector.dialog.connecting')}</span>
                </div>
              {:else if uuid}
                <div class="flex items-center gap-1.5">
                  {#if availableNetwork.active}
                    <Button
                      size="sm"
                      onclick={() => disconnectWifi(uuid, availableNetwork)}
                      class="h-9 bg-gradient-to-r from-orange-500 to-orange-600 px-3 text-white shadow-sm transition-all duration-200 hover:from-orange-600 hover:to-orange-700">
                      <Unlink class="h-3 w-3" />
                      <span class="ml-1.5 hidden text-xs font-medium sm:inline"
                        >{$_('wifiSelector.button.disconnect')}</span>
                    </Button>
                  {:else}
                    <Button
                      size="sm"
                      onclick={() => handleWifiConnect(uuid, availableNetwork)}
                      class="h-9 bg-gradient-to-r from-blue-500 to-blue-600 px-3 text-white shadow-sm transition-all duration-200 hover:from-blue-600 hover:to-blue-700">
                      <Link class="h-3 w-3" />
                      <span class="ml-1.5 hidden text-xs font-medium sm:inline"
                        >{$_('wifiSelector.button.connect')}</span>
                    </Button>
                  {/if}
                  <SimpleAlertDialog
                    title={$_('wifiSelector.dialog.forgetNetwork')}
                    confirmButtonText={$_('wifiSelector.button.forget')}
                    extraButtonClasses="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-medium"
                    buttonClasses="h-9 w-9 p-0 bg-gradient-to-r from-gray-100 to-gray-200 hover:from-red-100 hover:to-red-200 text-gray-600 hover:text-red-600 transition-all duration-200 shadow-sm dark:from-gray-700 dark:to-gray-800 dark:hover:from-red-900/30 dark:hover:to-red-800/30 dark:text-gray-400 dark:hover:text-red-400"
                    class="max-w-[95vw] sm:max-w-md"
                    onconfirm={() => forgetWifi(uuid, availableNetwork)}>
                    {#snippet icon()}
                      <Trash2 class="h-3 w-3" />
                    {/snippet}
                    {#snippet dialogTitle()}
                      <div class="space-y-2">
                        <h3 class="font-semibold">
                          {$_('wifiSelector.dialog.disconnectFrom', { values: { ssid: '' } })}
                        </h3>
                        <div class="rounded-lg bg-gray-100 p-2 dark:bg-gray-800">
                          <p class="font-mono text-sm break-all">{availableNetwork.ssid}</p>
                        </div>
                      </div>
                    {/snippet}
                    {#snippet description()}
                      <div class="space-y-3">
                        <p class="text-muted-foreground text-sm">
                          {$_('wifiSelector.dialog.confirmForget', {
                            values: { ssid: '', network: networkRename(wifi.ifname) },
                          })}
                        </p>
                      </div>
                    {/snippet}
                  </SimpleAlertDialog>
                </div>
              {:else}
                <SimpleAlertDialog
                  confirmButtonText={$_('wifiSelector.button.connect')}
                  extraButtonClasses="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-medium transition-all duration-200"
                  buttonClasses="h-9 bg-gradient-to-r from-blue-500 to-blue-600 px-3 text-white transition-all duration-200 hover:from-blue-600 hover:to-blue-700 shadow-sm text-xs font-medium"
                  class="max-w-[95vw] sm:max-w-md"
                  onconfirm={() => {
                    handleNewWifiConnect(availableNetwork.ssid, networkPassword);
                  }}
                  oncancel={() => {
                    networkPassword = '';
                    showPassword = false;
                  }}>
                  {#snippet dialogTitle()}
                    <div class="space-y-2">
                      <h3 class="font-semibold">{$_('wifiSelector.dialog.connectTo', { values: { ssid: '' } })}</h3>
                      <div
                        class="rounded-lg border border-blue-200 bg-blue-50 p-2 dark:border-blue-800 dark:bg-blue-950/30">
                        <p class="font-mono text-sm break-all text-blue-800 dark:text-blue-200">
                          {availableNetwork.ssid}
                        </p>
                      </div>
                    </div>
                  {/snippet}
                  {#snippet icon()}
                    <Link class="h-3 w-3" />
                  {/snippet}
                  {#snippet description()}
                    <div class="space-y-4">
                      <p class="text-muted-foreground text-sm">
                        {$_('wifiSelector.dialog.introducePassword')}
                      </p>
                      <div class="relative">
                        <Input
                          bind:value={networkPassword}
                          id="password"
                          type={showPassword ? 'text' : 'password'}
                          placeholder={$_('wifiSelector.hotspot.placeholderPassword')}
                          class="focus:ring-opacity-20 h-10 w-full rounded-lg border-2 border-gray-200 bg-gray-50 px-3 pr-10 text-sm transition-all duration-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800/50" />
                        <button
                          type="button"
                          onclick={() => (showPassword = !showPassword)}
                          class="absolute top-1/2 right-3 -translate-y-1/2 text-gray-500 transition-colors hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                          aria-label={showPassword ? 'Hide password' : 'Show password'}>
                          {#if showPassword}
                            <EyeOff class="h-4 w-4" />
                          {:else}
                            <Eye class="h-4 w-4" />
                          {/if}
                        </button>
                      </div>
                    </div>
                  {/snippet}
                </SimpleAlertDialog>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </ScrollArea>

    <!-- Scan Button -->
    <Button
      disabled={scanning}
      onclick={handleWifiScan}
      class="h-11 w-full rounded-lg bg-gradient-to-r from-indigo-500 to-indigo-600 text-sm font-medium text-white shadow-md transition-all duration-200 hover:from-indigo-600 hover:to-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">
      {#if scanning}
        <div class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
        <span>{$_('wifiSelector.button.scanning')}</span>
      {:else}
        <ScanSearch class="mr-2 h-4 w-4" />
        {$_('wifiSelector.button.scan')}
      {/if}
    </Button>
  </div>
</SimpleAlertDialog>
