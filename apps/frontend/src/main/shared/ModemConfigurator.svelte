<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import {
	ChevronDown,
	Globe,
	Loader2,
	Network,
	RefreshCw,
	RotateCcw,
	Save,
	Settings,
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

let formData = $state(getModemConfig());
const savedValues = $state(getModemConfig());
let errors = $state<Record<string, string | undefined>>({});
let advancedOpen = $state(false);
let localScanningState = $state(false);
let justSubmitted = $state(false);
let isSaving = $state(false);

$effect.pre(() => {
	if (!formData.network || formData.network === '' || formData.network === 'auto') {
		formData.network = '-1';
	}
});

let lastModemState: string = JSON.stringify(modem);

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

const scanTimeouts: number[] = [];
const modemWatchInterval = setInterval(updateFormFromModem, 500);

onDestroy(() => {
	clearInterval(modemWatchInterval);
	for (const timeoutId of scanTimeouts) clearTimeout(timeoutId);
});

function validateForm() {
	Object.assign(errors, {});
	if (!formData.selectedNetwork) errors.selectedNetwork = 'Required';
	if (!formData.autoconfig && !formData.apn) errors.apn = 'Required when auto APN is off';
	return Object.values(errors).filter((v) => v !== undefined).length === 0;
}

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

async function onSubmit(event: Event) {
	event.preventDefault();
	if (!validateForm()) return;

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

	scanTimeouts.push(window.setTimeout(() => (justSubmitted = false), 1000));
}

function handleScanNetworks() {
	localScanningState = true;
	justSubmitted = true;
	scanModemNetworks(deviceId);
	scanTimeouts.push(
		window.setTimeout(() => {
			localScanningState = false;
			justSubmitted = false;
		}, 10000),
	);
}

function resetForm() {
	formData = { ...savedValues };
	errors = {};
}

const hasChanges = $derived(isFormChanged());
const isScanning = $derived(modemIsScanning || localScanningState);
</script>

<form class="space-y-3" onsubmit={onSubmit}>
	<!-- Network Type -->
	<div class="space-y-1.5">
		<Label class="text-muted-foreground text-xs">{$LL.network.modem.networkType()}</Label>
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
			<Select.Trigger class={cn('h-9 text-sm', errors.selectedNetwork && 'border-red-500')}>
				{renameSupportedModemNetwork(formData.selectedNetwork)}
			</Select.Trigger>
			<Select.Content>
				<Select.Group>
					{#each modem.network_type.supported as networkType}
						<Select.Item value={networkType}>{renameSupportedModemNetwork(networkType)}</Select.Item
						>
					{/each}
				</Select.Group>
			</Select.Content>
		</Select.Root>
	</div>

	<!-- Roaming Toggle -->
	<div
		class="flex items-center justify-between rounded-lg border bg-slate-50/50 p-2.5 dark:bg-slate-800/50"
	>
		<div class="flex items-center gap-2">
			<Globe
				class={cn('h-4 w-4', formData.roaming ? 'text-emerald-600' : 'text-muted-foreground')}
			/>
			<span class="text-sm font-medium">{$LL.network.modem.enableRoaming()}</span>
		</div>
		<Switch
			class="scale-90 data-[state=checked]:bg-emerald-500"
			checked={formData.roaming}
			onCheckedChange={(checked) => (formData.roaming = checked)}
		/>
	</div>

	<!-- Roaming Network -->
	{#if formData.roaming}
		<div class="space-y-1.5" transition:slide={{ duration: 150 }}>
			<Label class="text-muted-foreground text-xs">{$LL.network.modem.roamingNetwork()}</Label>
			<div class="flex gap-2">
				<Select.Root
					onValueChange={(val) => (formData.network = val)}
					type="single"
					value={formData.network}
				>
					<Select.Trigger class="h-9 flex-1 text-sm">
						{formData.network === '-1'
							? $LL.network.modem.automaticRoamingNetwork()
							: (modem.available_networks[formData.network]?.name ?? 'Unknown')}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#if modem.available_networks}
								<Select.Item label={$LL.network.modem.automaticRoamingNetwork()} value="-1" />
								{#each Object.entries(modem.available_networks) as [key, net]}
									{#if net.availability === 'available'}
										<Select.Item label={net.name} value={key} />
									{/if}
								{/each}
							{/if}
						</Select.Group>
					</Select.Content>
				</Select.Root>
				<Button
					class={cn(
						'h-9 px-3',
						isScanning
							? 'bg-amber-500/20 text-amber-700'
							: 'bg-blue-600 text-white hover:bg-blue-700',
					)}
					disabled={isScanning}
					onclick={handleScanNetworks}
					size="sm"
					type="button"
				>
					{#if isScanning}
						<Loader2 class="h-4 w-4 animate-spin" />
					{:else}
						<RefreshCw class="h-4 w-4" />
					{/if}
				</Button>
			</div>
		</div>
	{/if}

	<!-- Auto APN Toggle -->
	<div
		class="flex items-center justify-between rounded-lg border bg-slate-50/50 p-2.5 dark:bg-slate-800/50"
	>
		<div class="flex items-center gap-2">
			<Zap
				class={cn('h-4 w-4', formData.autoconfig ? 'text-emerald-600' : 'text-muted-foreground')}
			/>
			<span class="text-sm font-medium">{$LL.network.modem.autoapn()}</span>
		</div>
		<Switch
			class="scale-90 data-[state=checked]:bg-emerald-500"
			checked={formData.autoconfig}
			onCheckedChange={(checked) => (formData.autoconfig = checked)}
		/>
	</div>

	<!-- Manual APN -->
	{#if !formData.autoconfig}
		<Collapsible.Root bind:open={advancedOpen}>
			<Collapsible.Trigger asChild>
				{#snippet child({ props })}
					<Button
						{...props}
						class="h-8 w-full justify-between text-xs"
						size="sm"
						type="button"
						variant="ghost"
					>
						<span class="flex items-center gap-1.5">
							<Settings class="h-3.5 w-3.5" />
							{$LL.network.modem.apnSettings()}
						</span>
						<ChevronDown
							class={cn('h-3.5 w-3.5 transition-transform', advancedOpen && 'rotate-180')}
						/>
					</Button>
				{/snippet}
			</Collapsible.Trigger>

			<Collapsible.Content>
				<div class="mt-2 space-y-2.5 rounded-lg border p-2.5" transition:slide={{ duration: 150 }}>
					<div class="space-y-1">
						<Label class="text-muted-foreground flex items-center gap-1.5 text-xs">
							<Network class="h-3.5 w-3.5" />
							{$LL.network.modem.apn()}
						</Label>
						<Input
							class={cn('h-8 text-sm', errors.apn && 'border-red-500')}
							oninput={() => (errors.apn = undefined)}
							placeholder="internet.provider.com"
							bind:value={formData.apn}
						/>
					</div>
					<div class="grid grid-cols-2 gap-3">
						<div class="space-y-1">
							<Label class="text-muted-foreground text-xs">{$LL.network.modem.username()}</Label>
							<Input class="h-8 text-sm" placeholder="—" bind:value={formData.username} />
						</div>
						<div class="space-y-1">
							<Label class="text-muted-foreground text-xs">{$LL.network.modem.password()}</Label>
							<Input
								class="h-8 text-sm"
								placeholder="—"
								type="password"
								bind:value={formData.password}
							/>
						</div>
					</div>
				</div>
			</Collapsible.Content>
		</Collapsible.Root>

		{#if !advancedOpen && formData.apn}
			<div class="text-muted-foreground flex items-center gap-1.5 text-xs">
				<Network class="h-3.5 w-3.5" />
				<span>APN: <span class="text-foreground font-mono">{formData.apn}</span></span>
			</div>
		{/if}
	{/if}

	<!-- Actions -->
	<div class="flex gap-2 pt-1">
		<Button
			class={cn(
				'h-8 flex-1 gap-1.5 text-sm',
				hasChanges ? 'bg-emerald-600 hover:bg-emerald-700' : '',
			)}
			disabled={!hasChanges || isSaving}
			size="sm"
			type="submit"
		>
			{#if isSaving}
				<Loader2 class="h-3.5 w-3.5 animate-spin" />
			{:else}
				<Save class="h-3.5 w-3.5" />
			{/if}
			{$LL.network.modem.save()}
		</Button>
		<Button
			class="h-8 gap-1.5 px-3 text-sm"
			disabled={!hasChanges}
			onclick={resetForm}
			size="sm"
			type="button"
			variant="outline"
		>
			<RotateCcw class="h-3.5 w-3.5" />
		</Button>
	</div>
</form>
