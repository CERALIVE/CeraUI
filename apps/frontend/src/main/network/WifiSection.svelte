<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { NetifMessage, WifiInterface } from '@ceraui/rpc/schemas';
import { ChevronRight, Loader2, Router, Settings2, Signal, Wifi, WifiOff } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import BondToggle from '$lib/components/custom/BondToggle.svelte';
import SimpleAlertDialog from '$lib/components/custom/simple-alert-dialog.svelte';
import SpeedBadge from '$lib/components/custom/SpeedBadge.svelte';
import { Button } from '$lib/components/ui/button';
import { convertBytesToKbids } from '$lib/helpers/network-speed';
import { getSignalCategory } from '$lib/helpers/signal';
import { rpc } from '$lib/rpc/client';
import { cn } from '$lib/utils';

import HotspotDialog from '../dialogs/HotspotDialog.svelte';

interface Props {
	/** Every WiFi radio (record key → interface) — both station and hotspot mode. */
	wifiRadios: [string, WifiInterface][];
	/** Per-interface telemetry: bond membership (`enabled`), static `ip`, throughput `tp`. */
	netif: NetifMessage | undefined;
	primaryWifiDevice: string | undefined;
	onConnect: () => void;
}

const { wifiRadios, netif, primaryWifiDevice, onConnect }: Props = $props();

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
let switching = $state<string | null>(null);

async function switchToHotspot(device: string) {
	if (switching) return;
	switching = device;
	try {
		await rpc.wifi.hotspotStart({ device });
	} catch {
		toast.error($LL.hotspotConfigurator.error.title(), {
			description: $LL.hotspotConfigurator.error.description(),
		});
	} finally {
		switching = null;
	}
}

async function switchToStation(device: string) {
	if (switching) return;
	switching = device;
	try {
		await rpc.wifi.hotspotStop({ device });
	} catch {
		toast.error($LL.hotspotConfigurator.error.title(), {
			description: $LL.hotspotConfigurator.error.description(),
		});
	} finally {
		switching = null;
	}
}
</script>

<!-- ───────────── WiFi ───────────── -->
<section class="bg-card rounded-xl border">
	<div class="flex items-center gap-2 border-b px-4 py-3">
		<Wifi aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{$LL.network.view.wifi()}</h2>
		<Button
			class="ms-auto h-8 gap-1 px-2.5"
			data-testid="open-wifi-selector-dialog"
			disabled={!primaryWifiDevice}
			size="sm"
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
				{@const net = activeWifiNetwork(iface)}
				{@const connected = Boolean(iface.conn && net)}
				{@const kbps = entry ? convertBytesToKbids(entry.tp) : null}
				{@const hasIp = Boolean(entry?.ip)}
				{@const isSwitching = switching === id}
				{@const hasControls = isHotspot || hasIp || iface.supports_hotspot}
				<div class="px-4 py-3">
					<!-- Identity row -->
					<div class="flex items-center gap-3">
						<span
							class={cn(
								'size-2 shrink-0 rounded-full',
								isHotspot ? 'bg-status-info' : connected ? 'bg-primary' : 'bg-muted-foreground/40',
							)}
							aria-hidden="true"
						></span>
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-medium">
								{#if isHotspot}
									{iface.hotspot?.name || iface.ifname}
								{:else}
									{iface.ifname}
								{/if}
							</p>
							<p class="text-muted-foreground truncate text-xs">
								{#if isHotspot}
									{$LL.network.view.hotspot()} · {iface.ifname}
								{:else if connected && net}
									{$LL.network.view.connected()} · {net.ssid}
								{:else}
									{$LL.network.view.disconnected()}
								{/if}
							</p>
						</div>
						<div class="flex shrink-0 items-center gap-2.5">
							<SpeedBadge {kbps} />
							{#if isHotspot}
								<span
									class="bg-status-info/10 text-status-info rounded-md px-1.5 py-0.5 text-xs font-medium"
								>
									{$LL.network.view.active()}
								</span>
							{:else if connected && net}
								<div class="flex items-center gap-1.5">
									<Signal class={cn('size-3.5', signalTextClass(net.signal))} aria-hidden="true" />
									<span class={cn('font-mono text-xs tabular-nums', signalTextClass(net.signal))}>
										{net.signal}%
									</span>
								</div>
							{:else}
								<WifiOff class="text-muted-foreground size-4" aria-hidden="true" />
							{/if}
						</div>
					</div>

					<!-- Control row: bond membership + station⇆hotspot mode -->
					{#if hasControls}
						<div class="border-border/60 mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
							{#if isHotspot}
								<!-- Hotspot mode: cannot bond; offer config + revert to station. -->
								<BondToggle
									name={iface.ifname}
									enabled={false}
									disabledReason={$LL.network.view.hotspotNoBond()}
								/>
								<div class="ms-auto flex items-center gap-2">
									<Button
										class="h-8 gap-1.5 px-2.5"
										disabled={isSwitching}
										size="sm"
										variant="ghost"
										onclick={() => openHotspotSetup(id)}
									>
										<Settings2 class="size-3.5" />
										{$LL.network.view.setup()}
									</Button>
									<Button
										class="h-8 gap-1.5 px-2.5"
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
								</div>
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
									<div class="ms-auto">
										<SimpleAlertDialog
											buttonText={$LL.network.view.switchToHotspot()}
											confirmButtonText={$LL.network.view.hotspotSwitchConfirm()}
											confirmVariant="destructive"
											extraButtonClasses="h-8 px-2.5 text-xs shadow-none bg-secondary text-secondary-foreground hover:bg-secondary/80"
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
									</div>
								{/if}
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</section>

<!-- Per-radio hotspot configurator -->
{#if hotspotIface}
	<HotspotDialog bind:open={hotspotDialogOpen} deviceId={hotspotDeviceId} iface={hotspotIface} />
{/if}
