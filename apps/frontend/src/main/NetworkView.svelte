<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Modem, NetifMessage, WifiInterface, WifiStatus } from '@ceraui/rpc/schemas';
import {
	ChevronRight,
	Network as NetworkIcon,
	Radio,
	Router,
	Signal,
	Wifi,
	WifiOff,
} from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';
import { Skeleton } from '$lib/components/ui/skeleton';
import { getSignalCategory } from '$lib/helpers/signal';
import { getIsConnected, getModems, getNetif, getWifi } from '$lib/rpc/subscriptions.svelte';
import { getLinks } from '$lib/stores/hud.svelte';
import type { LinkSignal } from '$lib/types/hud';
import { cn } from '$lib/utils';

// Getters — always from the non-deprecated subscriptions surface (never websocket-store).
const wifi = $derived<WifiStatus | undefined>(getWifi());
const modems = $derived(getModems());
const netif = $derived<NetifMessage | undefined>(getNetif());
const isConnected = $derived(getIsConnected());

// Bonded links come from the HUD store so colour identity (--link-N) is
// IDENTICAL to the persistent HUD bar — link.linkIndex (0-based) → --link-{n+1}.
const links = $derived<LinkSignal[]>(getLinks());

// Loading: no telemetry has arrived yet on this connection.
const isLoading = $derived(
	!isConnected && wifi === undefined && modems === undefined && netif === undefined,
);

// WiFi interfaces split so hotspot + station can be shown SIMULTANEOUSLY
// (never one-or-the-other): a hotspot-mode interface carries a `hotspot` field.
const wifiEntries = $derived(Object.entries(wifi ?? {}) as [string, WifiInterface][]);
const wifiStations = $derived(wifiEntries.filter(([, iface]) => !iface.hotspot));
const hotspotInterfaces = $derived(wifiEntries.filter(([, iface]) => Boolean(iface.hotspot)));

const modemEntries = $derived(Object.entries(modems ?? {}) as [string, Modem][]);

// Wired / other interfaces: anything in netif that is not a modem (ww*),
// not a wifi radio (wl*), and not loopback.
const wiredEntries = $derived(
	Object.entries(netif ?? {}).filter(
		([name]) => !name.startsWith('ww') && !name.startsWith('wl') && name !== 'lo',
	),
);

/** signal % → 0..3 bars (null = no data → 0 bars). */
function signalBars(signal: number | null): number {
	if (signal == null) return 0;
	if (signal >= 66) return 3;
	if (signal >= 33) return 2;
	return 1;
}

/** Text colour token for a signal reading, matching SignalIndicator tiers. */
function signalTextClass(signal: number | null): string {
	if (signal == null) return 'text-muted-foreground';
	switch (getSignalCategory(signal)) {
		case 'excellent':
			return 'text-signal-excellent';
		case 'good':
			return 'text-signal-good';
		case 'fair':
			return 'text-signal-fair';
		default:
			return 'text-signal-weak';
	}
}

/** A short type tag for a bonded link (WiFi, or the modem's network generation). */
function linkTypeLabel(link: LinkSignal): string {
	if (link.type === 'wifi') return $LL.network.view.wifi();
	const modem = modemEntries.find(([, m]) => (m.ifname || '') === link.id)?.[1];
	return modem?.status?.network_type || $LL.network.view.cellular();
}

function modemSignal(modem: Modem): number | null {
	if (modem.no_sim) return null;
	const signal = modem.status?.signal;
	if (signal == null || !Number.isFinite(signal) || signal < 0) return null;
	return signal;
}

function activeWifiNetwork(iface: WifiInterface) {
	return iface.available?.find((network) => network.active);
}

// Dialog triggers are placeholders until Wave 2 (Tasks 21–24) wires the real dialogs.
function comingSoon(feature: string) {
	toast.info($LL.network.view.comingSoon({ feature }));
}
</script>

