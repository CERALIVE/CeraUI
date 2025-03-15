<script lang="ts">
import Networking from '../shared/Networking.svelte';
import { RadioTower, Server, ServerOff, SquareChartGantt, Thermometer } from 'lucide-svelte';
import { _ } from 'svelte-i18n';
import { Update } from 'svelte-radix';
import type { ConfigMessage, NetifMessage, StatusMessage } from '$lib/types/socket-messages';
import * as Card from '$lib/components/ui/card';
import SimpleAlertDialog from '$lib/components/ui/simple-alert-dialog.svelte';
import { getUsedNetworks } from '$lib/helpers/NetworkHelper';
import { installSoftwareUpdates } from '$lib/helpers/SystemHelper';
import { ConfigMessages, NetifMessages, SensorsStatusMessages, StatusMessages } from '$lib/stores/websocket-store';
import { cn } from '$lib/utils';

let temperature: Array<[string, string]> = $state([]);
let currentStatus: StatusMessage | undefined = $state(undefined);
let currentNetworks: NetifMessage | undefined = $state();
let currentConfig: ConfigMessage | undefined = $state();
NetifMessages.subscribe((networks: NetifMessage) => {
  currentNetworks = networks;
});

ConfigMessages.subscribe(config => {
  currentConfig = config;
});

SensorsStatusMessages.subscribe(sensors => {
  if (sensors) {
    temperature = Object.entries(sensors);
  }
});

StatusMessages.subscribe(status => {
  currentStatus = status;
});
</script>

<div class=" flex-col md:flex">
  <div class="flex-1 space-y-4 p-8 pt-6">
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card.Root>
        <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
          <Card.Title class="text-sm font-medium">{$_('general.status')}</Card.Title>
          <RadioTower class="h-4 w-4 text-muted-foreground" />
        </Card.Header>
        <Card.Content>
          <div class={cn((currentStatus?.is_streaming ? 'text-green-500 ' : 'text-amber-500 ') + 'text-2xl font-bold')}>
            {currentStatus?.is_streaming ? $_('general.streaming') : $_('general.offline')}
          </div>
          {#if currentNetworks && currentStatus?.is_streaming}
            <p class="text-xs text-muted-foreground">
              {$_('general.streamingMessage', {
                values: {
                  usingNetworksCount: getUsedNetworks(currentNetworks).length,
                  srtLatency: currentConfig?.srt_latency,
                },
              })}
            </p>
          {/if}
        </Card.Content>
      </Card.Root>
      <Card.Root>
        <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
          <Card.Title class="text-sm font-medium">{$_('general.temperature')}</Card.Title>
          <Thermometer class="h-4 w-4 text-muted-foreground" />
        </Card.Header>
        <Card.Content>
          <div class="text-2xl font-bold">{temperature?.[0]?.[1]}</div>
          <p class="text-xs text-muted-foreground">{temperature?.[0]?.[0]}</p>
        </Card.Content>
      </Card.Root>
      <Card.Root>
        <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
          <Card.Title class="text-sm font-medium">{$_('general.relayServer')}</Card.Title>
          {#if currentConfig?.srtla_addr}
            <Server class="h-4 w-4 text-muted-foreground" />
          {:else}
            <ServerOff class="h-4 w-4 text-muted-foreground" />
          {/if}
        </Card.Header>
        <Card.Content>
          <div class="text-2xl font-bold">{currentConfig?.srtla_addr ?? 'None'}</div>
          <p class="text-xs text-muted-foreground">
            {currentConfig?.srtla_addr ? `Port: ${currentConfig?.srtla_port}` : $_('general.youHaventConfigured')}
          </p>
        </Card.Content>
      </Card.Root>
      <Card.Root>
        <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
          <Card.Title class="text-sm font-medium">{$_('general.updates')}</Card.Title>
          <Update class="h-4 w-4 text-muted-foreground" />
        </Card.Header>
        <Card.Content class="flex items-center">
          <div>
            <div class="text-2xl font-bold">
              {currentStatus?.available_updates.package_count}
              {currentStatus?.available_updates.package_count === 1 ? $_('general.package') : $_('general.packages')}
            </div>
            <p class="text-xs text-muted-foreground">{currentStatus?.available_updates?.download_size ?? '0 MB'}</p>
          </div>
          {#if currentStatus?.available_updates.package_count}
            <SimpleAlertDialog
              buttonText="Update"
              confirmButtonText="Update"
              onconfirm={installSoftwareUpdates}
              extraButtonClasses="ml-auto">
              {#snippet dialogTitle()}
                {$_('general.areYouSure')}
              {/snippet}
              {#snippet description()}
                {$_('general.updateConfirmation')}
              {/snippet}
            </SimpleAlertDialog>
          {/if}
        </Card.Content>
      </Card.Root>
    </div>
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
      {#if currentConfig}
        <Card.Root class="col-span-5 sm:col-span-4">
          <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
            <Card.Title class="text-primary">{$_('general.overview')}</Card.Title>
            <SquareChartGantt class="h-4 w-4 text-muted-foreground" />
          </Card.Header>
          <Card.Content class="grid gap-3">
            <div class="flex items-center gap-4">
              <div class="grid gap-1">
                <p class="text-sm font-medium leading-none">{$_('general.relayServer')}</p>
              </div>
              <div class="ml-auto font-medium">{currentConfig.srtla_addr}</div>
            </div>

            <div class="flex items-center gap-4">
              <div class="grid gap-1">
                <p class="text-sm font-medium leading-none">{$_('general.port')}</p>
              </div>
              <div class="ml-auto font-medium">{currentConfig.srtla_port}</div>
            </div>

            <div class="flex items-center gap-4">
              <div class="grid gap-1">
                <p class="text-sm font-medium leading-none">{$_('general.latency')}</p>
              </div>
              <div class="ml-auto font-medium">{currentConfig.srt_latency} ms</div>
            </div>

            <div class="flex items-center gap-4">
              <div class="grid gap-1">
                <p class="text-sm font-medium leading-none">{$_('general.maxBitrate')}</p>
              </div>
              <div class="ml-auto font-medium">{currentConfig.max_br} Kbps</div>
            </div>

            <div class="flex items-center gap-4">
              <div class="grid gap-1">
                <p class="text-sm font-medium leading-none">{$_('general.audioDevice')}</p>
              </div>
              <div class="ml-auto font-medium">{currentConfig.asrc}</div>
            </div>

            <div class="flex items-center gap-4">
              <div class="grid gap-1">
                <p class="text-sm font-medium leading-none">{$_('general.audioCodec')}</p>
              </div>
              <div class="ml-auto font-medium">{currentConfig?.acodec?.toUpperCase()}</div>
            </div>
          </Card.Content>
        </Card.Root>
      {/if}

      <Card.Root class="col-span-5 sm:col-span-3">
        <Networking />
      </Card.Root>
    </div>
  </div>
</div>
