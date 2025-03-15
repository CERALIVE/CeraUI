<script lang="ts">
import { Check, X } from 'lucide-svelte';
import { onDestroy } from 'svelte';
import { _ } from 'svelte-i18n';
import type { Modem, ModemNetworkType } from '$lib/types/socket-messages';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { Toggle } from '$lib/components/ui/toggle';
import { changeModemSettings, renameSupportedModemNetwork, scanModemNetworks } from '$lib/helpers/NetworkHelper';
import { cn } from '$lib/utils';

let { deviceId, modem, modemIsScanning } = $props<{
  deviceId: number | string;
  modem: Modem;
  modemIsScanning: boolean;
}>();

const getSelectedNetwork: () => { value: ModemNetworkType; label: string } = () => {
  return { value: modem.network_type.active, label: renameSupportedModemNetwork(modem.network_type.active) };
};

// Create a consistent format for the automatic roaming option
const defaultRoamingNetwork = { value: -1, label: 'Automatic Selection' };

// Function to get current modem config - this returns a fresh object each time
const getModemConfig = () => ({
  selectedNetwork: getSelectedNetwork(),
  autoconfig: modem.config?.autoconfig || false,
  apn: modem.config?.apn || '',
  username: modem.config?.username || '',
  password: modem.config?.password || '',
  roaming: Boolean(modem.config?.roaming),
  network:
    !modem.config?.network || modem.config?.network === ''
      ? defaultRoamingNetwork
      : { value: modem.config?.network, label: modem.available_networks[modem.config.network]?.name || '' },
});

// Form state
let formData = $state(getModemConfig()); // Current form state
let savedValues = $state(getModemConfig()); // Last saved values for comparison
let errors = $state<Record<string, string>>({});

// Immediately fix the value type of the network selection after initialization
$effect.pre(() => {
  // Force the default value to be numeric -1 instead of string
  if (formData.network.value === '' || formData.network.value === 'auto') {
    formData.network = { ...defaultRoamingNetwork };
  }
});
let localScanningState = $state(false); // Track local scanning state
let justSubmitted = $state(false); // Flag to prevent updates right after form submission

// Watch for modem changes using a manually managed reactive state
// instead of $effect to break the circular dependency
let lastModemState: string = JSON.stringify(modem);

// Use a non-reactive function for modem updates
function updateFormFromModem() {
  const currentModemState = JSON.stringify(modem);

  // Only run if modem has actually changed
  if (lastModemState === currentModemState) return;

  // Update our tracked state
  lastModemState = currentModemState;

  // Skip the update if we just submitted the form
  if (justSubmitted) return;

  // Only update form if user hasn't made changes
  if (!isFormChanged()) {
    const newConfig = getModemConfig();
    formData = newConfig;
    savedValues = getModemConfig();
  }
}

// Arrays to track all timeouts and intervals for cleanup
let scanTimeouts: number[] = [];
let modemWatchInterval = setInterval(updateFormFromModem, 500);

// Clean up all intervals and timeouts when component is destroyed
onDestroy(() => {
  // Clear the main interval
  clearInterval(modemWatchInterval);

  // Clear all scan timeouts
  scanTimeouts.forEach(timeoutId => {
    clearTimeout(timeoutId);
  });
});

// Validate form data
function validateForm() {
  errors = {};

  if (!formData.selectedNetwork.value) {
    errors.selectedNetwork = 'Network type is required';
  }

  if (!formData.autoconfig && !formData.apn) {
    errors.apn = 'APN is required when auto-configuration is disabled';
  }

  return Object.keys(errors).length === 0;
}

// Check if form data has changed compared to saved values
function isFormChanged() {
  // We need to compare each property individually to handle Select components properly
  // Simple properties
  if (formData.autoconfig !== savedValues.autoconfig) return true;
  if (formData.apn !== savedValues.apn) return true;
  if (formData.username !== savedValues.username) return true;
  if (formData.password !== savedValues.password) return true;
  if (formData.roaming !== savedValues.roaming) return true;

  // For object properties, compare only the values that matter
  // For selectedNetwork, compare the network type value
  if (formData.selectedNetwork.value !== savedValues.selectedNetwork.value) return true;

  // For network, compare the network value
  if (formData.network.value !== savedValues.network.value) return true;

  // If we got here, nothing has changed
  return false;
}