<div class="mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6">
	<!-- Destination header -->
	<header class="flex items-center gap-2.5">
		<NetworkIcon aria-hidden="true" class="text-primary size-5 shrink-0" />
		<h1 class="text-xl font-semibold tracking-tight">{$LL.navigation.network()}</h1>
	</header>

	{#if isLoading}
		<!-- Loading state -->
		<div class="space-y-5" aria-busy="true" aria-label={$LL.network.view.loading()}>
			<Skeleton class="h-24 w-full rounded-xl" />
			<Skeleton class="h-32 w-full rounded-xl" />
			<Skeleton class="h-32 w-full rounded-xl" />
		</div>
	{:else}
		<!-- ───────────── Bonded Links overview ───────────── -->
		<section class="bg-card rounded-xl border p-4 sm:p-5" aria-label={$LL.network.view.bondedLinks()}>
			<div class="mb-3 flex items-center gap-2">
				<Radio aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
				<h2 class="text-sm font-semibold tracking-tight">{$LL.network.view.bondedLinks()}</h2>
			</div>

			{#if links.length === 0}
				<p class="text-muted-foreground text-sm">{$LL.network.view.noLinks()}</p>
			{:else}
				<div class="flex flex-wrap gap-2.5">
					{#each links as link (link.id)}
						{@const color = `var(--link-${link.linkIndex + 1})`}
						{@const bars = signalBars(link.signal)}
						<div
							class={cn(
								'flex items-center gap-2.5 rounded-lg border px-3 py-2',
								link.isStale && 'opacity-60',
							)}
							style="border-color: color-mix(in oklab, {color} 35%, transparent); background-color: color-mix(in oklab, {color} 10%, transparent);"
						>
							<span
								class="text-xs font-bold tabular-nums"
								style="color: {color};">L{link.linkIndex + 1}</span
							>
							<!-- mini signal bars (match HUD aesthetic) -->
							<div class="flex items-end gap-0.5" aria-hidden="true">
								{#each [1, 2, 3] as bar (bar)}
									<span
										class="w-1 rounded-[1px]"
										style="height: {bar * 3 + 2}px; background-color: {bar <= bars
											? color
											: 'var(--muted)'};"
									></span>
								{/each}
							</div>
							<div class="flex min-w-0 flex-col leading-tight">
								<span class="truncate text-xs font-medium">{link.label}</span>
								<span class="text-muted-foreground text-[10px] uppercase tracking-wide"
									>{linkTypeLabel(link)}</span
								>
							</div>
							<span class="ms-1 font-mono text-xs tabular-nums" style="color: {color};">
								{link.signal == null ? '—' : `${link.signal}%`}
							</span>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- ───────────── WiFi ───────────── -->
		<section class="bg-card rounded-xl border">
			<div class="flex items-center gap-2 border-b px-4 py-3">
				<Wifi aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
				<h2 class="text-sm font-semibold tracking-tight">{$LL.network.view.wifi()}</h2>
				<Button
					class="ms-auto h-8 gap-1 px-2.5"
					size="sm"
					variant="ghost"
					onclick={() => comingSoon($LL.network.view.wifi())}
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

		<!-- ───────────── Cellular ───────────── -->
		<section class="bg-card rounded-xl border">
			<div class="flex items-center gap-2 border-b px-4 py-3">
				<Radio aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
				<h2 class="text-sm font-semibold tracking-tight">{$LL.network.view.cellular()}</h2>
				<Button
					class="ms-auto h-8 gap-1 px-2.5"
					size="sm"
					variant="ghost"
					onclick={() => comingSoon($LL.network.view.cellular())}
				>
					{$LL.network.view.configure()}
					<ChevronRight class="size-3.5 rtl:rotate-180" />
				</Button>
			</div>
			<div class="divide-y">
				{#if modemEntries.length === 0}
					<p class="text-muted-foreground px-4 py-6 text-center text-sm">
						{$LL.network.view.noModems()}
					</p>
				{:else}
					{#each modemEntries as [id, modem] (id)}
						{@const sig = modemSignal(modem)}
						{@const connected = modem.status?.connection === 'connected'}
						{@const operator = modem.status?.network || modem.sim_network || modem.name}
						<div class="flex items-center gap-3 px-4 py-3">
							<span
								class={cn('size-2 shrink-0 rounded-full', connected ? 'bg-primary' : 'bg-muted-foreground/40')}
								aria-hidden="true"
							></span>
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">{modem.name}</p>
								<p class="text-muted-foreground truncate text-xs">
									{#if modem.no_sim}
										{$LL.network.view.noModems()}
									{:else}
										{operator}{#if modem.status?.network_type}
											· {modem.status.network_type}{/if} ·
										{connected ? $LL.network.view.connected() : $LL.network.view.disconnected()}
									{/if}
								</p>
							</div>
							{#if sig != null}
								<div class="flex items-center gap-1.5">
									<Signal class={cn('size-3.5', signalTextClass(sig))} aria-hidden="true" />
									<span class={cn('font-mono text-xs tabular-nums', signalTextClass(sig))}>
										{sig}%
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

		<!-- ───────────── Ethernet / interfaces ───────────── -->
		<section class="bg-card rounded-xl border">
			<div class="flex items-center gap-2 border-b px-4 py-3">
				<NetworkIcon aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
				<h2 class="text-sm font-semibold tracking-tight">{$LL.network.view.ethernet()}</h2>
			</div>
			<div class="divide-y">
				{#if wiredEntries.length === 0}
					<p class="text-muted-foreground px-4 py-6 text-center text-sm">
						{$LL.network.view.noEthernet()}
					</p>
				{:else}
					{#each wiredEntries as [name, iface] (name)}
						<div class="flex items-center gap-3 px-4 py-3">
							<span
								class={cn('size-2 shrink-0 rounded-full', iface.enabled ? 'bg-primary' : 'bg-muted-foreground/40')}
								aria-hidden="true"
							></span>
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">{name}</p>
								<p class="text-muted-foreground truncate text-xs">
									{#if iface.ip}
										<code class="font-mono">{iface.ip}</code> ·
									{/if}
									{iface.enabled ? $LL.network.view.connected() : $LL.network.view.off()}
								</p>
							</div>
							<Button
								class="h-8 gap-1 px-2.5"
								size="sm"
								variant="ghost"
								onclick={() => comingSoon($LL.network.view.ethernet())}
							>
								{$LL.network.view.configure()}
								<ChevronRight class="size-3.5 rtl:rotate-180" />
							</Button>
						</div>
					{/each}
				{/if}
			</div>
		</section>

		<!-- ───────────── Hotspot (independent of WiFi: simultaneous state) ───────────── -->
		<section class="bg-card rounded-xl border">
			<div class="flex items-center gap-2 border-b px-4 py-3">
				<Router aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
				<h2 class="text-sm font-semibold tracking-tight">{$LL.network.view.hotspot()}</h2>
				<Button
					class="ms-auto h-8 gap-1 px-2.5"
					size="sm"
					variant="ghost"
					onclick={() => comingSoon($LL.network.view.hotspot())}
				>
					{$LL.network.view.setup()}
					<ChevronRight class="size-3.5 rtl:rotate-180" />
				</Button>
			</div>
			<div class="divide-y">
				{#if hotspotInterfaces.length === 0}
					<div class="px-4 py-6 text-center">
						<p class="text-sm font-medium">{$LL.network.view.hotspotOff()}</p>
						<p class="text-muted-foreground mt-0.5 text-xs">{$LL.network.view.hotspotOffHint()}</p>
					</div>
				{:else}
					{#each hotspotInterfaces as [id, iface] (id)}
						<div class="flex items-center gap-3 px-4 py-3">
							<span class="bg-status-info size-2 shrink-0 rounded-full" aria-hidden="true"></span>
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">{iface.hotspot?.name || iface.ifname}</p>
								<p class="text-muted-foreground truncate text-xs">
									{$LL.network.view.active()} · {iface.ifname}
								</p>
							</div>
							<span
								class="bg-status-info/10 text-status-info rounded-md px-1.5 py-0.5 text-xs font-medium"
							>
								{$LL.network.view.active()}
							</span>
						</div>
					{/each}
				{/if}
			</div>
		</section>
	{/if}
</div>
