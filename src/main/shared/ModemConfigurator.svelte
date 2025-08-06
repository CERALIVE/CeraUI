<script lang="ts">
import { Check, X } from '@lucide/svelte';
import { onDestroy } from 'svelte';
import { _ } from 'svelte-i18n';

import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { Toggle } from '$lib/components/ui/toggle';
import { changeModemSettings, renameSupportedModemNetwork, scanModemNetworks } from '$lib/helpers/NetworkHelper';
import type { Modem } from '$lib/types/socket-messages';
import { cn } from '$lib/utils';

let { deviceId, modem, modemIsScanning } = $props<{
  deviceId: number | string;
  modem: Modem;
  modemIsScanning: boolean;
}>();

// Function to get current modem config - this returns a fresh object each time
const getModemConfig = () => ({
  selectedNetwork: modem.network_type.active,
  autoconfig: modem.config?.autoconfig || false,
  apn: modem.config?.apn || '',
  username: modem.config?.username || '',
  password: modem.config?.password || '',
  roaming: Boolean(modem.config?.roaming),
  network: !modem.config?.network || modem.config?.network === '' ? '-1' : (modem.config.network as string),
});

// Form state
let formData = $state(getModemConfig()); // Current form state
let savedValues = $state(getModemConfig()); // Last saved values for comparison
let errors = $state<Record<string, string | undefined>>({});

// Immediately fix the value type of the network selection after initialization
$effect.pre(() => {
  if (!formData.network || formData.network === '' || formData.network === 'auto') {
    formData.network = '-1';
  }
});

let localScanningState = $state(false);
let justSubmitted = $state(false);

// Watch for modem changes using a manually managed reactive state
let lastModemState: string = JSON.stringify(modem);

// Function to update the form when the modem state changes
function updateFormFromModem() {
  const currentModemState = JSON.stringify(modem);

  if (lastModemState === currentModemState) return;
  lastModemState = currentModemState;

  if (justSubmitted) return;

  if (!isFormChanged()) {
    Object.assign(formData, getModemConfig());
    Object.assign(savedValues, getModemConfig());
  }
}

// Arrays to track all timeouts and intervals for cleanup
let scanTimeouts: number[] = [];
let modemWatchInterval = setInterval(updateFormFromModem, 500);

// Clean up intervals and timeouts when the component is destroyed
onDestroy(() => {
  clearInterval(modemWatchInterval);
  scanTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
});

// Validate form data
function validateForm() {
  Object.assign(errors, {});

  if (!formData.selectedNetwork) {
    errors.selectedNetwork = 'Network type is required';
  }

  if (!formData.autoconfig && !formData.apn) {
    errors.apn = 'APN is required when auto-configuration is disabled';
  }

  console.log(errors);

  // Filter out undefined values before checking the length
  return Object.values(errors).filter(value => value !== undefined).length === 0;
}

// Check if form data has changed compared to saved values
function isFormChanged() {
  if (formData.autoconfig !== savedValues.autoconfig) return true;
  if (formData.apn !== savedValues.apn) return true;
  if (formData.username !== savedValues.username) return true;
  if (formData.password !== savedValues.password) return true;
  if (formData.roaming !== savedValues.roaming) return true;
  if (formData.selectedNetwork !== savedValues.selectedNetwork) return true;
  return formData.network !== savedValues.network;
}

// Form submission handler
function onSubmit(event: Event) {
  event.preventDefault();

  if (!validateForm()) {
    return;
  }

  justSubmitted = true;
  console.log(formData);
  const snapshot = { ...formData };
  console.log(snapshot.selectedNetwork);
  changeModemSettings({
    device: deviceId,
    apn: snapshot.apn,
    username: snapshot.username,
    network_type: snapshot.selectedNetwork,
    password: snapshot.password,
    autoconfig: snapshot.autoconfig,
    roaming: snapshot.roaming,
    network: !snapshot.roaming || snapshot.network === '-1' ? '' : snapshot.network,
  });

  window.setTimeout(() => {
    Object.assign(savedValues, snapshot);
  }, 0);

  const timeoutId = window.setTimeout(() => {
    justSubmitted = false;
  }, 1000);

  scanTimeouts.push(timeoutId);
}

// Handle scanning networks with proper state management
function handleScanNetworks() {
  // Set local scanning state immediately for responsive UI
  localScanningState = true;

  // Set flag to prevent form reset while scanning
  justSubmitted = true;

  // Call the scan function
  scanModemNetworks(deviceId);
  // Reset local scanning after a reasonable timeout if server doesn't respond
  // Use window.setTimeout to avoid reactive updates
  const timeoutId = window.setTimeout(() => {
    localScanningState = false;
    // Allow form updates again after scan completes
    justSubmitted = false;
  }, 10000);

  // Store timeout ID for cleanup
  scanTimeouts.push(timeoutId);
}

// Reset form handler
function resetForm() {
  // Reset form data to saved values
  formData = {
    selectedNetwork: savedValues.selectedNetwork,
    autoconfig: savedValues.autoconfig,
    apn: savedValues.apn,
    username: savedValues.username,
    password: savedValues.password,
    roaming: savedValues.roaming,
    network: savedValues.network,
  };
  errors = {};
}
</script>

