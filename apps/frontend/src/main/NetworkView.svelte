<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { Modem, NetifEntry, NetifMessage, WifiInterface, WifiStatus } from '@ceraui/rpc/schemas';
import { Network as NetworkIcon } from '@lucide/svelte';

import { Skeleton } from '$lib/components/ui/skeleton';
import { isApRadio } from '$lib/helpers/wifi-mode-outcome';
import { hotspotIsActive } from '$lib/rpc/os-toggle-predicates';
import {
	getBluetooth,
	getIsConnected,
	getLinkTelemetry,
	getModems,
	getNetif,
	getStatus,
	getWifi,
} from '$lib/rpc/subscriptions.svelte';
import { getHudState } from '$lib/stores/hud.svelte';
import type { LinkSignal } from '$lib/types/hud';

import { LazyDialog, lazyDialog } from '$lib/components/dialogs';

import BluetoothSection from './network/BluetoothSection.svelte';
import BondedLinksSection from './network/BondedLinksSection.svelte';
import { activeSimLock, isBlockingSimLock } from './network/cellular-row';
import CellularSection from './network/CellularSection.svelte';
import CollisionBands from './network/CollisionBands.svelte';
import EthernetSection from './network/EthernetSection.svelte';
import HotspotSection from './network/HotspotSection.svelte';
import { isWiredSectionEntry, modemClaimedIfnames } from './network/section-assignment';
import UnclaimedAdaptersBand from './network/UnclaimedAdaptersBand.svelte';
import WifiSection from './network/WifiSection.svelte';

// None of these is on the path to first paint — each is its own chunk, fetched
// on first open.
const NetifDialog = lazyDialog(() => import('./dialogs/NetifDialog.svelte'));
const WifiSelectorDialog = lazyDialog(() => import('./dialogs/WifiSelectorDialog.svelte'));
const HotspotDialog = lazyDialog(() => import('./dialogs/HotspotDialog.svelte'));
const ModemConfigDialog = lazyDialog(() => import('./dialogs/ModemConfigDialog.svelte'));
const SimUnlockDialog = lazyDialog(() => import('./dialogs/SimUnlockDialog.svelte'));
const RouterDongleDialog = lazyDialog(() => import('./dialogs/RouterDongleDialog.svelte'));
// Reached from a Wi-Fi radio whose 6 GHz band its regulatory domain forbids —
// the same dialog Settings mounts, opened where the operator met the block.
const WifiCountryDialog = lazyDialog(() => import('./dialogs/WifiCountryDialog.svelte'));

// Getters — always from the non-deprecated subscriptions surface.
const wifi = $derived<WifiStatus | undefined>(getWifi());
const modems = $derived(getModems());
const netif = $derived<NetifMessage | undefined>(getNetif());
const isConnected = $derived(getIsConnected());
const linkTelemetry = $derived(getLinkTelemetry());
const bluetooth = $derived(getBluetooth());

// Bonded links come from the HUD store so colour identity (--link-N) is
// IDENTICAL to the persistent HUD bar — link.linkIndex (0-based) → --link-{n+1}.
// The full snapshot also carries `isFullyStale`, threaded into every live-value
// section so per-source staleness (Task 18) is decided in one place.
const hud = $derived(getHudState());
const links = $derived<LinkSignal[]>(hud.links);
const isFullyStale = $derived(hud.isFullyStale);
// Per-interface staleness (Task 22): decided once in the HUD store so the
// section marker matches the bonded-link and HUD-bar verdict exactly.
const staleInterfaces = $derived(hud.staleInterfaces);

// Loading: no telemetry has arrived yet on this connection.
const isLoading = $derived(
	!isConnected && wifi === undefined && modems === undefined && netif === undefined,
);

// WiFi interfaces split so hotspot + station can be shown SIMULTANEOUSLY
// (never one-or-the-other): a hotspot-mode interface carries a `hotspot` field.
const wifiEntries = $derived(Object.entries(wifi ?? {}) as [string, WifiInterface][]);
const hotspotInterfaces = $derived(wifiEntries.filter(([, iface]) => hotspotIsActive(iface)));

