<!--
  ModemConfigDialog.svelte — per-modem cellular configuration dialog.

  Opened from NetworkView's per-modem "Configure" trigger. One instance drives
  one modem (passed by `modem` + `deviceId`). Composes the shared AppDialog
  chrome (responsive Dialog/Sheet, RTL-safe, focus-trapped).

  No-SIM safety
  -------------
  A modem with `no_sim === true` OR a null/absent signal reading is treated as
  having no SIM: a banner is shown and every input is disabled. `signal` is read
  defensively (`== null`) so a missing `status` never crashes the render.

  APN-required-when-manual
  ------------------------
  Mirrors the backend zod refine (modems.schema.ts):
    autoconfig !== false || apn.length > 0
  When Automatic APN is off and the APN is empty, an inline error is shown and
  the primary (Save) action is disabled.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Modem } from '@ceraui/rpc/schemas';
import {
	Globe,
	Loader2,
	Network as NetworkIcon,
	Radio,
	RefreshCw,
	SignalZero,
	Zap,
} from '@lucide/svelte';
import { onDestroy } from 'svelte';
import { slide } from 'svelte/transition';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import SignalIndicator from '$lib/components/icons/SignalIndicator.svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { Switch } from '$lib/components/ui/switch';
import {
	changeModemSettings,
	renameSupportedModemNetwork,
	scanModemNetworks,
} from '$lib/helpers/NetworkHelper';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
	modem: Modem;
	deviceId: string | number;
}

let { open = $bindable(false), modem, deviceId }: Props = $props();

// ── No-SIM detection (defensive: null OR undefined signal => no SIM) ──────────
const noSim = $derived(modem.no_sim === true || modem.status?.signal == null);
const signalValue = $derived(modem.status?.signal ?? 0);
const operatorName = $derived(modem.status?.network || modem.sim_network || modem.name);
const activeNetworkType = $derived(modem.status?.network_type ?? '');

// ── Form state ────────────────────────────────────────────────────────────────
function readModemConfig() {
	return {
		selectedNetwork: modem.network_type.active ?? modem.network_type.supported[0] ?? '',
		autoconfig: modem.config?.autoconfig ?? false,
		apn: modem.config?.apn ?? '',
		username: modem.config?.username ?? '',
		password: modem.config?.password ?? '',
		roaming: Boolean(modem.config?.roaming),
		network:
			!modem.config?.network || modem.config.network === ''
				? '-1'
				: String(modem.config.network),
	};
}

let formData = $state(readModemConfig());
let localScanning = $state(false);
const scanTimeouts: number[] = [];

// Re-seed the form from the live modem each time the dialog opens.
let prevOpen = false;
$effect(() => {
	if (open && !prevOpen) {
		formData = readModemConfig();
		localScanning = false;
	}
	prevOpen = open;
});

onDestroy(() => {
	for (const id of scanTimeouts) clearTimeout(id);
});

// APN required when Automatic APN is disabled (mirrors backend zod refine).
const apnError = $derived(!formData.autoconfig && formData.apn.trim().length === 0);
const primaryDisabled = $derived(noSim || apnError);

// Available operators for manual selection (populated by a scan).
const availableNetworks = $derived(
	Object.entries(modem.available_networks ?? {}).filter(
		([, net]) => net.availability === 'available',
	),
);

function handleSave() {
	if (primaryDisabled) return;
	changeModemSettings({
		device: deviceId,
		network_type: formData.selectedNetwork,
		roaming: formData.roaming,
		network: !formData.roaming || formData.network === '-1' ? '' : formData.network,
		autoconfig: formData.autoconfig,
		apn: formData.apn,
		username: formData.username,
		password: formData.password,
	});
}

function handleScan() {
	if (noSim || localScanning) return;
	localScanning = true;
	scanModemNetworks(Number(deviceId));
	scanTimeouts.push(window.setTimeout(() => (localScanning = false), 10000));
}

const selectedNetworkLabel = $derived(
	formData.network === '-1'
		? $LL.network.modem.automaticRoamingNetwork()
		: (modem.available_networks?.[formData.network]?.name ?? formData.network),
);
</script>

<AppDialog
	bind:open
	description={$LL.network.modem.configureDescription()}
	icon={Radio}
	onPrimary={handleSave}
	primaryDisabled={primaryDisabled}
	primaryLabel={$LL.network.modem.save()}
	title={modem.name}
