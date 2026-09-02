<!--
  BluetoothSection.svelte — the Network destination's Bluetooth card.

  THE MASTER TOGGLE IS PESSIMISTIC, and it is the `NetworkIngestDialog` switch
  verbatim in discipline: `osCommand` WITHOUT `confirmOnResolve`, so the switch
  position only moves once the confirming `bluetooth` broadcast reflects the
  target. The spinner is the SOLE optimistic element. Powering a radio the
  operator can see is exactly the case where an optimistic flip lies for as long
  as the device takes to answer.

  EVERY REFUSAL RENDERS ON SCREEN, NEXT TO THE CONTROL THAT WAS REFUSED — never
  a toast and never a `title`. The shipped kiosk touchscreen cannot hover, and
  the fourteen members of `bluetoothMutationRefusalSchema` each name a different
  thing the operator can do about it, so a generic "operation failed" would
  collapse "wait, the radio is busy" into "the pairing broke". `classify` keeps
  a structured refusal `ok`, which is what keeps it off `osCommand`'s toast path;
  a THROWN rpc is a transport fault and keeps that path.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { AudioBackend, BluetoothDevice, BluetoothStatus } from '@ceraui/rpc/schemas';
import { Bluetooth, ChevronRight, LoaderCircle, Mic, Radar } from '@lucide/svelte';