// Hotspot target for the configurator dialog: prefer an already-active hotspot
// interface, else the first hotspot-capable WiFi radio, else any WiFi radio.
const hotspotTarget = $derived(
	hotspotInterfaces[0] ??
		wifiEntries.find(([, iface]) => iface.supports_hotspot) ??
		wifiEntries[0],
);

let hotspotDialogOpen = $state(false);
let wifiCountryOpen = $state(false);

const modemEntries = $derived(Object.entries(modems ?? {}) as [string, Modem][]);

// Strictly `=== true`: absent is an older backend that never published the flag,
// and reading that as "initializing" would band every such device forever.
const cellularInitializing = $derived(getStatus()?.cellular_initializing === true);

// Wired / other interfaces: anything in netif that is not a modem (ww*),
// not a wifi radio (wl*), and not loopback.
//
// A cellular device's interface leaves this list for the Cellular section once
// a modem row claims it — a router-mode dongle or an MM-managed modem's own
// RNDIS data function alike. The rule lives in `section-assignment.ts` so it can
// be tested without mounting this view.
const claimedByModem = $derived(modemClaimedIfnames(modemEntries));
const wiredEntries = $derived(
	Object.entries(netif ?? {}).filter(([name, iface]) =>
		isWiredSectionEntry(name, iface, claimedByModem),
	) as [string, NetifEntry][],
);

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

// WiFi network selector dialog — scoped to the radio whose Connect was tapped.
let wifiSelectorOpen = $state(false);
let wifiSelectorDeviceId = $state('');

function openWifiSelector(deviceId: string) {
	wifiSelectorDeviceId = deviceId;
	wifiSelectorOpen = true;
}

// Per-modem configuration dialog — one instance, keyed by the selected modem id.
let modemDialogOpen = $state(false);
let configModemId = $state<string | null>(null);
const configModem = $derived(modemEntries.find(([id]) => id === configModemId)?.[1]);

// Router-dongle settings — one instance, keyed like the others.
let dongleDialogOpen = $state(false);
let dongleModemId = $state<string | null>(null);
const dongleModem = $derived(modemEntries.find(([id]) => id === dongleModemId)?.[1]);

// SIM unlock — one instance, keyed the same way. It is reached ONLY by an
// operator action on the modem it belongs to; there is deliberately no
// auto-open effect here anymore. See `openModemConfig` below.
let simUnlockOpen = $state(false);
let unlockModemId = $state<string | null>(null);
const unlockModem = $derived(modemEntries.find(([id]) => id === unlockModemId)?.[1]);

function openSimUnlock(id: string) {
	unlockModemId = id;
	simUnlockOpen = true;
}

/**
 * The row's primary action. It routes on the SAME lock the button was labelled
 * from (`resolveRowAction`), so what the operator reads and where they land
 * cannot disagree.
 *
 * This REPLACED a global `$effect` that popped the unlock dialog over the whole
 * Network destination as soon as any modem reported a lock. Three things were
 * wrong with it, and the third is why it is gone rather than merely debounced:
 *
 *  1. It hijacked a shared page for a device-scoped problem — an operator
 *     opening Network mid-broadcast to check bonding got a modal PIN prompt.
 *  2. It was `find()`-based, so with two locked modems the second was
 *     unreachable no matter what the operator did.
 *  3. A PIN2 unlock CANNOT be made to stick. `Sim.SendPin` verifies for the
 *     current UICC power session only, ModemManager keeps no PIN cache, and the
 *     one persistent mechanism (`EnablePin(pin,false)`) has no PIN2 equivalent
 *     at all. So the lock returns on every single boot, forever, for something
 *     that blocks no traffic — an auto-prompt the operator could never silence.
 *
 * That third point is now settled the other way round: PIN2/PUK2 is not
 * surfaced anywhere in this UI at all, because it gates only the SIM's
 * Fixed-Dialling-Number list and this product has no calls or contacts surface
 * to reach it from. The row's own "SIM locked" badge remains the discovery
 * surface, and it now only ever names a lock that really did stop the radio.
 */
