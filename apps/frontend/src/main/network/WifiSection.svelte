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
				<div class="flex items-center gap-3 px-4 py-3">
					<span
						class={cn('size-2 shrink-0 rounded-full', connected ? 'bg-primary' : 'bg-muted-foreground/40')}
						aria-hidden="true"
					></span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium">{iface.ifname}</p>
						<p class="text-muted-foreground truncate text-xs">
							{#if connected && net}
								{$LL.network.view.connected()} · {net.ssid}
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
