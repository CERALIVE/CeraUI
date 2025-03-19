<script lang="ts">
import { Link, ScanSearch, Trash2, Unlink } from 'lucide-svelte';
import { _ } from 'svelte-i18n';
import { toast } from 'svelte-sonner';

import WifiQuality from '$lib/components/icons/WifiQuality.svelte';
import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
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
let open = $state(false);

let connecting: string | undefined = $state();
let scanning = $state(false);

WifiMessages.subscribe(wifiMessage => {
  if (wifiMessage) {
    if (wifiMessage.new?.error) {
      toast.error('WiFi connection error', {
        description:
          'It was not possible to connect to the selected WiFi network, check the password or get closer to it and try again',
      });
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
};
</script>

<SimpleAlertDialog
  confirmButtonText={$_('wifiSelector.dialog.close')}
  hiddeCancelButton={true}
  class="max-w-(--breakpoint-sm)"
  bind:open
  title={$_('wifiSelector.dialog.searchWifi')}
  extraButtonClasses="bg-green-500 hover:bg-green-500/90">
  {#snippet icon()}
    <ScanSearch></ScanSearch>
  {/snippet}
  {#snippet dialogTitle()}
    {$_('wifiSelector.dialog.availableNetworks', { values: { network: networkRename(wifi.ifname) } })}
  {/snippet}
  <Card.Root class="col-span-3 pr-0">
    <ScrollArea class="h-96 w-100" type="auto">
      <Card.Content class="pt-0">
        <div class="space-y-0">
          {#each wifi.available as availableNetwork, index}
            {@const uuid = getWifiUUID(availableNetwork, wifi.saved)}
            {@const isConnecting =
              connecting !== undefined && (connecting === uuid || connecting === availableNetwork.ssid)}
            <div class={cn('flex items-center p-2 pr-4', index ? 'border-t-2' : 'mt-2', uuid ? '' : 'cursor-pointer')}>
              <WifiQuality signal={availableNetwork.signal} class="size-8" />
              <div class="ml-2 space-y-2 text-left">
                <p class="pt-0 pb-0 text-sm leading-none font-medium">{availableNetwork.ssid}</p>
                <p class="text-muted-foreground mt-0 mb-0 pt-0 pb-0 text-sm">
                  {availableNetwork.security.replaceAll(' ', ', ')}
                </p>
              </div>
              <div class="ml-auto font-medium">
                {#if isConnecting}
                  <span class="loading w-[25%] text-left">{$_('wifiSelector.dialog.connecting')}</span>
                {:else if uuid}
                  {#if availableNetwork.active}
                    <Button variant="secondary" onclick={() => disconnectWifi(uuid, availableNetwork)}>
                      <span class="hidden md:block">{$_('wifiSelector.button.disconnect')}</span>
                      <span class="sm:hidden"><Unlink class="w-4"></Unlink></span>
                    </Button>
                  {:else}
                    <Button variant="secondary" onclick={() => handleWifiConnect(uuid, availableNetwork)}>
                      <span class="hidden md:block">{$_('wifiSelector.button.connect')}</span>
                      <span class="sm:hidden"><Link class="w-4"></Link></span>
                    </Button>
                  {/if}
                  <SimpleAlertDialog
                    title={$_('wifiSelector.dialog.forgetNetwork')}
                    confirmButtonText={$_('wifiSelector.button.forget')}
                    onconfirm={() => forgetWifi(uuid, availableNetwork)}>
                    {#snippet dialogTitle()}
                      {$_('wifiSelector.dialog.disconnectFrom', { values: { ssid: availableNetwork.ssid } })}
                    {/snippet}
                    {#snippet icon()}
                      <span class="hidden sm:block">{$_('wifiSelector.button.forget')}</span>
                      <Trash2 class="w-4 sm:block md:hidden"></Trash2>
                    {/snippet}
                    {#snippet description()}
                      {$_('wifiSelector.dialog.confirmForget', {
                        values: { ssid: availableNetwork.ssid, network: networkRename(wifi.ifname) },
                      })}
                    {/snippet}
                  </SimpleAlertDialog>
                {:else}
                  <SimpleAlertDialog
                    confirmButtonText={$_('wifiSelector.button.connect')}
                    extraButtonClasses="bg-secondary text-secondary-foreground hover:bg-secondary/80"
                    onconfirm={() => {
                      handleNewWifiConnect(availableNetwork.ssid, networkPassword);
                    }}
                    oncancel={() => (networkPassword = '')}>
                    {#snippet dialogTitle()}
                      {$_('wifiSelector.dialog.connectTo', { values: { ssid: availableNetwork.ssid } })}
                    {/snippet}
                    {#snippet icon()}
                      <span class="hidden sm:block">{$_('wifiSelector.button.connect')}</span>
                      <Link class="w-4 sm:block md:hidden"></Link>
                    {/snippet}
                    {#snippet description()}
                      {$_('wifiSelector.dialog.introducePassword')}
                    {/snippet}
                    <Input
                      bind:value={networkPassword}
                      id="password"
                      type="password"
                      placeholder={$_('wifiSelector.hotspot.placeholderPassword')}></Input>
                  </SimpleAlertDialog>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </Card.Content>
    </ScrollArea>
    <Button disabled={scanning} class="w-[100%] bg-green-600 hover:bg-green-500/90" onclick={handleWifiScan}>
      <span class={scanning ? 'loading' : ''}
        >{scanning ? $_('wifiSelector.button.scanning') : $_('wifiSelector.button.scan')}</span
      ></Button>
  </Card.Root>
</SimpleAlertDialog>