>
	<div class="space-y-4">
		<!-- ── Status strip: operator · network type · signal ────────────────── -->
		<div class="bg-muted/40 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
			<div class="min-w-0">
				<p class="truncate text-sm font-medium">{operatorName}</p>
				{#if !noSim && activeNetworkType}
					<p class="text-muted-foreground text-xs">{activeNetworkType}</p>
				{/if}
			</div>
			{#if noSim}
				<SignalZero class="text-muted-foreground size-5 shrink-0" aria-hidden="true" />
			{:else}
				<SignalIndicator signal={signalValue} type="cellular" />
			{/if}
		</div>

		{#if noSim}
			<!-- ── No-SIM banner ──────────────────────────────────────────────── -->
			<div
				class="border-status-warning/40 bg-status-warning/10 flex items-start gap-3 rounded-lg border p-3"
				role="status"
			>
				<SignalZero class="text-status-warning mt-0.5 size-5 shrink-0" aria-hidden="true" />
				<div class="min-w-0">
					<p class="text-sm font-semibold">{$LL.network.modem.noSim()}</p>
					<p class="text-muted-foreground mt-0.5 text-xs">{$LL.network.modem.noSimHint()}</p>
				</div>
			</div>
		{/if}

		<!-- All controls below are disabled when no SIM is present. -->
		<fieldset class="space-y-4 disabled:pointer-events-none" disabled={noSim}>
			<!-- ── Network type ────────────────────────────────────────────────── -->
			<div class="space-y-1.5">
				<Label class="text-muted-foreground text-xs">{$LL.network.modem.networkType()}</Label>
				<Select.Root
					disabled={noSim}
					onValueChange={(val) => {
						if (val) formData.selectedNetwork = val;
					}}
					type="single"
					value={formData.selectedNetwork}
				>
					<Select.Trigger class="h-10 w-full text-sm">
						{formData.selectedNetwork
							? renameSupportedModemNetwork(formData.selectedNetwork)
							: '—'}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each modem.network_type.supported as networkType (networkType)}
								<Select.Item value={networkType}>
									{renameSupportedModemNetwork(networkType)}
								</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</div>

			<!-- ── Roaming toggle ──────────────────────────────────────────────── -->
			<div class="bg-muted/40 flex items-center justify-between gap-3 rounded-lg border p-3">
				<div class="flex items-center gap-2.5">
					<Globe
						class={cn(
							'size-4 shrink-0',
							formData.roaming ? 'text-status-success' : 'text-muted-foreground',
						)}
						aria-hidden="true"
					/>
					<div class="min-w-0">
						<p class="text-sm font-medium">{$LL.network.modem.enableRoaming()}</p>
						<p class="text-muted-foreground text-xs">{$LL.network.modem.roamingDescription()}</p>
					</div>
				</div>
				<Switch
					checked={formData.roaming}
					class="data-[state=checked]:bg-primary"
					disabled={noSim}
					onCheckedChange={(checked) => (formData.roaming = checked)}
				/>
			</div>

			<!-- ── Network scan / operator selection ───────────────────────────── -->
			{#if formData.roaming}
				<div class="space-y-2" transition:slide={{ duration: 150 }}>
					<div class="flex items-center justify-between gap-2">
						<Label class="text-muted-foreground text-xs">
							{$LL.network.modem.availableNetworks()}
						</Label>
						<Button
							class="h-8 gap-1.5 px-2.5 text-xs"
							disabled={noSim || localScanning}
							onclick={handleScan}
							size="sm"
							type="button"
							variant="outline"
						>
							{#if localScanning}
								<Loader2 class="size-3.5 motion-safe:animate-spin" />
								{$LL.network.modem.scanning()}
							{:else}
								<RefreshCw class="size-3.5" />
								{$LL.network.modem.scanForNetworks()}
							{/if}
						</Button>
					</div>

					<Select.Root
						disabled={noSim}
						onValueChange={(val) => {
							if (val) formData.network = val;
						}}
						type="single"
						value={formData.network}
					>
						<Select.Trigger class="h-10 w-full text-sm">{selectedNetworkLabel}</Select.Trigger>
						<Select.Content>
							<Select.Group>
								<Select.Item
									label={$LL.network.modem.automaticRoamingNetwork()}
									value="-1"
								/>
								{#each availableNetworks as [key, net] (key)}
									<Select.Item label={net.name} value={key} />
								{/each}
							</Select.Group>
						</Select.Content>
					</Select.Root>

					{#if availableNetworks.length === 0 && !localScanning}
						<p class="text-muted-foreground text-xs">{$LL.network.modem.noNetworksFound()}</p>
					{/if}
				</div>
			{/if}

			<!-- ── Automatic APN toggle ────────────────────────────────────────── -->
			<div class="bg-muted/40 flex items-center justify-between gap-3 rounded-lg border p-3">
				<div class="flex items-center gap-2.5">
					<Zap
						class={cn(
							'size-4 shrink-0',
							formData.autoconfig ? 'text-status-success' : 'text-muted-foreground',
						)}
						aria-hidden="true"
					/>
					<div class="min-w-0">
						<p class="text-sm font-medium">{$LL.network.modem.autoapn()}</p>
						<p class="text-muted-foreground text-xs">{$LL.network.modem.autoApnDescription()}</p>
					</div>
				</div>
				<Switch
					checked={formData.autoconfig}
					class="data-[state=checked]:bg-primary"
					disabled={noSim}
					onCheckedChange={(checked) => (formData.autoconfig = checked)}
				/>
			</div>

			<!-- ── Manual APN + credentials (only when Automatic APN is off) ─────── -->
			{#if !formData.autoconfig}
				<div class="space-y-3 rounded-lg border p-3" transition:slide={{ duration: 150 }}>
					<div class="space-y-1.5">
						<Label class="text-muted-foreground flex items-center gap-1.5 text-xs" for="modem-apn">
							<NetworkIcon class="size-3.5" />
							{$LL.network.modem.apn()}
						</Label>
						<Input
							id="modem-apn"
							aria-invalid={apnError}
							class={cn('h-10 text-sm', apnError && 'border-status-error focus-visible:ring-status-error')}
							disabled={noSim}
							placeholder="internet.provider.com"
							bind:value={formData.apn}
						/>
						{#if apnError}
							<p class="text-status-error text-xs">{$LL.network.modem.apnRequired()}</p>
						{/if}
					</div>

					<div class="space-y-1.5">
						<Label class="text-muted-foreground text-xs">{$LL.network.modem.credentials()}</Label>
						<div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
							<Input
								aria-label={$LL.network.modem.username()}
								class="h-10 text-sm"
								disabled={noSim}
								placeholder={$LL.network.modem.username()}
								bind:value={formData.username}
							/>
							<Input
								aria-label={$LL.network.modem.password()}
								class="h-10 text-sm"
								disabled={noSim}
								placeholder={$LL.network.modem.password()}
								type="password"
								bind:value={formData.password}
							/>
						</div>
					</div>
				</div>
			{/if}
		</fieldset>
	</div>
</AppDialog>
