<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import {
	ChevronDown,
	Globe,
	Key,
	Loader2,
	Network,
	RefreshCw,
	RotateCcw,
	Save,
	Settings,
	User,
	Zap,
} from '@lucide/svelte';
import { onDestroy } from 'svelte';
import { slide } from 'svelte/transition';

import { Button } from '$lib/components/ui/button';
import * as Collapsible from '$lib/components/ui/collapsible';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { Switch } from '$lib/components/ui/switch';
import {
	changeModemSettings,
	renameSupportedModemNetwork,
	scanModemNetworks,
} from '$lib/helpers/NetworkHelper';
import type { Modem } from '$lib/types/socket-messages';
import { cn } from '$lib/utils';

const { deviceId, modem, modemIsScanning } = $props<{
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
	network:
		!modem.config?.network || modem.config?.network === ''
			? '-1'
			: (modem.config.network as string),
});

// Form state
let formData = $state(getModemConfig());
const savedValues = $state(getModemConfig());
let errors = $state<Record<string, string | undefined>>({});
let advancedOpen = $state(false);

// Immediately fix the value type of the network selection after initialization
$effect.pre(() => {
	if (!formData.network || formData.network === '' || formData.network === 'auto') {
		formData.network = '-1';
	}
});

let localScanningState = $state(false);
let justSubmitted = $state(false);
let isSaving = $state(false);

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
const scanTimeouts: number[] = [];
const modemWatchInterval = setInterval(updateFormFromModem, 500);

// Clean up intervals and timeouts when the component is destroyed
onDestroy(() => {
	clearInterval(modemWatchInterval);
	for (const timeoutId of scanTimeouts) clearTimeout(timeoutId);
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

	return Object.values(errors).filter((value) => value !== undefined).length === 0;
}

// Check if form data has changed compared to saved values
function isFormChanged() {
	return (
		formData.autoconfig !== savedValues.autoconfig ||
		formData.apn !== savedValues.apn ||
		formData.username !== savedValues.username ||
		formData.password !== savedValues.password ||
		formData.roaming !== savedValues.roaming ||
		formData.selectedNetwork !== savedValues.selectedNetwork ||
		formData.network !== savedValues.network
	);
}

// Form submission handler
async function onSubmit(event: Event) {
	event.preventDefault();

	if (!validateForm()) {
		return;
	}

	isSaving = true;
	justSubmitted = true;

	const snapshot = { ...formData };
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
		isSaving = false;
	}, 500);

	const timeoutId = window.setTimeout(() => {
		justSubmitted = false;
	}, 1000);

	scanTimeouts.push(timeoutId);
}

// Handle scanning networks with proper state management
function handleScanNetworks() {
	localScanningState = true;
	justSubmitted = true;

	scanModemNetworks(deviceId);

	const timeoutId = window.setTimeout(() => {
		localScanningState = false;
		justSubmitted = false;
	}, 10000);

	scanTimeouts.push(timeoutId);
}