import Badge from '$lib/components/custom/Badge.svelte';
import { Button } from '$lib/components/ui/button';
import { Switch } from '$lib/components/ui/switch';
import {
	clearOperation,
	confirmOperation,
	getOperationPhase,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';

import {
	adapterStateKey,
	type BluetoothAction,
	bluetoothDeviceActions,
	bluetoothRefusalKey,
	bluetoothSurface,
	deviceClassKey,
	orderedBluetoothDevices,
	primaryBluetoothAdapter,
	showsAudioSourceHint,
	showsBluetoothMicBackendRefusal,
	showsPairingAgentGap,
} from './bluetooth-view';

interface Props {
	status: BluetoothStatus | undefined;
	audioBackend?: AudioBackend;
}

const { status, audioBackend }: Props = $props();

const ENABLE_KEY = 'bluetooth-enable';
const SCAN_KEY = 'bluetooth-scan';
const TOUCH_TARGET = 'min-h-[var(--touch-target-min)]';

const surface = $derived(bluetoothSurface(status));
const adapter = $derived(primaryBluetoothAdapter(status));
const devices = $derived(orderedBluetoothDevices(status));
const enabled = $derived(status?.enabled === true);
const scanning = $derived(adapter?.discovering === true);
const agentGap = $derived(showsPairingAgentGap(status));

/**
 * A structured `{success:false}` carries a member of the shared refusal enum,
 * and every one of them is rendered inline — so it must NOT take `osCommand`'s
 * toast path. Only a thrown rpc (a transport fault, which has no typed reason)
 * reaches that path, through `osCommand`'s own catch.
 */
const refusalsRenderInline = () => ({ ok: true }) as const;

// ── Master enable toggle (PESSIMISTIC) ──────────────────────────────────────
// The intended position, held while the op is `pending` so the confirm $effect
// knows which broadcast value ends the wait. Reset the moment the broadcast
// confirms, the device refuses, or the rpc throws.
let enableTarget = $state<boolean | null>(null);
let enableRefusalKey = $state<string | undefined>(undefined);

const enableBusy = $derived(getOperationPhase(ENABLE_KEY) === 'pending');

async function toggleEnabled(next: boolean): Promise<void> {
	enableTarget = next;
	const result = await osCommand({
		key: ENABLE_KEY,
		target: next,
		rpc: () => (next ? rpc.bluetooth.enable({}) : rpc.bluetooth.disable({})),
		classify: refusalsRenderInline,
		failMessage: () => m["network.os.operationFailed"](),
	});
	if (!result) {
		enableTarget = null;
		return;
	}
	if (!result.success) {
		enableRefusalKey = bluetoothRefusalKey(result.error);
		clearOperation(ENABLE_KEY);
		enableTarget = null;
		return;
	}
	enableRefusalKey = undefined;
	// Success: stay `pending`. The confirm $effect below resolves it once the
	// authoritative `bluetooth` broadcast reflects the target.
}

$effect(() => {
	if (getOperationPhase(ENABLE_KEY) !== 'pending') return;
	if (enableTarget === null) return;
	if (enabled === enableTarget) {
		enableTarget = null;
		confirmOperation(ENABLE_KEY);
	}
});

// ── Discovery ───────────────────────────────────────────────────────────────
let scanRefusalKey = $state<string | undefined>(undefined);

const scanBusy = $derived(getOperationPhase(SCAN_KEY) === 'pending');

async function toggleScan(): Promise<void> {
	const adapterPath = adapter?.path;
	if (adapterPath === undefined) return;
	scanRefusalKey = undefined;
	const stop = scanning;
	const result = await osCommand({
		key: SCAN_KEY,
		target: adapterPath,
		rpc: () =>
			stop
				? rpc.bluetooth.scanStop({ adapterPath })
				: rpc.bluetooth.scanStart({ adapterPath }),
		classify: refusalsRenderInline,
		confirmOnResolve: true,
		failMessage: () => m["network.os.operationFailed"](),
	});
	if (result && !result.success) {
		scanRefusalKey = bluetoothRefusalKey(result.error);
	}
}

// ── Per-device mutations ────────────────────────────────────────────────────
// Keyed by device path so two rows never share a refusal or an in-flight latch.
let deviceRefusals = $state<Record<string, string>>({});

function deviceKey(path: string): string {
	return `bluetooth-device:${path}`;
}

function deviceBusy(path: string): boolean {
	return getOperationPhase(deviceKey(path)) === 'pending';
}

function dispatchAction(path: string, action: BluetoothAction) {
	switch (action) {
		case 'pair':
			return rpc.bluetooth.pair({ devicePath: path });
		case 'connect':
			return rpc.bluetooth.connect({ devicePath: path });
		case 'disconnect':
			return rpc.bluetooth.disconnect({ devicePath: path });
		case 'trust':
			return rpc.bluetooth.trust({ devicePath: path, trusted: true });
		case 'untrust':
			return rpc.bluetooth.trust({ devicePath: path, trusted: false });
		case 'forget':
			return rpc.bluetooth.forget({ devicePath: path });
	}
}

async function runDeviceAction(path: string, action: BluetoothAction): Promise<void> {
	deviceRefusals = Object.fromEntries(
		Object.entries(deviceRefusals).filter(([key]) => key !== path),
	);
	const result = await osCommand({
		key: deviceKey(path),
		target: action,
		rpc: () => dispatchAction(path, action),
		classify: refusalsRenderInline,
		confirmOnResolve: true,
		failMessage: () => m["network.os.operationFailed"](),
	});
	if (result && !result.success) {
		deviceRefusals = { ...deviceRefusals, [path]: bluetoothRefusalKey(result.error) };
	}
}

const ACTION_LABEL_KEYS: Record<BluetoothAction, string> = {
	pair: 'network.bluetooth.actionPair',
	connect: 'network.bluetooth.actionConnect',
	disconnect: 'network.bluetooth.actionDisconnect',
	trust: 'network.bluetooth.actionTrust',
	untrust: 'network.bluetooth.actionUntrust',
	forget: 'network.bluetooth.actionForget',
};

function deviceName(device: BluetoothDevice): string {
	return device.name ?? device.address ?? m["network.bluetooth.deviceUnnamed"]();
}

/**
 * Deep-link to the Live destination.
 *
 * Lazily imported for the reason `dialog-request.svelte.ts` records: `$lib/config`
 * statically pulls the dev-only DevTools → pwa → `window.matchMedia` chain, and
 * `navigation.svelte` pulls `$lib/config` in turn. Resolving them at tap time
 * keeps both out of this component's static graph.
 */
async function openLiveSources(): Promise<void> {
	const { navElements } = await import('$lib/config');
	const { navigateTo } = await import('$lib/stores/navigation.svelte');
	if (navElements.live) navigateTo({ live: navElements.live });
}
</script>

<section class="bg-card rounded-xl border" data-testid="bluetooth-section">
	<div class="flex items-center gap-2 border-b px-4 py-3">
		<Bluetooth aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{m["network.bluetooth.title"]()}</h2>

		<span class="ms-auto flex shrink-0 items-center gap-2">
			{#if adapter && surface.kind === 'ready'}
				<Button
					class={`h-8 gap-1.5 px-2.5 ${TOUCH_TARGET}`}
					data-testid="bluetooth-scan"
					disabled={scanBusy}
					onclick={() => void toggleScan()}
					size="sm"
					variant="ghost"
				>
					{#if scanBusy}
						<LoaderCircle
							aria-hidden="true"
							class="size-3.5 animate-spin motion-reduce:animate-none"
						/>
					{:else}
						<Radar aria-hidden="true" class="size-3.5" />
					{/if}
					{scanning ? m["network.bluetooth.scanStop"]() : m["network.bluetooth.scan"]()}
				</Button>
			{/if}
			{#if enableBusy}
				<LoaderCircle
					aria-hidden="true"
					class="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
					data-testid="bluetooth-enable-pending"
				/>
			{/if}
			<Switch
				aria-label={m["network.bluetooth.enableLabel"]()}
				bind:checked={() => enabled, (next) => void toggleEnabled(next)}
				data-testid="bluetooth-enable"
				disabled={enableBusy}
			/>
		</span>
	</div>

	<div class="space-y-3 px-4 py-3">
		{#if surface.kind === 'unavailable'}
			<!-- Read from the device's own `getStatus()`, never assumed: an emulated
			     host, a dead bluetoothd, an unreachable bus and a board with no
			     controller are four different sentences. -->
			<p
				class="border-border bg-muted/40 text-muted-foreground rounded-lg border px-3 py-2.5 text-sm"
				data-cause={status?.unavailable?.cause}
				data-testid="bluetooth-unavailable"
				role="status"
			>
				{resolveMessageKey(surface.reasonKey)}
			</p>
		{/if}

		{#if enableRefusalKey}
			<p
				class="border-status-warning/30 bg-status-warning/10 rounded-lg border px-3 py-2.5 text-sm"
				data-testid="bluetooth-enable-refused"
				role="status"
			>
				{resolveMessageKey(enableRefusalKey)}
			</p>
		{/if}

		{#if surface.kind === 'off'}
			<div class="py-3 text-center" data-testid="bluetooth-off">
				<p class="text-sm font-medium">{m["network.bluetooth.off"]()}</p>
				<p class="text-muted-foreground mt-0.5 text-xs">{m["network.bluetooth.offHint"]()}</p>
			</div>
		{:else if surface.kind === 'ready'}
			{#if adapter}
				<div
					class="text-muted-foreground flex items-center gap-2 text-xs"
					data-discovering={scanning ? 'true' : 'false'}
					data-powered={adapter.powered ? 'true' : 'false'}
					data-testid="bluetooth-adapter"
				>
					<span
						class={`size-2 shrink-0 rounded-full ${
							scanning
								? 'bg-status-info motion-safe:animate-pulse'
								: adapter.powered
									? 'bg-status-success'
									: 'bg-muted-foreground/50'
						}`}
						aria-hidden="true"
					></span>
					<span role="status">{resolveMessageKey(adapterStateKey(adapter))}</span>
					{#if adapter.name}
						<span class="text-muted-foreground/70 truncate font-mono" dir="ltr">{adapter.name}</span>
					{/if}
				</div>
			{/if}

			{#if scanRefusalKey}
				<p
					class="border-status-warning/30 bg-status-warning/10 rounded-lg border px-3 py-2.5 text-sm"
					data-testid="bluetooth-scan-refused"
					role="status"
				>
					{resolveMessageKey(scanRefusalKey)}
				</p>
			{/if}

			{#if agentGap}
				<p
					class="border-border bg-muted/40 text-muted-foreground rounded-lg border px-3 py-2.5 text-xs"
					data-testid="bluetooth-agent-gap"
					role="status"
				>
					{m["network.bluetooth.agentGap"]()}
				</p>
			{/if}

			{#if devices.length === 0}
				<div class="py-3 text-center" data-testid="bluetooth-empty">
					<p class="text-sm font-medium">
						{scanning ? m["network.bluetooth.scanning"]() : m["network.bluetooth.noDevices"]()}
					</p>
					<p class="text-muted-foreground mt-0.5 text-xs">{m["network.bluetooth.noDevicesHint"]()}</p>
				</div>
			{:else}
				<ul
					class="divide-border divide-y overflow-hidden rounded-lg border"
					data-testid="bluetooth-devices"
				>
					{#each devices as device (device.path)}
						{@const busy = deviceBusy(device.path)}
						{@const refusal = deviceRefusals[device.path]}
						<li class="px-3 py-3" data-address={device.address} data-testid="bluetooth-device">
							<div class="flex items-start gap-3">
								{#if device.deviceClass === 'audio-input'}
									<Mic
										aria-hidden="true"
										class="text-primary mt-0.5 size-4 shrink-0"
										data-testid="bluetooth-device-icon-audio-input"
									/>
								{:else}
									<Bluetooth
										aria-hidden="true"
										class="text-muted-foreground mt-0.5 size-4 shrink-0"
										data-testid="bluetooth-device-icon-unknown"
									/>
								{/if}

								<div class="min-w-0 flex-1">
									<p class="truncate text-sm font-medium" data-testid="bluetooth-device-name">
										{deviceName(device)}
									</p>
									<p class="text-muted-foreground mt-0.5 truncate text-xs">
										{resolveMessageKey(deviceClassKey(device))}
									</p>

									<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
										{#if device.paired}
											<Badge
												data-testid="bluetooth-chip-paired"
												label={m["network.bluetooth.paired"]()}
												size="micro"
												variant="neutral"
											/>
										{/if}
										{#if device.trusted}
											<Badge
												data-testid="bluetooth-chip-trusted"
												label={m["network.bluetooth.trusted"]()}
												size="micro"
												variant="info"
											/>
										{/if}
										{#if device.connected}
											<Badge
												data-testid="bluetooth-chip-connected"
												label={m["network.bluetooth.connected"]()}
												size="micro"
												variant="success"
											/>
										{/if}
										<!-- ABSENT means the device exposes no battery service; a
										     rendered 0 % would be a level nothing measured. -->
										{#if device.battery !== undefined}
											<Badge
												data-testid="bluetooth-chip-battery"
												label={m["network.bluetooth.battery"]({ percent: device.battery })}
												size="micro"
												variant="neutral"
											/>
										{/if}
									</div>
								</div>

								<span class="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
									{#if busy}
										<LoaderCircle
											aria-hidden="true"
											class="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
											data-testid="bluetooth-device-pending"
										/>
									{/if}
									{#each bluetoothDeviceActions(device) as action (action)}
										<Button
											class={`h-8 px-2.5 ${TOUCH_TARGET}`}
											data-action={action}
											data-testid={`bluetooth-action-${action}`}
											disabled={busy}
											onclick={() => void runDeviceAction(device.path, action)}
											size="sm"
											variant={action === 'forget' ? 'ghost' : 'outline'}
										>
											{resolveMessageKey(ACTION_LABEL_KEYS[action])}
										</Button>
									{/each}
								</span>
							</div>

							{#if refusal}
								<p
									class="border-status-warning/30 bg-status-warning/10 mt-2 rounded-lg border px-3 py-2 text-xs"
									data-testid="bluetooth-device-refused"
									role="status"
								>
									{resolveMessageKey(refusal)}
								</p>
							{/if}

							{#if showsBluetoothMicBackendRefusal(device, audioBackend)}
								<p
									class="border-status-warning/30 bg-status-warning/10 mt-2 rounded-lg border px-3 py-2 text-xs"
									data-testid="bluetooth-audio-backend-refused"
									role="status"
								>
									{m["network.bluetooth.audioRequiresPipewire"]()}
								</p>
							{:else if showsAudioSourceHint(device, audioBackend)}
								<div
									class="border-primary/30 bg-primary/5 mt-2 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
									data-testid="bluetooth-audio-source-hint"
								>
									<p class="text-muted-foreground min-w-0 flex-1 text-xs">
										{m["network.bluetooth.audioHint"]()}
									</p>
									<Button
										class={`h-8 gap-1 px-2.5 ${TOUCH_TARGET}`}
										data-testid="bluetooth-audio-source-link"
										onclick={() => void openLiveSources()}
										size="sm"
										variant="ghost"
									>
										{m["network.bluetooth.audioHintAction"]()}
										<ChevronRight aria-hidden="true" class="size-3.5 rtl:rotate-180" />
									</Button>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</section>
