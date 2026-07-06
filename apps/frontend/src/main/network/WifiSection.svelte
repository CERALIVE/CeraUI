<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { NetifMessage, WifiInterface } from '@ceraui/rpc/schemas';
import { ChevronRight, Loader2, Router, Settings2, Wifi } from '@lucide/svelte';

import BondToggle from '$lib/components/custom/BondToggle.svelte';
import SimpleAlertDialog from '$lib/components/custom/simple-alert-dialog.svelte';
import Badge from '$lib/components/custom/Badge.svelte';
import { Button } from '$lib/components/ui/button';
import { deriveWifiModeOutcome } from '$lib/helpers/wifi-mode-outcome';
import {
	confirmOperation,
	getOperationPhase,
	isOperationPending,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { cn } from '$lib/utils';

import HotspotDialog from '../dialogs/HotspotDialog.svelte';

interface Props {
	/** Every WiFi radio (record key → interface) — both station and hotspot mode. */
	wifiRadios: [string, WifiInterface][];
	/** Per-interface telemetry: bond membership (`enabled`), static `ip`. */
	netif: NetifMessage | undefined;
	/** Whole-app staleness latch: the WS has been down past the global threshold. */
	isFullyStale: boolean;
	/** ifnames whose own telemetry aged out while siblings stayed fresh (Task 22). */
	staleInterfaces: Set<string>;
	primaryWifiDevice: string | undefined;
	onConnect: () => void;
}

const { wifiRadios, netif, isFullyStale, staleInterfaces, primaryWifiDevice, onConnect }: Props =
	$props();

function activeWifiNetwork(iface: WifiInterface) {
	return iface.available?.find((network) => network.active);
}

// ── Per-radio hotspot configurator (one mount, keyed by selected radio) ──
let hotspotDialogOpen = $state(false);
let hotspotDeviceId = $state('');
const hotspotIface = $derived(wifiRadios.find(([id]) => id === hotspotDeviceId)?.[1]);

function openHotspotSetup(id: string) {
	hotspotDeviceId = id;
	hotspotDialogOpen = true;
}

// ── Station ⇆ hotspot mode switching (a radio is ONE mode at a time) ──
// Switching to hotspot is destructive (drops the WiFi link + bond membership)
// so it is gated behind a confirm dialog; switching back to station is not.
//
// The transition is owned by the keyed async-operation store under
// `hotspot:${device}` — the SAME key HotspotDialog uses, so only one hotspot op
// per device is ever in flight (osCommand's re-entry guard enforces it). The
// per-device target is remembered locally so the confirm $effect below can flip
// the op to `confirmed` the moment the authoritative `wifi` snapshot reports the
// target mode, and so the label is held on the CURRENT mode until then — a raw
// `wifi` broadcast must never clobber the label mid-switch.
const switchTargets = $state<Record<string, 'hotspot' | 'station'>>({});

async function switchToHotspot(device: string) {
	switchTargets[device] = 'hotspot';
	await osCommand({
		key: `hotspot:${device}`,
		target: 'hotspot',
		rpc: () => rpc.wifi.hotspotStart({ device }),
		failMessage: () => $LL.network.os.operationFailed(),
		busyMessage: () => $LL.network.os.deviceBusy(),
	});
}

async function switchToStation(device: string) {
	switchTargets[device] = 'station';
	await osCommand({
		key: `hotspot:${device}`,
		target: 'station',
		rpc: () => rpc.wifi.hotspotStop({ device }),
		failMessage: () => $LL.network.os.operationFailed(),
		busyMessage: () => $LL.network.os.deviceBusy(),
	});
}

// Confirm a pending mode switch as soon as the authoritative `wifi` snapshot
// reports the target mode. The store's 15 s TTL valve is the backstop if the
// device never reports back (the op then decays to `timed_out`).
$effect(() => {
	for (const [id, iface] of wifiRadios) {
		if (getOperationPhase(`hotspot:${id}`) !== 'pending') continue;
		if (deriveWifiModeOutcome(switchTargets[id], Boolean(iface.hotspot)) === 'confirmed') {
			confirmOperation(`hotspot:${id}`);
		}
	}
});
</script>

<!-- ───────────── WiFi ───────────── -->
<section class="bg-card rounded-xl border">
	<div class="flex items-center gap-2 border-b px-4 py-3">
		<Wifi aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{$LL.network.view.wifi()}</h2>
		<Button
			class="ms-auto h-8 min-h-[var(--touch-target-min)] gap-1 px-2.5"
			data-testid="open-wifi-selector-dialog"
			disabled={!primaryWifiDevice}
			size="sm"
			title={primaryWifiDevice ? undefined : $LL.network.view.noWifi()}
			variant="ghost"
			onclick={onConnect}
		>
			{$LL.network.view.connect()}
			<ChevronRight class="size-3.5 rtl:rotate-180" />
		</Button>
	</div>
	<div class="divide-y">
		{#if wifiRadios.length === 0}
			<p class="text-muted-foreground px-4 py-6 text-center text-sm">
				{$LL.network.view.noWifi()}
			</p>
		{:else}
			{#each wifiRadios as [id, iface] (id)}
				{@const entry = netif?.[iface.ifname]}
				{@const isHotspot = Boolean(iface.hotspot)}
				{@const isSwitching = isOperationPending(`hotspot:${id}`)}
				<!-- Hold the label on the CURRENT mode while a switch is pending: a raw
				     `wifi` broadcast must not flip it before the op is confirmed. -->
				{@const displayIsHotspot = isSwitching ? switchTargets[id] === 'station' : isHotspot}
				{@const net = activeWifiNetwork(iface)}
				{@const connected = Boolean(iface.conn && net)}
				{@const ifaceStale = staleInterfaces.has(iface.ifname) || isFullyStale}
				{@const showStale = ifaceStale && !displayIsHotspot && connected}
				{@const hasIp = Boolean(entry?.ip)}
				{@const hasControls = displayIsHotspot || hasIp || iface.supports_hotspot}
				<!-- Single-line row: identity (dot · name · status) left; bond + actions right. -->
				<div class="flex flex-wrap items-center gap-3 px-4 py-2.5">
					<span
						class={cn(
							'size-2 shrink-0 rounded-full',
							displayIsHotspot ? 'bg-status-info' : connected ? 'bg-primary' : 'bg-muted-foreground/40',
						)}
						aria-hidden="true"
					></span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium">
							{#if displayIsHotspot}
								{iface.hotspot?.name || iface.ifname}
							{:else}
								{iface.ifname}
							{/if}
						</p>
						<p
							class={cn(
								'text-muted-foreground truncate text-xs transition-opacity',
								!displayIsHotspot && ifaceStale && 'opacity-50',
							)}
						>
							{#if displayIsHotspot}
								{$LL.network.view.hotspot()} · {iface.ifname}
							{:else if connected && net}
								{$LL.network.view.connected()} · {net.ssid}
							{:else}
								{$LL.network.view.disconnected()}
							{/if}
						</p>
					</div>
					<div class="ms-auto flex shrink-0 items-center gap-2">
						{#if showStale}
							<Badge variant="stale" data-stale-interface={iface.ifname} />
						{/if}
						{#if hasControls}
							{#if displayIsHotspot}
								<!-- Hotspot mode: cannot bond; offer config + revert to station. -->
								<BondToggle
									name={iface.ifname}
									enabled={false}
									disabledReason={$LL.network.view.hotspotNoBond()}
								/>
								<Button
									class="h-8 min-h-[var(--touch-target-min)] gap-1.5 px-2.5"
									disabled={isSwitching}
									size="sm"
									variant="ghost"
									onclick={() => openHotspotSetup(id)}
								>
									<Settings2 class="size-3.5" />
									{$LL.network.view.setup()}
								</Button>
								<Button
									class="h-8 min-h-[var(--touch-target-min)] gap-1.5 px-2.5"
									disabled={isSwitching}
									size="sm"
									variant="secondary"
									onclick={() => switchToStation(id)}
								>
									{#if isSwitching}
										<Loader2 class="size-3.5 animate-spin motion-reduce:animate-none" />
									{:else}
										<Wifi class="size-3.5" />
									{/if}
									{$LL.network.view.switchToStation()}
								</Button>
							{:else}
								<!-- Station mode: bond when it holds an IP; offer switch to hotspot. -->
								{#if hasIp}
									<BondToggle
										name={iface.ifname}
										enabled={Boolean(entry?.enabled)}
										ip={entry?.ip}
									/>
								{/if}
								{#if iface.supports_hotspot}
									{#if isSwitching}
										<!-- Switch confirmed at the click; hold a spinner until the
										     authoritative snapshot flips the label to hotspot. -->
										<Button
											class="h-8 min-h-[var(--touch-target-min)] gap-1.5 px-2.5 text-xs"
											disabled
											size="sm"
											variant="secondary"
										>
											<Loader2 class="size-3.5 animate-spin motion-reduce:animate-none" />
											{$LL.network.view.switchToHotspot()}
										</Button>
									{:else}
										<SimpleAlertDialog
											buttonText={$LL.network.view.switchToHotspot()}
											confirmButtonText={$LL.network.view.hotspotSwitchConfirm()}
											confirmVariant="destructive"
											extraButtonClasses="h-8 min-h-[var(--touch-target-min)] px-2.5 text-xs shadow-none bg-secondary text-secondary-foreground hover:bg-secondary/80"
											iconPosition="left"
											title={$LL.network.view.hotspotSwitchTitle()}
											onconfirm={() => switchToHotspot(id)}
										>
											{#snippet icon()}
												<Router class="size-3.5" />
											{/snippet}
											{#snippet dialogTitle()}
												{$LL.network.view.hotspotSwitchTitle()}
											{/snippet}
											{#snippet description()}
												{$LL.network.view.hotspotSwitchBody()}
											{/snippet}
										</SimpleAlertDialog>
									{/if}
								{/if}
							{/if}
						{/if}
					</div>
				</div>
			{/each}
		{/if}
	</div>
</section>

<!-- Per-radio hotspot configurator -->
{#if hotspotIface}
	<HotspotDialog bind:open={hotspotDialogOpen} deviceId={hotspotDeviceId} iface={hotspotIface} />
{/if}
