<script lang="ts">
import { Server } from '@lucide/svelte';
import { _ } from 'svelte-i18n';

import * as Card from '$lib/components/ui/card';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import type { RelayMessage } from '$lib/types/socket-messages';

interface Props {
  relayMessage: RelayMessage | undefined;
  properties: {
    relayServer: string | undefined;
    relayAccount: string | undefined;
    srtlaServerAddress: string | undefined;
    srtlaServerPort: number | undefined;
    srtStreamId: string | undefined;
    srtLatency: number | undefined;
  };
  formErrors: Record<string, string>;
  isStreaming: boolean;
  onRelayServerChange: (value: string) => void;
  onRelayAccountChange: (value: string) => void;
  onSrtlaAddressChange: (value: string) => void;
  onSrtlaPortChange: (value: number | undefined) => void;
  onSrtStreamIdChange: (value: string) => void;
  onSrtLatencyChange: (value: number) => void;
  normalizeValue: (value: number, min: number, max: number, step?: number) => number;
}

const {
  relayMessage,
  properties,
  formErrors,
  isStreaming,
  onRelayServerChange,
  onRelayAccountChange,
  onSrtlaAddressChange,
  onSrtlaPortChange,
  onSrtStreamIdChange,
  onSrtLatencyChange,
  normalizeValue,
}: Props = $props();

// Local state for all fields to prevent binding undefined values (like EncoderCard pattern)
let localSrtlaServerAddress = $state(properties.srtlaServerAddress ?? '');
let localSrtlaServerPort = $state(properties.srtlaServerPort?.toString() ?? '');
let localSrtStreamId = $state(properties.srtStreamId ?? '');
let localSrtLatency = $state(properties.srtLatency ?? 2000);
let localRelayServer = $state(properties.relayServer ?? '');
let localRelayAccount = $state(properties.relayAccount ?? '');

// Track if user has touched each field to prevent auto-syncing user-edited fields
let addressTouched = $state(false);
let portTouched = $state(false);
let streamIdTouched = $state(false);
let relayServerTouched = $state(false);
let relayAccountTouched = $state(false);

// Sync FROM properties TO local state when parent provides new data (like EncoderCard pattern)
$effect(() => {
  if (!addressTouched) {
    localSrtlaServerAddress = properties.srtlaServerAddress ?? '';
  }
});

$effect(() => {
  if (!portTouched) {
    localSrtlaServerPort = properties.srtlaServerPort?.toString() ?? '';
  }
});

$effect(() => {
  if (!streamIdTouched) {
    localSrtStreamId = properties.srtStreamId ?? '';
  }
});

$effect(() => {
  if (!relayServerTouched) {
    localRelayServer = properties.relayServer ?? '';
  }
});

$effect(() => {
  if (!relayAccountTouched) {
    localRelayAccount = properties.relayAccount ?? '';
  }
});

$effect(() => {
  // Latency can always sync since it's not a text field that users clear
  localSrtLatency = properties.srtLatency ?? 2000;
});

// No effects watching local state to prevent timing issues and loops
// Parent functions are called directly in input handlers (like EncoderCard pattern)

const isManualConfig = $derived(
  localRelayServer === '-1' || localRelayServer === undefined || localRelayServer === ''
);
const isManualAccount = $derived(
  localRelayAccount === '-1' || localRelayAccount === undefined || localRelayAccount === ''
);
</script>

