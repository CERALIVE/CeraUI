<style>
.animation-delay-75 {
  animation-delay: 75ms;
}
.animation-delay-150 {
  animation-delay: 150ms;
}
</style>

<script lang="ts">
import { Antenna, Signal, SignalHigh, SignalLow, SignalMedium } from '@lucide/svelte';
import { _ } from 'svelte-i18n';

import * as Card from '$lib/components/ui/card';
import type { StatusMessage } from '$lib/types/socket-messages';
import { capitalizeFirstLetter, cn } from '$lib/utils.js';

import ModemConfigurator from './ModemConfigurator.svelte';

interface Props {
  modem: StatusMessage['modems'][keyof StatusMessage['modems']];
  deviceId: string;
}

let { modem, deviceId }: Props = $props();

function getSignalIcon(signal: number) {
  if (signal >= 75) return SignalHigh;
  if (signal >= 50) return SignalMedium;
  if (signal >= 25) return SignalLow;
  return Signal;
}

function getSignalColor(signal: number) {
  if (signal >= 75) return 'text-green-600 dark:text-green-400';
  if (signal >= 50) return 'text-yellow-600 dark:text-yellow-400';
  if (signal >= 25) return 'text-orange-600 dark:text-orange-400';
  return 'text-red-600 dark:text-red-400';
}

function getConnectionStatusColor(status: string) {
  switch (status) {
    case 'connected':
      return 'text-green-600 dark:text-green-400';
    case 'connecting':
      return 'text-blue-600 dark:text-blue-400';
    case 'scanning':
      return 'text-amber-600 dark:text-amber-400';
    case 'disconnected':
      return 'text-red-600 dark:text-red-400';
    default:
      return 'text-muted-foreground';
  }
}

function getCardBorderClass(status: string) {
  switch (status) {
    case 'connected':
      return 'border-green-500/20 bg-gradient-to-br from-green-50/50 to-card dark:from-green-950/20';
    case 'connecting':
      return 'border-blue-500/20 bg-gradient-to-br from-blue-50/50 to-card dark:from-blue-950/20';
    case 'scanning':
      return 'border-amber-500/20 bg-gradient-to-br from-amber-50/50 to-card dark:from-amber-950/20';
    default:
      return 'border-border bg-gradient-to-br from-card to-card/50';
  }
}

function getStatusGradient(status: string) {
  switch (status) {
    case 'connected':
      return 'bg-gradient-to-r from-green-500 to-emerald-500';
    case 'connecting':
      return 'bg-gradient-to-r from-blue-500 to-cyan-500';
    case 'scanning':
      return 'bg-gradient-to-r from-amber-500 to-orange-500';
    default:
      return 'bg-gradient-to-r from-red-500 to-red-600';
  }
}

const signalValue = $derived(modem.status?.signal ?? 0);
const connectionStatus = $derived(modem.status.connection);
const SignalIcon = $derived(getSignalIcon(signalValue));
</script>

<Card.Root
  class={cn(
    'group relative overflow-hidden transition-all duration-300 hover:scale-[1.02] hover:shadow-md',
    getCardBorderClass(connectionStatus),
  )}>
  <!-- Status Indicator -->
  <div class={cn('absolute top-0 left-0 h-1 w-full transition-all duration-300', getStatusGradient(connectionStatus))}>
  </div>

  <Card.Header class="pb-3">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <!-- Modem Icon with Signal Indicator -->
        <div class="relative">
          <div
            class={cn(
              'rounded-full p-2 transition-colors',
              connectionStatus === 'connected'
                ? 'bg-green-500/10'
                : connectionStatus === 'connecting'
                  ? 'bg-blue-500/10'
                  : connectionStatus === 'scanning'
                    ? 'bg-amber-500/10'
                    : 'bg-red-500/10',
            )}>
            <Antenna class={cn('h-5 w-5', getConnectionStatusColor(connectionStatus))} />
          </div>
          <!-- Signal strength dot -->
          <div
            class={cn(
              'ring-background absolute -top-1 -right-1 h-3 w-3 rounded-full ring-2',
              signalValue >= 75
                ? 'bg-green-500'
                : signalValue >= 50
                  ? 'bg-yellow-500'
                  : signalValue >= 25
                    ? 'bg-orange-500'
                    : 'bg-red-500',
            )}>
          </div>
        </div>

        <div>
          <Card.Title class="text-sm font-semibold">
            {modem.name.replace('| Unknown', '')}
          </Card.Title>
          <span
            class={cn(
              'inline-flex items-center rounded-full px-2 py-1 text-xs font-medium',
              connectionStatus === 'connected'
                ? 'bg-green-500/10 text-green-700 dark:text-green-300'
                : connectionStatus === 'connecting'
                  ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
                  : connectionStatus === 'scanning'
                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                    : 'bg-red-500/10 text-red-700 dark:text-red-300',
            )}>
            {capitalizeFirstLetter($_('network.modem.connectionStatus.' + connectionStatus))}
          </span>
        </div>
      </div>
    </div>
  </Card.Header>

  <Card.Content class="flex h-full flex-col">
    <!-- Signal and Network Info - Flexible Content -->
    <div class="flex-1 space-y-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <SignalIcon class={cn('h-4 w-4', getSignalColor(signalValue))} />
          <span class="text-muted-foreground text-sm font-medium">{$_('network.modem.signal')}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class={cn('font-mono text-sm font-bold', getSignalColor(signalValue))}>
            {signalValue}%
          </span>
          <div class="flex gap-1">
            {#each Array(4) as _, i}
              <div
                class={cn(
                  'h-3 w-1 rounded-full transition-colors',
                  signalValue > i * 25 ? getSignalColor(signalValue).replace('text-', 'bg-') : 'bg-muted',
                )}>
              </div>
            {/each}
          </div>
        </div>
      </div>

      {#if modem.status.network_type}
        <div class="flex items-center justify-between text-sm">
          <span class="text-muted-foreground font-medium">{$_('network.modem.network')}</span>
          <span class="font-mono font-semibold">{modem.status.network_type}</span>
        </div>
      {/if}

      <!-- Additional Status Info -->
      {#if connectionStatus === 'scanning'}
        <div class="flex items-center justify-center py-4">
          <div class="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"></div>
            <span class="text-sm">{$_('network.status.scanningNetworks')}</span>
          </div>
        </div>
      {:else if connectionStatus === 'connecting'}
        <div class="flex items-center justify-center py-4">
          <div class="flex items-center gap-2 text-blue-600 dark:text-blue-400">
            <div class="h-2 w-2 animate-pulse rounded-full bg-current"></div>
            <div class="animation-delay-75 h-2 w-2 animate-pulse rounded-full bg-current"></div>
            <div class="animation-delay-150 h-2 w-2 animate-pulse rounded-full bg-current"></div>
            <span class="ml-2 text-sm">{$_('network.status.connecting')}</span>
          </div>
        </div>
      {:else if connectionStatus === 'disconnected'}
        <div class="flex flex-col items-center justify-center space-y-2 py-4 text-center">
          <div class="bg-muted rounded-full p-3">
            <Antenna class="text-muted-foreground h-6 w-6" />
          </div>
          <p class="text-muted-foreground text-sm">{$_('network.status.notConnected')}</p>
        </div>
      {/if}
    </div>

    <!-- Modem Configuration - Always at Bottom -->
    <div class="mt-1 border-t pt-2">
      <ModemConfigurator modemIsScanning={connectionStatus === 'scanning'} {modem} {deviceId} />
    </div>
  </Card.Content>
</Card.Root>
