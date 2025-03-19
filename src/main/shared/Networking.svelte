<script lang="ts">
import { ArrowUpDown, Check, X } from 'lucide-svelte';
import { _ } from 'svelte-i18n';

import * as Card from '$lib/components/ui/card';
import { Toggle } from '$lib/components/ui/toggle';
import {
  convertBytesToKbids,
  getAvailableNetworks,
  getModemNetworkName,
  getTotalBandwidth,
  getUsedNetworks,
  networkRenameWithError,
  setNetif,
} from '$lib/helpers/NetworkHelper.js';
import { NetifMessages } from '$lib/stores/websocket-store';
import type { NetifMessage } from '$lib/types/socket-messages';
import { cn } from '$lib/utils';

let totalBandwith: number = $state(0);
let currentNetwoks: NetifMessage = $state({});

NetifMessages.subscribe((networks: NetifMessage) => {
  if (networks) {
    currentNetwoks = networks;
    totalBandwith = getTotalBandwidth(networks);
  }
});
</script>

<Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
  <div>
    <Card.Title class="text-primary">{$_('networking.card.networkInfoTitle')}</Card.Title>
    <Card.Description>
      {$_('networking.card.networkInfoDescription', {
        values: {
          total: Object.keys(currentNetwoks).length,
          available: getAvailableNetworks(currentNetwoks).length,
          used: getUsedNetworks(currentNetwoks).length,
          bandwidth: totalBandwith,
        },
      })}
    </Card.Description>
  </div>

  <ArrowUpDown class="text-muted-primary h-4 w-4" />
</Card.Header>
<Card.Content>
  <div class="space-y-8">
    {#each Object.entries(currentNetwoks) as [name, network]}
      <div class="flex items-center">
        <Toggle
          variant="outline"
          class={cn(network.enabled ? 'data-[state=on]:bg-green-600' : 'bg-red-600')}
          title={network.enabled ? $_('networking.toggle.disableNetwork') : $_('networking.toggle.enableNetwork')}
          disabled={!!network.error}
          bind:pressed={network.enabled}
          onPressedChange={value => setNetif(name, network.ip, value)}>
          {#if network.enabled}
            <Check></Check>
          {:else}
            <X></X>
          {/if}
        </Toggle>

        <div class="ml-4 space-y-1">
          <p class="text-sm leading-none font-medium">{networkRenameWithError(name, network.error)}</p>
          <p class="text-muted-foreground text-sm">IP: {network.ip}</p>
          <p class="text-muted-foreground text-sm">{$_('networking.card.identifier')}: {name}</p>
          {#if name.startsWith('ww')}
            <p class="text-muted-foreground text-sm">
              {$_('networking.modem.networkName')}: {getModemNetworkName(name)}
            </p>
          {/if}
        </div>
        <div class="ml-auto font-medium">{convertBytesToKbids(network.tp)} Kbps</div>
      </div>
    {/each}

    <div class="flex">
      <div class="text-primary ml-auto text-2xl font-bold">{totalBandwith} Kbps</div>
    </div>
  </div>
</Card.Content>
