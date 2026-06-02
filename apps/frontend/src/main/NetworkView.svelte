<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Modem, NetifEntry, NetifMessage, WifiInterface, WifiStatus } from '@ceraui/rpc/schemas';
import { Network as NetworkIcon } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { Skeleton } from '$lib/components/ui/skeleton';
import { getIsConnected, getModems, getNetif, getWifi } from '$lib/rpc/subscriptions.svelte';
import { getLinks } from '$lib/stores/hud.svelte';
import type { LinkSignal } from '$lib/types/hud';

import HotspotDialog from './dialogs/HotspotDialog.svelte';
import ModemConfigDialog from './dialogs/ModemConfigDialog.svelte';
import NetifDialog from './dialogs/NetifDialog.svelte';
import WifiSelectorDialog from './dialogs/WifiSelectorDialog.svelte';

import BondedLinksSection from './network/BondedLinksSection.svelte';
import CellularSection from './network/CellularSection.svelte';
import EthernetSection from './network/EthernetSection.svelte';
import HotspotSection from './network/HotspotSection.svelte';
import WifiSection from './network/WifiSection.svelte';

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

// Hotspot target for the configurator dialog: prefer an already-active hotspot
// interface, else the first hotspot-capable WiFi radio, else any WiFi radio.
const hotspotTarget = $derived(
	hotspotInterfaces[0] ??
		wifiEntries.find(([, iface]) => iface.supports_hotspot) ??
		wifiEntries[0],
);

let hotspotDialogOpen = $state(false);

const modemEntries = $derived(Object.entries(modems ?? {}) as [string, Modem][]);

// Wired / other interfaces: anything in netif that is not a modem (ww*),
// not a wifi radio (wl*), and not loopback.
const wiredEntries = $derived(
	Object.entries(netif ?? {}).filter(
		([name]) => !name.startsWith('ww') && !name.startsWith('wl') && name !== 'lo',
	) as [string, NetifEntry][],
);

// Dialog triggers are placeholders until Wave 2 (Tasks 21–24) wires the real dialogs.
function comingSoon(feature: string) {
	toast.info($LL.network.view.comingSoon({ feature }));
}

// Per-interface Ethernet configuration dialog (Task 24). The selected interface
// data is read LIVE from `netif` so the dialog reflects ongoing telemetry.
let netifDialogOpen = $state(false);
let selectedNetifName = $state('');
const selectedNetif = $derived(
	selectedNetifName ? (netif?.[selectedNetifName] ?? undefined) : undefined,
);

function configureNetif(name: string) {
	selectedNetifName = name;
	netifDialogOpen = true;
}

// WiFi network selector dialog — targets the primary WiFi station interface.
let wifiSelectorOpen = $state(false);
const primaryWifiDevice = $derived(wifiStations[0]?.[0]);

function openWifiSelector() {
	if (primaryWifiDevice) wifiSelectorOpen = true;
}

// Per-modem configuration dialog — one instance, keyed by the selected modem id.
let modemDialogOpen = $state(false);
let configModemId = $state<string | null>(null);
const configModem = $derived(modemEntries.find(([id]) => id === configModemId)?.[1]);

function openModemConfig(id: string) {
	configModemId = id;
	modemDialogOpen = true;
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
		<BondedLinksSection {links} {modemEntries} />
		<WifiSection {wifiStations} {primaryWifiDevice} onConnect={openWifiSelector} />
		<CellularSection {modemEntries} onConfigure={openModemConfig} />
		<EthernetSection {wiredEntries} onConfigure={configureNetif} />
		<HotspotSection {hotspotInterfaces} {hotspotTarget} onSetup={() => (hotspotDialogOpen = true)} />
	{/if}
</div>

<!-- Per-interface Ethernet configuration (Task 24) -->
<NetifDialog bind:open={netifDialogOpen} name={selectedNetifName} iface={selectedNetif} />

<!-- WiFi network selector — targets the primary WiFi station interface -->
{#if primaryWifiDevice}
	<WifiSelectorDialog bind:open={wifiSelectorOpen} deviceId={primaryWifiDevice} />
{/if}

{#if hotspotTarget}
	<HotspotDialog bind:open={hotspotDialogOpen} deviceId={hotspotTarget[0]} iface={hotspotTarget[1]} />
{/if}

{#if configModem && configModemId}
	<ModemConfigDialog bind:open={modemDialogOpen} deviceId={configModemId} modem={configModem} />
{/if}
