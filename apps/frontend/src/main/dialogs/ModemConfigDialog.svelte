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
import { toast } from 'svelte-sonner';

import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import LinkIndicator from '$lib/components/custom/LinkIndicator.svelte';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import {
	changeModemSettings,
	renameSupportedModemNetwork,
	scanModemNetworks,
} from '$lib/helpers/NetworkHelper';
import { modemSignal } from '$lib/helpers/signal';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
	modem: Modem;
	deviceId: string | number;
}

let { open = $bindable(false), modem, deviceId }: Props = $props();

// Watchdog that releases the in-flight scan state if the modems broadcast with
// fresh results never lands (real hardware scans are async and fire-and-forget
// on the backend; results stream back over the `modems` broadcast, not the RPC
// response). Not a validation bound — a UI timing guard, so it lives inline.
const SCAN_WATCHDOG_MS = 12_000;

// ── No-SIM detection (defensive: null OR undefined signal => no SIM) ──────────
const noSim = $derived(modem.no_sim === true || modem.status?.signal == null);
const signalValue = $derived(modemSignal(modem));
const operatorName = $derived(modem.status?.network || modem.sim_network || modem.name);
const activeNetworkType = $derived(modem.status?.network_type ?? '');

// ── Form state ────────────────────────────────────────────────────────────────
function readModemConfig() {
	return {
		selectedNetwork: modem.network_type?.active ?? modem.network_type?.supported?.[0] ?? '',
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
let scanError = $state(false);
let saving = $state(false);
// Available-network count captured when a scan starts; the in-flight state is
// released as soon as the broadcast count diverges from this baseline.
let scanBaseline = $state(0);
let scanWatchdog: number | undefined;

function clearScanWatchdog() {
	if (scanWatchdog !== undefined) {
		clearTimeout(scanWatchdog);
		scanWatchdog = undefined;
	}
}

// Re-seed the form from the live modem each time the dialog opens.
let prevOpen = false;
$effect(() => {
	if (open && !prevOpen) {
		formData = readModemConfig();
		localScanning = false;
		scanError = false;
		clearScanWatchdog();
	}
	prevOpen = open;
});

onDestroy(clearScanWatchdog);

// APN required when Automatic APN is disabled (mirrors backend zod refine).
const apnError = $derived(!formData.autoconfig && formData.apn.trim().length === 0);
const primaryDisabled = $derived(noSim || apnError);

// Available operators for manual selection (populated by a scan).
const availableNetworks = $derived(
	Object.entries(modem.available_networks ?? {}).filter(
		([, net]) => net.availability === 'available',
	),
);

// Release the in-flight scan state the moment fresh results land. The backend
// answers the scan RPC immediately and streams the operator list back over the
// `modems` broadcast, so completion is signalled by the available-network count
// diverging from the baseline captured when the scan started.
$effect(() => {
	if (localScanning && availableNetworks.length !== scanBaseline) {
		localScanning = false;
		clearScanWatchdog();
	}
});

async function handleSave() {
	if (primaryDisabled || saving) return;
	saving = true;
	try {
		await changeModemSettings({
			device: deviceId,
			network_type: formData.selectedNetwork,
			roaming: formData.roaming,
			network: !formData.roaming || formData.network === '-1' ? '' : formData.network,
			autoconfig: formData.autoconfig,
			apn: formData.apn,
			username: formData.username,
			password: formData.password,
		});
		open = false;
	} catch {
		toast.error($LL.network.errors.toggleFailed());
	} finally {
		saving = false;
	}
}

async function handleScan() {
	if (noSim || localScanning) return;
	scanError = false;
	scanBaseline = availableNetworks.length;
	localScanning = true;
	clearScanWatchdog();
	scanWatchdog = window.setTimeout(() => {
		localScanning = false;
		scanWatchdog = undefined;
	}, SCAN_WATCHDOG_MS);

	try {
		const result = await scanModemNetworks(Number(deviceId));
		// The RPC is accepted before the operator list is ready; a `success:false`
		// payload is the backend's only synchronous failure channel.
		if (result && result.success === false) {
			throw new Error(result.error ?? 'scan failed');
		}
	} catch {
		scanError = true;
		localScanning = false;
		clearScanWatchdog();
		toast.error($LL.network.modem.scanFailed());
	}
}

const selectedNetworkLabel = $derived(
	formData.network === '-1'
		? $LL.network.modem.automaticRoamingNetwork()
		: (modem.available_networks?.[formData.network]?.name ?? formData.network),
);
</script>

<AppDialog
	closeOnPrimary={false}
	description={$LL.network.modem.configureDescription()}
	icon={Radio}
	onPrimary={handleSave}
	primaryDisabled={primaryDisabled}
	primaryLabel={$LL.network.modem.save()}
	primaryLoading={saving}
	title={modem.name}
	bind:open
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
			<LinkIndicator
				shape="icon"
				size="lg"
				type="modem"
				signal={signalValue}
				connectionState={noSim ? 'no_sim' : 'connected'}
				showPercent
			/>
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
						{#each modem.network_type?.supported ?? [] as networkType (networkType)}
							<Select.Item value={networkType}>
								{renameSupportedModemNetwork(networkType)}
							</Select.Item>
						{/each}
						{#if (modem.network_type?.supported ?? []).length === 0}
							<div class="text-muted-foreground px-2 py-1.5 text-xs">
								{$LL.network.modem.noNetworksFound()}
							</div>
						{/if}
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
				<LabeledSwitch
					checked={formData.roaming}
					disabled={noSim}
					label={$LL.network.modem.enableRoaming()}
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
							data-testid="modem-scan-button"
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
						<Select.Trigger class="h-10 w-full text-sm" data-testid="modem-network-trigger">
							{selectedNetworkLabel}
						</Select.Trigger>
						<Select.Content>
							<Select.Group>
								<Select.Item
									label={$LL.network.modem.automaticRoamingNetwork()}
									value="-1"
								/>
								{#each availableNetworks as [key, net] (key)}
									<Select.Item data-testid="modem-network-option" label={net.name} value={key} />
								{/each}
							</Select.Group>
						</Select.Content>
					</Select.Root>

					{#if scanError}
						<p class="text-status-error text-xs" data-testid="modem-scan-error" role="alert">
							{$LL.network.modem.scanFailed()}
						</p>
					{:else if availableNetworks.length === 0 && !localScanning}
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
				<LabeledSwitch
					checked={formData.autoconfig}
					disabled={noSim}
					label={$LL.network.modem.autoapn()}
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
