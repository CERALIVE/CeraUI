<script lang="ts">
import { AlertCircle, ArrowUpDown, Check, Network, Signal, Wifi, X } from '@lucide/svelte';
import { _ } from 'svelte-i18n';

import * as Card from '$lib/components/ui/card';
import { Toggle } from '$lib/components/ui/toggle';
import {
  convertBytesToKbids,
  getAvailableNetworks,
  getModemNetworkName,
  getTotalBandwidth,
  getUsedNetworks,
  networkRename,
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

// Helper functions for better network categorization and display
function getNetworkIcon(name: string, enabled: boolean, hasError: boolean, isHotspot: boolean = false) {
  if (hasError && !isHotspot) return AlertCircle;
  if (name.startsWith('ww')) return Signal; // Modem/cellular
  if (name.startsWith('wl')) return Wifi; // WiFi
  return Network; // Ethernet/other
}

function getNetworkType(name: string, isHotspot: boolean = false) {
  if (isHotspot) return $_('networking.types.hotspot');
  if (name.startsWith('ww')) return $_('networking.types.cellular');
  if (name.startsWith('wl')) return $_('networking.types.wifi');
  return $_('networking.types.ethernet');
}

function isHotspotNetwork(name: string) {
  // Check if this is a hotspot network based on naming convention
  return name.includes('hotspot') || name.toLowerCase().includes('wlan1');
}

function getStatusColor(enabled: boolean, hasError: boolean, isHotspot: boolean = false) {
  // Hotspots are not treated as errors even if they have error states
  if (hasError && !isHotspot) return 'text-red-500';
  if (enabled) return 'text-green-500';
  if (isHotspot && !enabled) return 'text-blue-500'; // Hotspot ready but not active
  return 'text-muted-foreground';
}

function getBandwidthColor(bandwidth: number) {
  if (bandwidth === 0) return 'text-muted-foreground';
  if (bandwidth < 1000) return 'text-yellow-500';
  if (bandwidth < 5000) return 'text-blue-500';
  return 'text-green-500';
}

function getNetworkPriority(name: string, enabled: boolean, isHotspot: boolean) {
  // Sort order: enabled networks first, then by type priority
  if (enabled) return isHotspot ? 1 : name.startsWith('ww') ? 2 : name.startsWith('wl') ? 3 : 4;
  return isHotspot ? 5 : name.startsWith('ww') ? 6 : name.startsWith('wl') ? 7 : 8;
}
</script>

<Card.Header>
  <Card.Title class="flex items-center gap-2">
    <ArrowUpDown class="h-5 w-5" />
    {$_('network.summary.networkInfo')}
  </Card.Title>
  <Card.Description>
    {$_('network.summary.networksActive', {
      values: {
        count: Object.keys(currentNetwoks).length,
        active: getUsedNetworks(currentNetwoks).length,
        total: totalBandwith,
      },
    })}
  </Card.Description>
</Card.Header>
<Card.Content class="space-y-4">
  {#if Object.keys(currentNetwoks).length === 0}
    <!-- Empty State -->
    <div class="flex flex-col items-center justify-center space-y-4 py-12 text-center">
      <div class="bg-muted rounded-full p-4">
        <Network class="text-muted-foreground h-8 w-8" />
      </div>
      <div class="space-y-2">
        <h3 class="font-medium">{$_('network.emptyStates.noNetworksDetected')}</h3>
        <p class="text-muted-foreground text-sm">{$_('network.emptyStates.noNetworkInterfaces')}</p>
      </div>
    </div>
  {:else}
    <!-- Network List -->
    <div class="space-y-3">
      {#each Object.entries(currentNetwoks).sort(([nameA, networkA], [nameB, networkB]) => {
        const isHotspotA = isHotspotNetwork(nameA);
        const isHotspotB = isHotspotNetwork(nameB);
        return getNetworkPriority(nameA, networkA.enabled, isHotspotA) - getNetworkPriority(nameB, networkB.enabled, isHotspotB);
      }) as [name, network]}
        {@const isHotspot = isHotspotNetwork(name)}
        {@const Icon = getNetworkIcon(name, network.enabled, !!network.error, isHotspot)}
        {@const bandwidth = convertBytesToKbids(network.tp)}
        {@const hasRealError = !!network.error && !isHotspot}

        <!-- Mobile-First Simple Network Card -->
        <div
          class={cn(
            'bg-card rounded-lg border transition-colors duration-200',
            network.enabled ? 'border-green-200 dark:border-green-800' : 'border-border',
            isHotspot && !network.enabled ? 'border-blue-200 dark:border-blue-800' : '',
            hasRealError ? 'border-red-200 dark:border-red-800' : '',
          )}>
          <!-- Status Bar at Top -->
          <div
            class={cn(
              'h-1 w-full',
              network.enabled
                ? 'bg-green-500'
                : isHotspot
                  ? 'bg-blue-500'
                  : hasRealError
                    ? 'bg-red-500'
                    : 'bg-gray-300 dark:bg-gray-700',
            )}>
          </div>

          <div class="p-4">
            <!-- Header: Icon + Name + Status -->
            <div class="mb-3 flex items-start justify-between">
              <div class="flex min-w-0 flex-1 items-center gap-3">
                <!-- Simple Icon -->
                <div
                  class={cn(
                    'flex-shrink-0 rounded-lg p-2',
                    network.enabled
                      ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'
                      : isHotspot
                        ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                        : hasRealError
                          ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
                  )}>
                  <Icon class="h-4 w-4" />
                </div>

                <!-- Network Name and Type -->
                <div class="min-w-0 flex-1">
                  <h3 class="truncate text-sm font-medium">
                    {isHotspot ? networkRename(name) : networkRenameWithError(name, network.error)}
                  </h3>
                  <p class="text-muted-foreground text-xs">{getNetworkType(name, isHotspot)}</p>
                </div>
              </div>

              <!-- Status Badge -->
              <div
                class={cn(
                  'inline-flex flex-shrink-0 items-center rounded-full px-2 py-1 text-xs font-medium',
                  network.enabled
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                    : isHotspot
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                      : hasRealError
                        ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                        : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
                )}>
                {network.enabled
                  ? $_('network.status.active')
                  : isHotspot
                    ? $_('network.status.ready')
                    : $_('network.status.inactive')}
              </div>
            </div>

            <!-- Details Grid -->
            <div class="mb-4 space-y-2">
              <div class="flex items-center justify-between text-sm">
                <span class="text-muted-foreground">{$_('networking.labels.interface')}</span>
                <code class="bg-muted rounded px-2 py-1 font-mono text-xs">{name}</code>
              </div>
              <div class="flex items-center justify-between text-sm">
                <span class="text-muted-foreground">{$_('networking.labels.ipAddress')}</span>
                <code class="bg-muted rounded px-2 py-1 font-mono text-xs">{network.ip}</code>
              </div>
              <div class="flex items-center justify-between text-sm">
                <span class="text-muted-foreground">{$_('networking.labels.bandwidth')}</span>
                <span class={cn('font-mono text-xs font-bold', getBandwidthColor(bandwidth))}>
                  {$_('network.summary.totalBandwidth', { values: { total: bandwidth } })}
                </span>
              </div>
              {#if name.startsWith('ww')}
                <div class="flex items-center justify-between text-sm">
                  <span class="text-muted-foreground">{$_('networking.labels.network')}</span>
                  <span class="text-xs">{getModemNetworkName(name)}</span>
                </div>
              {/if}
            </div>

            <!-- Toggle Control (only for non-hotspot networks) -->
            {#if !isHotspot}
              <div class="flex justify-end">
                <Toggle
                  variant="outline"
                  size="sm"
                  class={cn(
                    'h-auto px-3 py-1.5 transition-colors',
                    network.enabled
                      ? 'data-[state=on]:border-green-600 data-[state=on]:bg-green-600 data-[state=on]:text-white'
                      : '',
                    hasRealError ? 'cursor-not-allowed opacity-50' : '',
                  )}
                  disabled={hasRealError}
                  bind:pressed={network.enabled}
                  onPressedChange={value => setNetif(name, network.ip, value)}>
                  {#if network.enabled}
                    <Check class="mr-1 h-3 w-3" />
                    {$_('network.status.active')}
                  {:else}
                    <X class="mr-1 h-3 w-3" />
                    {$_('network.status.inactive')}
                  {/if}
                </Toggle>
              </div>
            {/if}

            <!-- Error Message -->
            {#if hasRealError}
              <div
                class="mt-3 flex items-center gap-2 rounded-md bg-red-100 p-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
                <AlertCircle class="h-4 w-4 flex-shrink-0" />
                <span>{$_('network.errors.networkConnectionError')}</span>
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    <!-- Summary Footer -->
    <div class="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="text-muted-foreground flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:gap-4">
        <span
          >{$_('network.summary.activeNetworks', {
            values: { active: getUsedNetworks(currentNetwoks).length, total: Object.keys(currentNetwoks).length },
          })}</span>
        <span class="hidden sm:inline">•</span>
        <span>{getAvailableNetworks(currentNetwoks).length} {$_('network.summary.available')}</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-muted-foreground text-sm">{$_('network.summary.availableBandwidth')}</span>
        <span class={cn('font-mono text-lg font-bold', getBandwidthColor(totalBandwith))}>
          {$_('network.summary.totalBandwidth', { values: { total: totalBandwith } })}
        </span>
      </div>
    </div>
  {/if}
</Card.Content>