<div class="grid gap-2">
  <form onsubmit={onSubmit} class="grid gap-4">
    <div class="mt-1 grid gap-1">
      <Label for="networkType">{$_('network.modem.networkType')}</Label>
      <Select.Root
        type="single"
        value={formData.selectedNetwork}
        onValueChange={val => {
          if (val) {
            formData.selectedNetwork = val; // Create a new object to ensure reactivity
            errors.selectedNetwork = undefined;
          }
        }}>
        <Select.Trigger id="networkType">
          {renameSupportedModemNetwork(formData.selectedNetwork)}
        </Select.Trigger>
        <Select.Content>
          <Select.Group>
            {#each modem.network_type.supported as networkType}
              <Select.Item value={networkType}>{renameSupportedModemNetwork(networkType)}</Select.Item>
            {/each}
          </Select.Group>
        </Select.Content>
      </Select.Root>
      {#if errors.selectedNetwork}
        <p class="mt-1 text-sm text-red-500">{errors.selectedNetwork}</p>
      {/if}
    </div>

    <div class="flex items-center">
      <Toggle
        variant="outline"
        class={cn(formData.roaming ? 'data-[state=on]:bg-green-600' : 'bg-red-600')}
        title={$_('network.modem.enableRoaming')}
        pressed={formData.roaming}
        onPressedChange={value => (formData.roaming = value)}>
        {#if formData.roaming}
          <Check></Check>
        {:else}
          <X></X>
        {/if}
      </Toggle>
      <div class="ml-4 space-y-1">
        <p class="text-muted-foreground text-sm">
          {$_('network.modem.enableRoaming')}
        </p>
      </div>
    </div>

    {#if formData.roaming}
      <div class="mt-1">
        <Label for="roamingNetwork">{$_('network.modem.roamingNetwork')}</Label>
        <div class="flex items-start gap-2">
          <div class="flex-1">
            <Select.Root type="single" value={formData.network} onValueChange={val => (formData.network = val)}>
              <Select.Trigger id="roamingNetwork" class="w-full">
                {formData.network === '-1'
                  ? $_('network.modem.automaticRoamingNetwork')
                  : modem.available_networks[formData.network].name}
              </Select.Trigger>
              <Select.Content>
                <Select.Group>
                  {#if modem.available_networks}
                    <Select.Item datatype="number" value="-1" label={$_('network.modem.automaticRoamingNetwork')}
                    ></Select.Item>
                    {#each Object.entries(modem.available_networks) as [key, availableNetwork]}
                      {#if availableNetwork.availability === 'available'}
                        <Select.Item datatype="number" value={key} label={availableNetwork.name}></Select.Item>
                      {/if}
                    {/each}
                  {/if}
                </Select.Group>
              </Select.Content>
            </Select.Root>
          </div>
          <Button
            type="button"
            variant="outline"
            class="shrink-0 bg-blue-600 hover:bg-blue-700"
            onclick={handleScanNetworks}
            disabled={modemIsScanning || localScanningState}>
            {modemIsScanning || localScanningState ? $_('network.modem.scanning') : $_('network.modem.scan')}
          </Button>
        </div>
      </div>
    {/if}

    <div class="flex items-center">
      <Toggle
        variant="outline"
        class={cn(formData.autoconfig ? 'data-[state=on]:bg-green-600' : 'bg-red-600')}
        title={$_('network.modem.autoapn')}
        pressed={formData.autoconfig}
        onPressedChange={value => (formData.autoconfig = value)}>
        {#if formData.autoconfig}
          <Check></Check>
        {:else}
          <X></X>
        {/if}
      </Toggle>
      <div class="ml-4 space-y-1">
        <p class="text-muted-foreground text-sm">
          {$_('network.modem.autoapn')}
        </p>
      </div>
    </div>

    {#if !formData.autoconfig}
      <div class="grid gap-1">
        <Label for="apn">{$_('network.modem.apn')}</Label>
        <Input
          id="apn"
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off"
          bind:value={formData.apn}
          class={errors.apn ? 'border-red-500' : ''}
          oninput={() => (errors.apn = undefined)} />
        {#if errors.apn}
          <p class="mt-1 text-sm text-red-500">{errors.apn}</p>
        {/if}
      </div>

      <div class="grid gap-1">
        <Label for="username">{$_('network.modem.username')}</Label>
        <Input
          id="username"
          type="text"
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off"
          bind:value={formData.username} />
      </div>

      <div class="grid gap-1">
        <Label for="modemPassword">{$_('network.modem.password')}</Label>
        <Input
          id="modemPassword"
          type="text"
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off"
          bind:value={formData.password} />
      </div>
    {/if}

    <div class="mt-2 flex gap-2">
      <Button type="submit" class="flex-1" disabled={!isFormChanged()}>
        {$_('network.modem.save')}
      </Button>
      <Button type="button" variant="outline" onclick={resetForm}>{$_('network.modem.reset')}</Button>
    </div>
  </form>
</div>