function openModemConfig(id: string) {
	const modem = modemEntries.find(([entryId]) => entryId === id)?.[1];
	if (modem && isBlockingSimLock(activeSimLock(modem))) {
		openSimUnlock(id);
		return;
	}
	// A router dongle's settings live in its OWN admin API, not in ModemManager,
	// so it gets its own dialog rather than a ModemConfigDialog full of controls
	// that could never reach it. Routing on `device_class` keeps the choice on
	// the same fact the row was rendered from.
	if (modem?.device_class === 'router-ethernet') {
		dongleModemId = id;
		dongleDialogOpen = true;
		return;
	}
	configModemId = id;
	modemDialogOpen = true;
}
</script>

<div class="mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6">
	<!-- Destination header -->
	<header class="flex items-center gap-2.5">
		<NetworkIcon aria-hidden="true" class="text-primary size-5 shrink-0" />
		<h1 class="text-xl font-semibold tracking-tight">{m["navigation.network"]()}</h1>
	</header>

	{#if isLoading}
		<!-- Loading state -->
		<div class="space-y-5" aria-busy="true" aria-label={m["network.view.loading"]()}>
			<Skeleton class="h-24 w-full rounded-xl" />
			<Skeleton class="h-32 w-full rounded-xl" />
			<Skeleton class="h-32 w-full rounded-xl" />
		</div>
	{:else}
		<BondedLinksSection
			{links}
			{modemEntries}
			{linkTelemetry}
			unbondedCount={hud.unbondedLinkCount}
		/>
		<CollisionBands {netif} bondMapping={getStatus()?.bond_mapping ?? null} />
		<UnclaimedAdaptersBand adapters={getStatus()?.unclaimed_adapters} />
		<WifiSection
			wifiRadios={wifiEntries}
			{netif}
			{isFullyStale}
			{staleInterfaces}
			onConnect={openWifiSelector}
			onOpenCountry={() => (wifiCountryOpen = true)}
		/>
		<CellularSection
			{modemEntries}
			{netif}
			{isFullyStale}
			{staleInterfaces}
			{cellularInitializing}
			onConfigure={openModemConfig}
		/>
		<EthernetSection
			{wiredEntries}
			{isFullyStale}
			{staleInterfaces}
			onConfigure={configureNetif}
		/>
		<HotspotSection {hotspotInterfaces} {hotspotTarget} onSetup={() => (hotspotDialogOpen = true)} />
		<BluetoothSection status={bluetooth} />
	{/if}
</div>

<!-- Per-interface Ethernet configuration (Task 24) -->
<LazyDialog
	dialog={NetifDialog}
	bind:open={netifDialogOpen}
	name={selectedNetifName}
	iface={selectedNetif}
/>

<!-- WiFi network selector — scoped to the radio whose Connect was tapped -->
{#if wifiSelectorDeviceId}
	<LazyDialog
		dialog={WifiSelectorDialog}
		bind:open={wifiSelectorOpen}
		deviceId={wifiSelectorDeviceId}
	/>
{/if}

{#if hotspotTarget}
	<LazyDialog
		dialog={HotspotDialog}
		bind:open={hotspotDialogOpen}
		deviceId={hotspotTarget[0]}
		iface={hotspotTarget[1]}
	/>
{/if}

<LazyDialog dialog={WifiCountryDialog} bind:open={wifiCountryOpen} />

{#if configModem && configModemId}
	<LazyDialog
		dialog={ModemConfigDialog}
		bind:open={modemDialogOpen}
		deviceId={configModemId}
		modem={configModem}
	/>
{/if}

{#if dongleModem && dongleModemId}
	<!-- `hasAddress` is a TRISTATE and the `undefined` arm is meaningful: a
	     `netif` snapshot that has not arrived yet is "we were not told", and the
	     dialog then makes no bond claim at all rather than claiming the link has
	     no address. -->
	<LazyDialog
		dialog={RouterDongleDialog}
		bind:open={dongleDialogOpen}
		deviceId={dongleModemId}
		hasAddress={netif === undefined ? undefined : Boolean(netif[dongleModem.ifname]?.ip)}
		modem={dongleModem}
	/>
{/if}

<!-- SIM unlock — reached ONLY from the locked modem's own row, whose button a
     blocking lock renames to "Unlock SIM". Never auto-opened, and there is no
     second route into it. -->
{#if unlockModem && unlockModemId}
	<LazyDialog
		dialog={SimUnlockDialog}
		bind:open={simUnlockOpen}
		deviceId={unlockModemId}
		modem={unlockModem}
	/>
{/if}
