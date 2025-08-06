<script lang="ts">
import { Network, Radio, Wifi } from '@lucide/svelte';
import { _ } from 'svelte-i18n';

import * as Card from '$lib/components/ui/card';
import { StatusMessages } from '$lib/stores/websocket-store';
import type { StatusMessage } from '$lib/types/socket-messages';

import ModemCard from '../shared/ModemCard.svelte';
import Networking from '../shared/Networking.svelte';
import WiFiCard from '../shared/WiFiCard.svelte';

let currentStatus: StatusMessage | undefined = $state();
StatusMessages.subscribe(status => {
  currentStatus = status;
});
</script>

<div class="flex flex-col space-y-8 p-6">
  <!-- Page Header -->
  <div class="space-y-2">
    <h1 class="text-3xl font-bold tracking-tight">{$_('network.pageTitle')}</h1>
    <p class="text-muted-foreground">{$_('network.pageDescription')}</p>
  </div>

  <!-- Network Interfaces Section -->
  <section class="space-y-4">
    <div class="flex items-center gap-2">
      <Network class="text-primary h-5 w-5" />
      <h2 class="text-xl font-semibold">{$_('network.sections.networkInterfaces')}</h2>
    </div>
    <Card.Root>
      <Networking />
    </Card.Root>
  </section>

  <!-- WiFi Devices Section -->
  {#if currentStatus?.wifi && Object.keys(currentStatus.wifi).length > 0}
    <section class="space-y-4">
      <div class="flex items-center gap-2">
        <Wifi class="text-primary h-5 w-5" />
        <h2 class="text-xl font-semibold">{$_('network.sections.wifiDevices')}</h2>
        <span class="bg-muted text-muted-foreground rounded-full px-2 py-1 text-xs font-medium">
          {Object.keys(currentStatus.wifi).length}
          {Object.keys(currentStatus.wifi).length === 1
            ? $_('network.deviceCount.device')
            : $_('network.deviceCount.devices')}
        </span>
      </div>

      <div class="grid gap-4 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each Object.values(currentStatus.wifi) as wifi, deviceId (deviceId)}
          <WiFiCard {wifi} {deviceId} />
        {/each}
      </div>
    </section>
  {/if}

  <!-- Cellular Modems Section -->
  {#if currentStatus?.modems && Object.keys(currentStatus.modems).length > 0}
    <section class="space-y-4">
      <div class="flex items-center gap-2">
        <Radio class="text-primary h-5 w-5" />
        <h2 class="text-xl font-semibold">{$_('network.sections.cellularModems')}</h2>
        <span class="bg-muted text-muted-foreground rounded-full px-2 py-1 text-xs font-medium">
          {Object.keys(currentStatus.modems).length}
          {Object.keys(currentStatus.modems).length === 1
            ? $_('network.deviceCount.modem')
            : $_('network.deviceCount.modems')}
        </span>
      </div>

      <div class="grid gap-4 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each Object.entries(currentStatus.modems) as [deviceId, modem]}
          <ModemCard {modem} {deviceId} />
        {/each}
      </div>
    </section>
  {/if}

  <!-- Empty States -->
  {#if !currentStatus}
    <div class="flex flex-col items-center justify-center space-y-4 py-16 text-center">
      <div class="bg-muted rounded-full p-4">
        <Network class="text-muted-foreground h-8 w-8" />
      </div>
      <div class="space-y-2">
        <h3 class="font-medium">{$_('network.emptyStates.loadingStatus')}</h3>
        <p class="text-muted-foreground text-sm">{$_('network.emptyStates.pleaseWait')}</p>
      </div>
    </div>
  {:else if (!currentStatus.wifi || Object.keys(currentStatus.wifi).length === 0) && (!currentStatus.modems || Object.keys(currentStatus.modems).length === 0)}
    <div class="flex flex-col items-center justify-center space-y-4 py-16 text-center">
      <div class="bg-muted rounded-full p-4">
        <Wifi class="text-muted-foreground h-8 w-8" />
      </div>
      <div class="space-y-2">
        <h3 class="font-medium">{$_('network.emptyStates.noDevicesFound')}</h3>
        <p class="text-muted-foreground text-sm">{$_('network.emptyStates.noDevicesDescription')}</p>
      </div>
    </div>
  {/if}
</div>
