<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { WifiInterface } from '@ceraui/rpc/schemas';
import { ChevronRight, Signal, Wifi, WifiOff } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { convertBytesToKbids } from '$lib/helpers/network-speed';
import { signalTextClass } from '$lib/helpers/signal';
import { rpc } from '$lib/rpc/client';
import { cn } from '$lib/utils';

interface Props {
	wifiStations: [string, WifiInterface][];
	primaryWifiDevice: string | undefined;
	onConnect: () => void;
}

const { wifiStations, primaryWifiDevice, onConnect }: Props = $props();

function activeWifiNetwork(iface: WifiInterface) {
	return iface.available?.find((network) => network.active);
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
		{#if wifiStations.length === 0}
			<p class="text-muted-foreground px-4 py-6 text-center text-sm">
				{$LL.network.view.noWifi()}
			</p>
		{:else}
			{#each wifiStations as [id, iface] (id)}
				{@const net = activeWifiNetwork(iface)}
				{@const connected = Boolean(iface.conn && net)}
				{@const link = links.find((l) => l.id === iface.ifname)}
				{@const kbps = link ? link.throughputKbps : entry ? convertBytesToKbids(entry.tp) : null}
				{@const rawStale = link?.isStale ?? isFullyStale}
				{@const tpStale = getStalenessState(kbps, null, rawStale) === 'stale'}
				{@const sigStale = net ? getStalenessState(net.signal, null, rawStale) === 'stale' : false}
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
							<p
								class={cn(
									'text-muted-foreground truncate text-xs transition-opacity',
									!isHotspot && rawStale && 'opacity-50',
								)}
							>
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
							<SpeedBadge {kbps} stale={tpStale} />
							{#if isHotspot}
								<span
									class="bg-status-info/10 text-status-info rounded-md px-1.5 py-0.5 text-xs font-medium"
								>
									{$LL.network.view.active()}
								</span>
							{:else if connected && net}
								<div
									data-live-value
									class={cn('flex items-center gap-1.5 transition-opacity', sigStale && 'opacity-50')}
								>
									<Signal class={cn('size-3.5', signalTextClass(net.signal))} aria-hidden="true" />
									<span class={cn('font-mono text-xs tabular-nums', signalTextClass(net.signal))}>
										{net.signal}%
									</span>
								</div>
							{:else}
								{$LL.network.view.disconnected()}
							{/if}
						</p>
					</div>
					{#if connected && net}
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
			{/each}
		{/if}
	</div>
</section>
