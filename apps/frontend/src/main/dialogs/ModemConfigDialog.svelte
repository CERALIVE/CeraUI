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
import { einkGatedSlide as slide } from '$lib/transitions';

import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import LinkIndicator from '$lib/components/custom/LinkIndicator.svelte';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { renameSupportedModemNetwork } from '$lib/helpers/NetworkHelper';
import { modemSignal } from '$lib/helpers/signal';
import { rpc } from '$lib/rpc';
import {
	confirmOperation,
	getOperationPhase,
	isOperationPending,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import {
	type ModemConfigSent,
	modemConfigEchoMatches,
} from '$lib/rpc/modem-config-echo';
import { modemScanSignature } from '$lib/rpc/modem-scan-signature';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
	modem: Modem;
	deviceId: string | number;
}

let { open = $bindable(false), modem, deviceId }: Props = $props();

// Keyed async-operation domains. Scan and configure are tracked SEPARATELY so an
// in-flight scan never gates a save and vice-versa. The `osCommand` re-entry
// guard on each key is the real anti-double-dispatch protection — in particular
// the modem GLOBAL lock SILENTLY DROPS a re-entrant scan (returns success-shaped,
// no-op), and the keyed guard is what stops that from leaving a stuck spinner.
const scanKey = $derived(`modem-scan:${deviceId}`);
const configKey = $derived(`modem-config:${deviceId}`);

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

// `formData` is a one-shot SNAPSHOT seeded on the open edge — it is NOT live-
// synced from the `modem` prop, so an incremental `mergeModemList` broadcast can
// never clobber an in-progress edit (the configure-echo confirm below reads the
// live `modem` directly; the form keeps the operator's typed values). This is
// the save-time form guard: the snapshot of what we sent (`saveExpected`) is
// captured at dispatch, so the confirm compares against intent, not a later edit.
let formData = $state(readModemConfig());
// The config we dispatched, captured at save time; drives the echo confirm and
// is cleared once the op settles. Absent ⇒ no save in flight.
let saveExpected = $state<ModemConfigSent | undefined>(undefined);
// Signature of the available-operator set captured at scan dispatch. A later
// broadcast whose signature DIFFERS confirms the scan (a new/removed operator);
// mere re-presence of the same set on a periodic broadcast must not confirm.
let scanSignatureBaseline = $state<string | undefined>(undefined);

const scanning = $derived(isOperationPending(scanKey));
const scanError = $derived(getOperationPhase(scanKey) === 'failed');
const savePending = $derived(isOperationPending(configKey));

// Re-seed the form from the live modem each time the dialog opens. Guarded off
// while a save is in flight so a close/reopen race can't drop the snapshot.
let prevOpen = false;
$effect(() => {
	if (open && !prevOpen && !savePending) {
		formData = readModemConfig();
		saveExpected = undefined;
		scanSignatureBaseline = undefined;
	}
	prevOpen = open;
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

// Confirm a scan when its operator-set signature changes (a new/removed
// operator), NOT on a mere `modems` reference change — a periodic full-state
// re-broadcast re-sends the same `available_networks` and must not clear the
// spinner. An environment that yields no new operators legitimately produces no
// change: the absolute TTL valve then flips the op to `timed_out`.
$effect(() => {
	if (getOperationPhase(scanKey) !== 'pending') return;
	const sig = modemScanSignature(modem.available_networks);
	if (scanSignatureBaseline !== undefined && sig !== scanSignatureBaseline) {
		confirmOperation(scanKey);
		scanSignatureBaseline = undefined;
	}
});

// Confirm a configure once a broadcast `modem` echo proves the device stored
// what we sent (configure-echo predicate). A `connecting → connected` cycle on
// any re-attach must NOT confirm — only a matching stored config does. Closes
// the dialog on confirm; releases the snapshot on any terminal phase.
$effect(() => {
	const expected = saveExpected;
	if (!expected) return;
	const phase = getOperationPhase(configKey);
	if (phase === 'confirmed') {
		saveExpected = undefined;
		open = false;
		return;
	}
	if (phase === 'failed' || phase === 'timed_out' || phase === 'idle') {
		saveExpected = undefined;
		return;
	}
	if (
		phase === 'pending' &&
		modemConfigEchoMatches(expected, {
			networkTypeActive: modem.network_type?.active ?? null,
			config: modem.config,
		})
	) {
		confirmOperation(configKey);
	}
});

async function handleSave() {
	if (primaryDisabled || isOperationPending(configKey)) return;
	const input = {
		device: String(deviceId),
		network_type: formData.selectedNetwork,
		roaming: formData.roaming,
		network: !formData.roaming || formData.network === '-1' ? '' : formData.network,
		autoconfig: formData.autoconfig,
		apn: formData.apn,
		username: formData.username,
		password: formData.password,
	};
	// Capture the dispatched config as the echo baseline BEFORE the broadcast can
	// land, so the confirm compares against what we sent — never a later edit.
	saveExpected = {
		network_type: input.network_type,
		roaming: input.roaming,
		network: input.network,
		autoconfig: input.autoconfig,
		apn: input.apn,
		username: input.username,
		password: input.password,
	};
	await osCommand({
		key: configKey,
		rpc: () => rpc.modems.configure(input),
		busyMessage: () => $LL.network.os.deviceBusy(),
		failMessage: () => $LL.network.os.operationFailed(),
	});
}

async function handleScan() {
	if (noSim || isOperationPending(scanKey)) return;
	// Capture the baseline BEFORE dispatch so a fresh result is detectable.
	scanSignatureBaseline = modemScanSignature(modem.available_networks);
	await osCommand({
		key: scanKey,
		rpc: () => rpc.modems.scan({ device: Number(deviceId) }),
		busyMessage: () => $LL.network.os.deviceBusy(),
		failMessage: () => $LL.network.os.operationFailed(),
	});
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
	primaryLoading={savePending}
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
							disabled={noSim || scanning}
							onclick={handleScan}
							size="sm"
							type="button"
							variant="outline"
						>
							{#if scanning}
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
					{:else if scanning}
						<p class="text-muted-foreground text-xs" data-testid="modem-scanning-state">
							{$LL.network.modem.scanningForNetworks()}
						</p>
					{:else if availableNetworks.length === 0}
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