<Card.Root class="group flex h-full flex-col transition-all duration-200 hover:shadow-md">
  <Card.Header class="flex flex-row items-center justify-between space-y-0 pb-4">
    <div class="flex items-center space-x-2">
      <div class="rounded-lg bg-blue-100 p-2 dark:bg-blue-900/20">
        <Server class="h-4 w-4 text-blue-600 dark:text-blue-400" />
      </div>
      <Card.Title class="text-base font-semibold">{$_('settings.receiverServer')}</Card.Title>
    </div>
  </Card.Header>

  <Card.Content class="flex-1 space-y-4">
    <!-- Relay Server Selection -->
    <div class="space-y-2">
      <Label class="text-sm font-medium" for="relayServer">{$_('settings.relayServer')}</Label>
      <Select.Root
        disabled={relayMessage === undefined || isStreaming}
        onValueChange={(value) => {
          localRelayServer = value;
          relayServerTouched = true;
          onRelayServerChange(value);
        }}
        type="single"
        value={localRelayServer}
      >
        <Select.Trigger id="relayServer" class="w-full">
          {localRelayServer !== undefined && localRelayServer !== '-1' && relayMessage?.servers
            ? (Object.entries(relayMessage.servers).find(
                (server) => server[0] === localRelayServer
              )?.[1]?.name ?? $_('settings.manualConfiguration'))
            : $_('settings.manualConfiguration')}
        </Select.Trigger>
        <Select.Content>
          <Select.Group>
            <Select.Item value="-1">
              <div class="flex items-center gap-2">
                <div class="h-2 w-2 rounded-full bg-orange-500"></div>
                {$_('settings.manualConfiguration')}
              </div>
            </Select.Item>
            {#if relayMessage?.servers}
              {#each Object.entries(relayMessage?.servers) as [server, serverInfo]}
                <Select.Item value={server}>
                  <div class="flex items-center gap-2">
                    <div class="h-2 w-2 rounded-full bg-green-500"></div>
                    {serverInfo.name}
                  </div>
                </Select.Item>
              {/each}
            {/if}
          </Select.Group>
        </Select.Content>
      </Select.Root>
      {#if formErrors.relayServer}
        <p class="text-destructive text-sm">{formErrors.relayServer}</p>
      {/if}
    </div>

    {#if isManualConfig}
      <!-- Manual Server Configuration -->
      <div
        class="space-y-4 rounded-lg border border-orange-200 bg-orange-50 p-4 dark:border-orange-800 dark:bg-orange-950/20"
      >
        <div class="mb-3 flex items-center space-x-2">
          <div class="h-2 w-2 rounded-full bg-orange-500"></div>
          <h4 class="text-sm font-medium text-orange-800 dark:text-orange-200">
            {$_('settings.manualServerConfiguration')}
          </h4>
        </div>

        <div class="space-y-2">
          <Label class="text-sm font-medium" for="srtlaServerAddress">
            {$_('settings.srtlaServerAddress')}
          </Label>
          <Input
            id="srtlaServerAddress"
            class="font-mono"
            disabled={isStreaming}
            oninput={() => {
              addressTouched = true;
              onSrtlaAddressChange(localSrtlaServerAddress);
            }}
            placeholder={$_('settings.placeholders.srtlaServerAddress')}
            bind:value={localSrtlaServerAddress}
          />
          {#if formErrors.srtlaServerAddress}
            <p class="text-destructive text-sm">{formErrors.srtlaServerAddress}</p>
          {/if}
        </div>

        <div class="space-y-2">
          <Label class="text-sm font-medium" for="srtlaServerPort">
            {$_('settings.srtlaServerPort')}
          </Label>
          <Input
            id="srtlaServerPort"
            class="font-mono"
            disabled={isStreaming}
            oninput={() => {
              portTouched = true;
              const value = (localSrtlaServerPort || '').toString().trim();
              if (value === '') {
                onSrtlaPortChange(undefined);
              } else {
                const parsedValue = parseInt(value, 10);
                if (Number.isInteger(parsedValue) && parsedValue > 0 && parsedValue <= 65535) {
                  onSrtlaPortChange(parsedValue);
                } else {
                  onSrtlaPortChange(undefined);
                }
              }
            }}
            placeholder={$_('settings.placeholders.srtlaServerPort')}
            type="number"
            bind:value={localSrtlaServerPort}
          />
          {#if formErrors.srtlaServerPort}
            <p class="text-destructive text-sm">{formErrors.srtlaServerPort}</p>
          {/if}
        </div>
      </div>
    {:else}
      <!-- Relay Account Selection -->
      <div class="space-y-2">
        <Label class="text-sm font-medium" for="relayServerAccount">
          {$_('settings.relayServerAccount')}
        </Label>
        <Select.Root
          disabled={relayMessage === undefined || isStreaming}
          onValueChange={(value) => {
            localRelayAccount = value;
            relayAccountTouched = true;
            onRelayAccountChange(value);
          }}
          type="single"
          value={localRelayAccount}
        >
          <Select.Trigger id="relayServerAccount" class="w-full">
            {localRelayAccount === undefined ||
            localRelayAccount === '-1' ||
            relayMessage?.accounts === undefined
              ? $_('settings.manualConfiguration')
              : relayMessage.accounts[localRelayAccount].name}
          </Select.Trigger>
          <Select.Content>
            <Select.Group>
              <Select.Item value="-1">
                <div class="flex items-center gap-2">
                  <div class="h-2 w-2 rounded-full bg-orange-500"></div>
                  {$_('settings.manualConfiguration')}
                </div>
              </Select.Item>
              {#if relayMessage?.accounts}
                {#each Object.entries(relayMessage?.accounts) as [account, accountInfo]}
                  <Select.Item value={account}>
                    <div class="flex items-center gap-2">
                      <div class="h-2 w-2 rounded-full bg-green-500"></div>
                      {accountInfo.name}
                    </div>
                  </Select.Item>
                {/each}
              {/if}
            </Select.Group>
          </Select.Content>
        </Select.Root>
      </div>
    {/if}

    <!-- SRT Stream ID (for manual account configuration) -->
    {#if isManualAccount}
      <div class="space-y-2">
        <Label class="text-sm font-medium" for="srtStreamId">
          {$_('settings.srtStreamId')}
          <span class="text-muted-foreground ml-1 text-xs">({$_('settings.optional')})</span>
        </Label>
        <Input
          id="srtStreamId"
          class="font-mono"
          disabled={isStreaming}
          oninput={() => {
            streamIdTouched = true;
            onSrtStreamIdChange(localSrtStreamId);
          }}
          placeholder={$_('settings.placeholders.srtStreamId')}
          bind:value={localSrtStreamId}
        />
      </div>
    {/if}

    <!-- SRT Latency Control -->
    <div class="bg-accent/30 space-y-3 rounded-lg p-4">
      <Label class="flex items-center gap-2 text-sm font-medium" for="srtLatency">
        {$_('settings.srtLatency')}
        <span
          class="rounded-md bg-blue-100 px-2 py-1 text-xs text-blue-700 dark:bg-blue-900/20 dark:text-blue-300"
        >
          {localSrtLatency || 2000}ms
        </span>
      </Label>
      <!-- Custom slider with visual progress and thumb -->
      <div class="relative h-6 w-full">
        <!-- Track Background -->
        <div
          class="absolute inset-y-0 top-1/2 right-0 left-0 h-2 -translate-y-1/2 rounded-full bg-gray-200 dark:bg-gray-700"
        ></div>
        <!-- Progress Fill -->
        <div
          style={`width: ${(() => {
            const safeLatency = isFinite(localSrtLatency) ? localSrtLatency : 2000;
            const percentage = ((safeLatency - 2000) / (12000 - 2000)) * 100;
            return isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0;
          })()}%;`}
          class="absolute top-1/2 left-0 h-2 -translate-y-1/2 rounded-full bg-gradient-to-r from-blue-400 to-blue-500 transition-all duration-200 dark:from-blue-500 dark:to-blue-600"
        ></div>
        <!-- Thumb -->
        <div
          style={`left: ${(() => {
            const safeLatency = isFinite(localSrtLatency) ? localSrtLatency : 2000;
            const percentage = ((safeLatency - 2000) / (12000 - 2000)) * 100;
            return isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0;
          })()}%;`}
          class="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border-2 border-white bg-blue-500 shadow-md transition-all duration-200 hover:scale-110 dark:border-gray-800 dark:bg-blue-400"
        ></div>
        <!-- Invisible Input for Interaction -->
        <input
          id="srtLatency"
          class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          disabled={isStreaming}
          max={12000}
          min={2000}
          oninput={(e) => {
            const inputValue = parseInt(e.currentTarget.value);
            if (!isNaN(inputValue)) {
              localSrtLatency = inputValue;
              onSrtLatencyChange(inputValue);
            }
          }}
          step={50}
          type="range"
          bind:value={localSrtLatency}
        />
      </div>
      <Input
        id="srtLatencyInput"
        class="text-center font-mono"
        disabled={isStreaming}
        onblur={() => {
          const value = normalizeValue(localSrtLatency, 2000, 12000, 50);
          if (value !== localSrtLatency) {
            localSrtLatency = value;
            onSrtLatencyChange(value); // Only call parent if value actually changed
          }
        }}
        oninput={(e) => {
          const inputValue = parseInt(e.currentTarget.value);
          if (!isNaN(inputValue)) {
            localSrtLatency = inputValue;
            onSrtLatencyChange(inputValue); // Call parent to keep everything in sync
          }
        }}
        step="1"
        type="number"
        value={localSrtLatency || 2000}
      />
      <div class="text-muted-foreground flex justify-between text-xs">
        <span>{$_('settings.lowerLatency')}</span>
        <span>{$_('settings.higherLatency')}</span>
      </div>
    </div>
  </Card.Content>
</Card.Root>