// Form submission handler
function onSubmit(event: Event) {
  // Prevent default form submission to avoid page refresh
  event.preventDefault();

  // Validate form
  if (!validateForm()) {
    return;
  }

  // Set flag to prevent form from resetting due to parent component updates
  justSubmitted = true;

  // Create a snapshot of the current form state to use for the submission
  // This breaks reactive connections
  const snapshot = {
    selectedNetwork: { ...formData.selectedNetwork },
    autoconfig: formData.autoconfig,
    apn: formData.apn,
    username: formData.username,
    password: formData.password,
    roaming: formData.roaming,
    network: { ...formData.network },
  };

  // First, make sure the form data is consistent with roaming setting
  if (!snapshot.roaming) {
    // If roaming is off, use the default network for submission
    const networkForSubmission = defaultRoamingNetwork;

    // Submit with consistent values using the snapshot
    changeModemSettings({
      device: deviceId,
      apn: snapshot.apn,
      username: snapshot.username,
      network_type: snapshot.selectedNetwork.value,
      password: snapshot.password,
      autoconfig: snapshot.autoconfig,
      roaming: false, // explicitly set false to be clear
      network: Number(networkForSubmission.value) === -1 ? '' : networkForSubmission.value,
    });

    // Use window.setTimeout to update the saved values outside of the reactive context
    window.setTimeout(() => {
      // Update saved values without modifying current form state
      savedValues = {
        selectedNetwork: {
          value: snapshot.selectedNetwork.value,
          label: snapshot.selectedNetwork.label,
        },
        autoconfig: snapshot.autoconfig,
        apn: snapshot.apn,
        username: snapshot.username,
        password: snapshot.password,
        roaming: false,
        network: {
          value: networkForSubmission.value,
          label: networkForSubmission.label,
        },
      };
    }, 0);
  } else {
    // If roaming is on, use selected network from snapshot

    // Submit with snapshot values
    changeModemSettings({
      device: deviceId,
      apn: snapshot.apn,
      username: snapshot.username,
      network_type: snapshot.selectedNetwork.value,
      password: snapshot.password,
      autoconfig: snapshot.autoconfig,
      roaming: true, // explicitly set true to be clear
      network: Number(snapshot.network.value) === -1 ? '' : snapshot.network.value,
    });

    // Use window.setTimeout to update the saved values outside of the reactive context
    window.setTimeout(() => {
      // Update saved values with deep copies to avoid reference issues
      savedValues = {
        selectedNetwork: {
          value: snapshot.selectedNetwork.value,
          label: snapshot.selectedNetwork.label,
        },
        autoconfig: snapshot.autoconfig,
        apn: snapshot.apn,
        username: snapshot.username,
        password: snapshot.password,
        roaming: true,
        network: {
          value: snapshot.network.value,
          label: snapshot.network.label,
        },
      };
    }, 0);
  }

  // Reset the justSubmitted flag after a delay
  const timeoutId = window.setTimeout(() => {
    justSubmitted = false;
  }, 1000);

  // Track the timeout for cleanup
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

  // Use window.setTimeout to break out of reactivity chain
  window.setTimeout(() => {
    if (!modemIsScanning) {
      // If after a short delay, the modemIsScanning prop hasn't updated
      // we can assume the request is in progress and keep showing scanning state locally
    }
  }, 200);

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
    selectedNetwork: {
      value: savedValues.selectedNetwork.value,
      label: savedValues.selectedNetwork.label,
    },
    autoconfig: savedValues.autoconfig,
    apn: savedValues.apn,
    username: savedValues.username,
    password: savedValues.password,
    roaming: savedValues.roaming,
    network: {
      value: savedValues.network.value,
      label: savedValues.network.label,
    },
  };
  errors = {};
}
</script>

<div class="grid gap-2">
  <form onsubmit={onSubmit} class="grid gap-4">
    <div class="mt-1 grid gap-1">
      <Label for="networkType">{$_('network.modem.networkType')}</Label>
      <Select.Root
        selected={formData.selectedNetwork}
        onSelectedChange={val => {
          if (val) {
            formData.selectedNetwork = { ...val }; // Create a new object to ensure reactivity
            errors.selectedNetwork = undefined;
          }
        }}>
        <Select.Trigger id="networkType">
          <Select.Value placeholder={renameSupportedModemNetwork(formData.selectedNetwork.value)}></Select.Value>
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
        onPressedChange={val => (formData.roaming = val)}>
        {#if formData.roaming}
          <Check></Check>
        {:else}
          <X></X>
        {/if}
      </Toggle>
      <div class="ml-4 space-y-1">
        <p class="text-sm text-muted-foreground">
          {$_('network.modem.enableRoaming')}
        </p>
      </div>
    </div>

    {#if formData.roaming}
      <div class="mt-1">
        <Label for="roamingNetwork">{$_('network.modem.roamingNetwork')}</Label>
        <div class="flex items-start gap-2">
          <div class="flex-1">
            <Select.Root
              selected={formData.network}
              onSelectedChange={val => {
                if (val) formData.network = { ...val }; // Create a new object to ensure reactivity
              }}>
              <Select.Trigger id="roamingNetwork" class="w-full">
                <Select.Value>
                  {Number(formData.network.value) === -1
                    ? $_('network.modem.automaticRoamingNetwork')
                    : formData.network.label}
                </Select.Value>
              </Select.Trigger>
              <Select.Content>
                <Select.Group>
                  <Select.Item value={defaultRoamingNetwork.value} label={$_('network.modem.automaticRoamingNetwork')}
                  ></Select.Item>
                  {#if modem.available_networks}
                    {#each Object.entries(modem.available_networks) as [key, availableNetwork]}
                      {#if availableNetwork.availability === 'available'}
                        <Select.Item value={key} label={availableNetwork.name}></Select.Item>
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
            on:click={handleScanNetworks}
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
        onPressedChange={val => (formData.autoconfig = val)}>
        {#if formData.autoconfig}
          <Check></Check>
        {:else}
          <X></X>
        {/if}
      </Toggle>
      <div class="ml-4 space-y-1">
        <p class="text-sm text-muted-foreground">
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
          on:input={() => (errors.apn = undefined)} />
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
      <Button type="button" variant="outline" on:click={resetForm}>Reset</Button>
    </div>
  </form>
</div>
