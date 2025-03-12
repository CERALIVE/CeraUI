<script lang="ts">
import { Check, X } from 'lucide-svelte';
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

const defaultRoamingNetwork = { value: '', label: 'network.modem.automaticRoamingNetwork' };

// Function to get current modem config - this returns a fresh object each time
const getModemConfig = () => ({
  selectedNetwork: getSelectedNetwork(),
  autoconfig: modem.config?.autoconfig || false,
  apn: modem.config?.apn || '',
  username: modem.config?.username || '',
  password: modem.config?.password || '',
  roaming: Boolean(modem.config?.roaming),
  network:
    modem.config?.network === ''
      ? defaultRoamingNetwork
      : { value: modem.config?.network, label: modem.available_networks[modem.config.network]?.name || '' },
});

// Form state
let formData = $state(getModemConfig()); // Current form state
let savedValues = $state(getModemConfig()); // Last saved values for comparison
let errors = $state<Record<string, string>>({});
let localScanningState = $state(false); // Track local scanning state
let justSubmitted = $state(false); // Flag to prevent updates right after form submission

// Watch for modem changes and update formData if it hasn't been modified
// This ensures the form stays in sync with modem data from parent component
$effect(() => {
  // This will execute whenever modem changes (modem is used in getModemConfig)
  // Skip the update if we just submitted the form to prevent values from flickering
  if (justSubmitted) {
    // Reset the flag after a short delay to allow for future updates
    setTimeout(() => {
      justSubmitted = false;
    }, 1000);
    return;
  }

  // Only update form if user hasn't made changes
  if (!isFormChanged()) {
    formData = getModemConfig();
    savedValues = getModemConfig();
  }
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

  // Create copies of current form data to preserve it after submission
  const currentNetwork = { ...formData.network };
  const currentSelectedNetwork = { ...formData.selectedNetwork };

  // First, make sure the form data is consistent with roaming setting
  if (!formData.roaming) {
    // If roaming is off, use the default network for submission
    const networkForSubmission = defaultRoamingNetwork;

    // Submit with consistent values
    changeModemSettings({
      device: deviceId,
      apn: formData.apn,
      username: formData.username,
      network_type: formData.selectedNetwork.value,
      password: formData.password,
      autoconfig: formData.autoconfig,
      roaming: false, // explicitly set false to be clear
      network: networkForSubmission.value,
    });

    // Update saved values without modifying current form state
    savedValues = {
      selectedNetwork: {
        value: currentSelectedNetwork.value,
        label: currentSelectedNetwork.label,
      },
      autoconfig: formData.autoconfig,
      apn: formData.apn,
      username: formData.username,
      password: formData.password,
      roaming: false,
      network: {
        value: networkForSubmission.value,
        label: networkForSubmission.label,
      },
    };
    
    // Note: We're NOT updating formData here to prevent UI reset
  } else {
    // If roaming is on, use selected network

    // Submit with current values
    changeModemSettings({
      device: deviceId,
      apn: formData.apn,
      username: formData.username,
      network_type: formData.selectedNetwork.value,
      password: formData.password,
      autoconfig: formData.autoconfig,
      roaming: true, // explicitly set true to be clear
      network: formData.network.value,
    });

    // Update saved values with deep copies to avoid reference issues
    // But maintain the original objects to prevent UI reset
    savedValues = {
      selectedNetwork: {
        value: currentSelectedNetwork.value,
        label: currentSelectedNetwork.label,
      },
      autoconfig: formData.autoconfig,
      apn: formData.apn,
      username: formData.username,
      password: formData.password,
      roaming: true,
      network: {
        value: currentNetwork.value,
        label: currentNetwork.label,
      },
    };
  }
}

// Handle scanning networks with proper state management
function handleScanNetworks() {
  // Set local scanning state immediately for responsive UI
  localScanningState = true;
  
  // Set flag to prevent form reset while scanning
  justSubmitted = true;

  // Call the scan function
  scanModemNetworks(deviceId);

  // Update the UI to show scanning state before the server responds
  // This improves the perceived responsiveness of the UI
  setTimeout(() => {
    if (!modemIsScanning) {
      // If after a short delay, the modemIsScanning prop hasn't updated
      // we can assume the request is in progress and keep showing scanning state locally
    }
  }, 200);

  // Reset local scanning after a reasonable timeout if server doesn't respond
  setTimeout(() => {
    localScanningState = false;
    // Allow form updates again after scan completes
    justSubmitted = false;
  }, 10000);
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
      <Label for="networkType" class="mb-2 ml-1">{$_('network.modem.networkType')}</Label>
      <Select.Root
        selected={formData.selectedNetwork}
        onSelectedChange={val => {
          if (val) {
            formData.selectedNetwork = { ...val }; // Create a new object to ensure reactivity
            errors.selectedNetwork = undefined;
          }
        }}>
        <Select.Trigger id="networkType" class={errors.selectedNetwork ? 'border-red-500 h-10' : 'h-10'}>
          <Select.Value placeholder={renameSupportedModemNetwork(formData.selectedNetwork.value)}></Select.Value>
        </Select.Trigger>
        <Select.Content
          class="min-w-[--radix-select-trigger-width] max-h-[var(--radix-select-content-available-height)] w-[var(--radix-select-trigger-width)]"
          position="popper">
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
      <div class="mt-1 grid gap-1">
        <Label for="roamingNetwork" class="mb-2 ml-1">{$_('network.modem.roamingNetwork')}</Label>

        <!-- Select with fixed height to prevent layout shifts -->
        <div class="grid gap-2">
          <!-- Select with fixed height wrapper -->
          <div class="min-w-0">
            <Select.Root
              selected={formData.network.value === ''
                ? { value: formData.network.value, label: $_(formData.network.label) }
                : formData.network}
              onSelectedChange={val => {
                if (val) formData.network = { ...val }; // Create a new object to ensure reactivity
              }}>
              <Select.Trigger id="roamingNetwork" class="w-full h-10">
                <Select.Value 
                  placeholder={formData.network.value === '' 
                    ? $_(formData.network.label)
                    : formData.network.label}>
                </Select.Value>
              </Select.Trigger>
              <Select.Content
                class="min-w-[--radix-select-trigger-width] max-h-[var(--radix-select-content-available-height)] w-[var(--radix-select-trigger-width)]"
                position="popper">
                <Select.Group>
                  <Select.Item value={defaultRoamingNetwork.value} label={$_(defaultRoamingNetwork.label)}
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

          <!-- Button below the select -->
          <div>
            <Button
              type="button"
              variant="outline"
              class="bg-blue-600 hover:bg-blue-700 w-full"
              on:click={handleScanNetworks}
              disabled={modemIsScanning || localScanningState}>
              {modemIsScanning || localScanningState ? $_('network.modem.scanning') : $_('network.modem.scan')}
            </Button>
          </div>
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
        <Label for="apn" class="mb-1">{$_('network.modem.apn')}</Label>
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
        <Label for="username" class="mb-1">{$_('network.modem.username')}</Label>
        <Input
          id="username"
          type="text"
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off"
          bind:value={formData.username} />
      </div>

      <div class="grid gap-1">
        <Label for="password" class="mb-1">{$_('network.modem.password')}</Label>
        <Input
          id="password"
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
