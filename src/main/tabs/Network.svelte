<script lang="ts">
import HotspotConfigurator from '../shared/HotspotConfigurator.svelte';
import ModemConfigurator from '../shared/ModemConfigurator.svelte';
import Networking from '../shared/Networking.svelte';
import WifiSelector from '../shared/WifiSelector.svelte';
import { Antenna, EyeIcon, Router, Wifi, WifiOff } from 'lucide-svelte';
import { _ } from 'svelte-i18n';
import type { StatusMessage } from '$lib/types/socket-messages';
import WifiQuality from '$lib/components/icons/WifiQuality.svelte';
import * as Card from '$lib/components/ui/card';
import SimpleAlertDialog from '$lib/components/ui/simple-alert-dialog.svelte';

import {
  getConnection,
  getWifiBand,
  getWifiStatus,
  networkRename,
  turnHotspotModeOff,
  turnHotspotModeOn,
} from '$lib/helpers/NetworkHelper';
import { StatusMessages } from '$lib/stores/websocket-store';
import { capitalizeFirstLetter } from '$lib/utils.js';

let currentStatus: StatusMessage | undefined = $state();
StatusMessages.subscribe(status => {
  currentStatus = status;
});
</script>

<div class="flex-col md:flex">
  <div class="flex-1 space-y-4 p-8 pt-6">
    <div class="grid gap-4 md:grid-cols-7 lg:grid-cols-7">
      <Card.Root class="col-span-4 sm:col-span-4 md:col-span-3">
        <Networking />
      </Card.Root>
      <div class="col-span-4 grid grid-rows-2 gap-4 md:grid-cols-4 lg:grid-cols-4">
        {#if currentStatus}
          {#each Object.values(currentStatus.wifi) as wifi, deviceId (deviceId)}
            {@const wifiStatus = getWifiStatus(wifi)}
            {@const connection = getConnection(wifi)}
            <Card.Root class="col-span-4 row-span-2 sm:col-span-2">
              <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
                <Card.Title class="text-sm font-medium">
                  {networkRename(wifi.ifname)}
                </Card.Title>
                <Wifi class="h-4 w-4 text-muted-foreground" />
              </Card.Header>
              <Card.Content>
                <div class="text-2xl font-bold">
                  {capitalizeFirstLetter($_(`wifiStatus.${wifiStatus}`))}
                </div>

                {#if wifi.hotspot}
                  <p class="text-xs text-muted-foreground">
                    <b>{$_('network.hotspot.name')}</b>: {wifi.hotspot.name}
                  </p>
                  <p class="text-xs text-muted-foreground">
                    <b>{$_('network.hotspot.channel')}</b>: {wifi.hotspot.channel}
                  </p>
                {:else if connection}
                  <div class="flex grid-cols-12 content-center font-bold text-muted-foreground">
                    <p>{$_('network.wifi.strength')}:</p>
                    <WifiQuality class="ml-1" signal={connection?.signal} />
                  </div>
                  <p class="text-xs text-muted-foreground">
                    <b>{$_('network.wifi.ssid')}</b>: {connection?.ssid}
                  </p>
                  <p class="text-xs text-muted-foreground">
                    <b>{$_('network.wifi.security')}</b>: {connection.security}
                  </p>
                  <p class="text-xs text-muted-foreground">
                    <b>{$_('network.wifi.band')}</b>: {getWifiBand(connection.freq)}
                  </p>
                {/if}
                <div class="pt-2">
                  {#if wifi.hotspot}
                    <HotspotConfigurator {wifi} {deviceId}></HotspotConfigurator>
                    <SimpleAlertDialog
                      confirmButtonText={$_('network.dialog.close')}
                      hiddeCancelButton={true}
                      title={$_('network.dialog.hotspotDetails')}>
                      {#snippet icon()}
                        <EyeIcon></EyeIcon>
                      {/snippet}
                      {#snippet dialogTitle()}
                        {$_('network.dialog.hotspotDetails')}
                      {/snippet}
                      {#snippet description()}
                        <p>{$_('network.hotspot.name')}: <b>{wifi.hotspot?.name}</b></p>
                        <p>{$_('network.hotspot.password')}: <b>{wifi.hotspot?.password}</b></p>
                      {/snippet}
                    </SimpleAlertDialog>
                    <SimpleAlertDialog
                      confirmButtonText={$_('network.dialog.turnOff')}
                      extraButtonClasses="bg-yellow-600 hover:bg-yellow-600/90"
                      title={$_('network.dialog.turnHotspotOff')}
                      onconfirm={() => turnHotspotModeOff(deviceId)}>
                      {#snippet icon()}
                        <WifiOff></WifiOff>
                      {/snippet}
                      {#snippet dialogTitle()}
                        {$_('network.dialog.turnHotspotOff')}
                      {/snippet}
                      {#snippet description()}
                        {$_('network.dialog.turnHotspotOffDescription')}
                      {/snippet}
                    </SimpleAlertDialog>
                  {:else}
                    <WifiSelector {wifi} wifiId={deviceId}></WifiSelector>
                    <SimpleAlertDialog
                      confirmButtonText={$_('network.dialog.turnOn')}
                      extraButtonClasses="bg-yellow-600 hover:bg-yellow-600/90"
                      title={$_('network.dialog.turnHotspotOn')}
                      onconfirm={() => turnHotspotModeOn(deviceId)}>
                      {#snippet icon()}
                        <Router></Router>
                      {/snippet}
                      {#snippet dialogTitle()}
                        {$_('network.dialog.turnHotspotOn')}
                      {/snippet}
                      {#snippet description()}
                        {$_('network.dialog.turnHotspotOnDescription')}
                      {/snippet}
                    </SimpleAlertDialog>
                  {/if}
                </div>
              </Card.Content>
            </Card.Root>
          {/each}
        {/if}
      </div>
    </div>
  </div>
  <div class="flex-1 space-y-4 p-8 pt-6">
    <div class="col-span-4 grid grid-rows-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
      {#if currentStatus?.modems && Object.keys(currentStatus.modems).length}
        {#each Object.entries(currentStatus.modems) as [deviceId, modem]}
          <Card.Root class="col-span-4 row-span-2 sm:col-span-2 md:col-span-3 lg:col-span-2">
            <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
              <div>
                <Card.Title class="text-sm font-medium">Modem: {modem.name.replace('| Unknown', '')}</Card.Title>
                <Card.Description>
                  <div class="grid grid-cols-12 content-center text-muted-foreground">
                    <span class="col-span-12 flex">
                      <p class="font-bold">{$_('network.modem.status')}</p>
                      <span>
                        {`: ${capitalizeFirstLetter($_('network.modem.connectionStatus.' + modem.status.connection))} `}
                      </span>
                    </span>
                    <div class="col-span-12 flex">
                      <span class="mr-2 flex">
                        <p class="font-bold">{$_('network.modem.signal')}</p>
                        <span>{`: ${modem.status?.signal ?? 0}%`}</span>
                      </span>
                      {#if modem.status.network_type}
                        <span class="mr-2 flex">
                          <p class="font-bold">{$_('network.modem.network')}</p>
                          <span>
                            {`: ${modem.status.network_type} `}
                          </span>
                        </span>
                      {/if}
                    </div>
                  </div>
                </Card.Description>
              </div>
              <Antenna class="h-4 w-4 text-muted-foreground" />
            </Card.Header>
            <Card.Content>
              <ModemConfigurator modemIsScanning={modem.status.connection === 'scanning'} {modem} {deviceId}
              ></ModemConfigurator>
            </Card.Content>
          </Card.Root>
        {/each}
      {/if}
    </div>
  </div>
</div>