// Reset form handler
function resetForm() {
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

const hasChanges = $derived(isFormChanged());
const isScanning = $derived(modemIsScanning || localScanningState);
</script>

<form class="space-y-5" onsubmit={onSubmit}>
	<!-- Network Type Selection -->
	<div class="space-y-2">
		<Label class="text-muted-foreground flex items-center gap-2 text-sm font-medium">
			<Network class="h-4 w-4" />
			{$LL.network.modem.networkType()}
		</Label>
		<Select.Root
			onValueChange={(val) => {
				if (val) {
					formData.selectedNetwork = val;
					errors.selectedNetwork = undefined;
				}
			}}
			type="single"
			value={formData.selectedNetwork}
		>
			<Select.Trigger
				class={cn(
					'h-11 w-full rounded-xl border-2 transition-colors',
					errors.selectedNetwork
						? 'border-red-300 dark:border-red-700'
						: 'border-slate-200 focus:border-blue-400 dark:border-slate-700',
				)}
			>
				<span class="font-medium">{renameSupportedModemNetwork(formData.selectedNetwork)}</span>
			</Select.Trigger>
			<Select.Content class="rounded-xl">
				<Select.Group>
					{#each modem.network_type.supported as networkType}
						<Select.Item class="rounded-lg" value={networkType}>
							{renameSupportedModemNetwork(networkType)}
						</Select.Item>
					{/each}
				</Select.Group>
			</Select.Content>
		</Select.Root>
		{#if errors.selectedNetwork}
			<p class="text-sm text-red-500">{errors.selectedNetwork}</p>
		{/if}
	</div>

	<!-- Roaming Toggle -->
	<div
		class="flex items-center justify-between rounded-xl border-2 border-slate-200 bg-slate-50 p-4 transition-colors dark:border-slate-700 dark:bg-slate-800/50"
	>
		<div class="flex items-center gap-3">
			<div
				class={cn(
					'rounded-lg p-2 transition-colors',
					formData.roaming
						? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400'
						: 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
				)}
			>
				<Globe class="h-4 w-4" />
			</div>
			<div>
				<p class="text-foreground text-sm font-semibold">{$LL.network.modem.enableRoaming()}</p>
				<p class="text-muted-foreground text-xs">{$LL.network.modem.roamingDescription()}</p>
			</div>
		</div>
		<Switch
			class="data-[state=checked]:bg-emerald-500"
			checked={formData.roaming}
			onCheckedChange={(checked) => (formData.roaming = checked)}
		/>
	</div>

	<!-- Roaming Network Selection (conditional) -->
	{#if formData.roaming}
		<div class="space-y-2" transition:slide={{ duration: 200 }}>
			<Label class="text-muted-foreground flex items-center gap-2 text-sm font-medium">
				<RefreshCw class="h-4 w-4" />
				{$LL.network.modem.roamingNetwork()}
			</Label>
			<div class="flex gap-2">
				<div class="flex-1">
					<Select.Root
						onValueChange={(val) => (formData.network = val)}
						type="single"
						value={formData.network}
					>
						<Select.Trigger
							class="h-11 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700"
						>
							<span class="font-medium">
								{formData.network === '-1'
									? $LL.network.modem.automaticRoamingNetwork()
									: (modem.available_networks[formData.network]?.name ?? 'Unknown')}
							</span>
						</Select.Trigger>
						<Select.Content class="rounded-xl">
							<Select.Group>
								{#if modem.available_networks}
									<Select.Item
										class="rounded-lg"
										label={$LL.network.modem.automaticRoamingNetwork()}
										value="-1"
									/>
									{#each Object.entries(modem.available_networks) as [key, availableNetwork]}
										{#if availableNetwork.availability === 'available'}
											<Select.Item class="rounded-lg" label={availableNetwork.name} value={key} />
										{/if}
									{/each}
								{/if}
							</Select.Group>
						</Select.Content>
					</Select.Root>
				</div>
				<Button
					class={cn(
						'h-11 gap-2 rounded-xl px-4 transition-all',
						isScanning
							? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
							: 'bg-blue-600 text-white hover:bg-blue-700',
					)}
					disabled={isScanning}
					onclick={handleScanNetworks}
					type="button"
				>
					{#if isScanning}
						<Loader2 class="h-4 w-4 animate-spin" />
						<span class="hidden sm:inline">{$LL.network.modem.scanning()}</span>
					{:else}
						<RefreshCw class="h-4 w-4" />
						<span class="hidden sm:inline">{$LL.network.modem.scan()}</span>
					{/if}
				</Button>
			</div>
		</div>
	{/if}

	<!-- Auto APN Toggle -->
	<div
		class="flex items-center justify-between rounded-xl border-2 border-slate-200 bg-slate-50 p-4 transition-colors dark:border-slate-700 dark:bg-slate-800/50"
	>
		<div class="flex items-center gap-3">
			<div
				class={cn(
					'rounded-lg p-2 transition-colors',
					formData.autoconfig
						? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400'
						: 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
				)}
			>
				<Zap class="h-4 w-4" />
			</div>
			<div>
				<p class="text-foreground text-sm font-semibold">{$LL.network.modem.autoapn()}</p>
				<p class="text-muted-foreground text-xs">{$LL.network.modem.autoApnDescription()}</p>
			</div>
		</div>
		<Switch
			class="data-[state=checked]:bg-emerald-500"
			checked={formData.autoconfig}
			onCheckedChange={(checked) => (formData.autoconfig = checked)}
		/>
	</div>

	<!-- Manual APN Configuration (conditional) -->
	{#if !formData.autoconfig}
		<Collapsible.Root class="space-y-2" bind:open={advancedOpen}>
			<Collapsible.Trigger asChild>
				{#snippet child({ props })}
					<Button
						{...props}
						class={cn(
							'w-full justify-between rounded-xl border-2 transition-all',
							advancedOpen
								? 'border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/30'
								: 'border-slate-200 hover:border-slate-300 dark:border-slate-700',
						)}
						type="button"
						variant="outline"
					>
						<span class="flex items-center gap-2">
							<Settings class="h-4 w-4" />
							<span class="font-medium">{$LL.network.modem.apnSettings()}</span>
						</span>
						<ChevronDown
							class={cn('h-4 w-4 transition-transform duration-200', advancedOpen && 'rotate-180')}
						/>
					</Button>
				{/snippet}
			</Collapsible.Trigger>

			<Collapsible.Content>
				<div
					class="space-y-4 rounded-xl border-2 border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/30"
					transition:slide={{ duration: 200 }}
				>
					<!-- APN Field -->
					<div class="space-y-2">
						<Label class="text-muted-foreground flex items-center gap-2 text-sm font-medium">
							<Network class="h-4 w-4" />
							{$LL.network.modem.apn()}
						</Label>
						<Input
							class={cn(
								'h-11 rounded-xl border-2 transition-colors',
								errors.apn
									? 'border-red-300 dark:border-red-700'
									: 'border-slate-200 focus:border-blue-400 dark:border-slate-700',
							)}
							autocapitalize="none"
							autocomplete="off"
							autocorrect="off"
							oninput={() => (errors.apn = undefined)}
							placeholder="internet.provider.com"
							bind:value={formData.apn}
						/>
						{#if errors.apn}
							<p class="text-sm text-red-500">{errors.apn}</p>
						{/if}
					</div>

					<!-- Username Field -->
					<div class="space-y-2">
						<Label class="text-muted-foreground flex items-center gap-2 text-sm font-medium">
							<User class="h-4 w-4" />
							{$LL.network.modem.username()}
						</Label>
						<Input
							class="h-11 rounded-xl border-2 border-slate-200 transition-colors focus:border-blue-400 dark:border-slate-700"
							autocapitalize="none"
							autocomplete="off"
							autocorrect="off"
							placeholder="Optional"
							type="text"
							bind:value={formData.username}
						/>
					</div>

					<!-- Password Field -->
					<div class="space-y-2">
						<Label class="text-muted-foreground flex items-center gap-2 text-sm font-medium">
							<Key class="h-4 w-4" />
							{$LL.network.modem.password()}
						</Label>
						<Input
							class="h-11 rounded-xl border-2 border-slate-200 transition-colors focus:border-blue-400 dark:border-slate-700"
							autocapitalize="none"
							autocomplete="off"
							autocorrect="off"
							placeholder="Optional"
							type="password"
							bind:value={formData.password}
						/>
					</div>
				</div>
			</Collapsible.Content>
		</Collapsible.Root>

		<!-- Show APN inline when collapsed and has value -->
		{#if !advancedOpen && formData.apn}
			<div
				class="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/30"
			>
				<Network class="text-muted-foreground h-4 w-4" />
				<span class="text-muted-foreground text-sm">APN:</span>
				<span class="text-foreground font-mono text-sm">{formData.apn}</span>
			</div>
		{/if}
	{/if}

	<!-- Action Buttons -->
	<div class="flex gap-3 pt-2">
		<Button
			class={cn(
				'h-11 flex-1 gap-2 rounded-xl font-semibold transition-all',
				hasChanges
					? 'bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-lg hover:from-emerald-600 hover:to-teal-700 hover:shadow-xl'
					: 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
			)}
			disabled={!hasChanges || isSaving}
			type="submit"
		>
			{#if isSaving}
				<Loader2 class="h-4 w-4 animate-spin" />
				Saving...
			{:else}
				<Save class="h-4 w-4" />
				{$LL.network.modem.save()}
			{/if}
		</Button>
		<Button
			class="h-11 gap-2 rounded-xl border-2 border-slate-200 px-4 transition-all hover:border-slate-300 dark:border-slate-700"
			disabled={!hasChanges}
			onclick={resetForm}
			type="button"
			variant="outline"
		>
			<RotateCcw class="h-4 w-4" />
			<span class="hidden sm:inline">{$LL.network.modem.reset()}</span>
		</Button>
	</div>
</form>
