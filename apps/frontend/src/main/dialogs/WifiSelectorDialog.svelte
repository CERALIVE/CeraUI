<!--
  WifiSelectorDialog.svelte — WiFi scan + connect flow for the Network destination.

  Opened from NetworkView's WiFi "Connect ▸" trigger. Composes on the shared
  AppDialog chrome (desktop Dialog / mobile Sheet) and owns all state + RPC logic;
  the scan bar / network rows / empty state render via WifiNetworkList, and the
  inline secured-network password form via WifiConnectForm (nested by the list).

  Data sources
  ------------
  • Network list: live `WifiStatus` from `$lib/rpc/subscriptions.svelte` (the
    non-deprecated surface) keyed by `deviceId`. Reactive — refreshes as scan
    results arrive.
  • Actions: the canonical `NetworkHelper` wrappers around `rpc.wifi.*`
    (scan / connect / connectNew / disconnect / forget). Those wrappers emit the
    "scanning…/connecting…" action toasts; the subscriptions `wifi` handler emits
    the success / auth-failure result toast, so this component does NOT duplicate
    result toasts — it only drives the inline UI (spinner, close-on-success).

  Validation
  ----------
  New-network password uses the schema-derived minimum
  (`networkConstraints.wifi.password.min`, WIFI_PASSWORD_MIN = 8). Inline error +
  disabled Connect when a secured network's password is shorter than the minimum.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { AvailableWifiNetwork, WifiStatus } from '@ceraui/rpc/schemas';
import { Wifi } from '@lucide/svelte';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { networkConstraints } from '$lib/components/streaming/ValidationAdapter';
import {
	connectToNewWifi,
	connectWifi,
	disconnectWifi,
	forgetWifi,
	getWifiUUID,
	networkRename,
	scanWifi,
} from '$lib/helpers/NetworkHelper';
import { isSecured } from '$lib/helpers/wifi-selector';
import { getWifi } from '$lib/rpc/subscriptions.svelte';

import WifiNetworkList from './WifiNetworkList.svelte';

interface Props {
	open?: boolean;
	/** WifiStatus key (interface device id) this dialog operates on. */
	deviceId: string;
}

let { open = $bindable(false), deviceId }: Props = $props();

// Schema-derived password floor (WIFI_PASSWORD_MIN = 8) — single source of truth.
const PASSWORD_MIN = networkConstraints.wifi.password.min;

// Live interface from the non-deprecated subscriptions surface.
const wifi = $derived<WifiStatus | undefined>(getWifi());
const iface = $derived(wifi?.[deviceId]);
const ifaceLabel = $derived(iface ? networkRename(iface.ifname) : '');

// Interface-level transition (T3 additive wifi schema). 'activating' means a
// connect is already in flight at the NetworkManager layer (DEVICE_BUSY guard) —
// gate every Connect action and surface a busy chip so the operator can't queue
// a conflicting request mid-transition.
const ifaceBusy = $derived(iface?.transition === 'activating');

const sortedNetworks = $derived(
	[...(iface?.available ?? [])].sort((a, b) => {
		if (a.active !== b.active) return a.active ? -1 : 1;
		const aSaved = !!getWifiUUID(a, iface?.saved ?? {});
		const bSaved = !!getWifiUUID(b, iface?.saved ?? {});
		if (aSaved !== bSaved) return aSaved ? -1 : 1;
		return b.signal - a.signal;
	}),
);

// Inline interaction state.
let scanning = $state(false);
let connecting = $state<{ key: string; ssid: string } | undefined>(undefined);
let pendingNew = $state<AvailableWifiNetwork | undefined>(undefined);
let password = $state('');
let showPassword = $state(false);
let confirmForget = $state<string | undefined>(undefined);

let connectTimeout: ReturnType<typeof setTimeout> | undefined;

function resetInteraction() {
	pendingNew = undefined;
	password = '';
	showPassword = false;
	confirmForget = undefined;
}

function beginConnect(key: string, ssid: string) {
	connecting = { key, ssid };
	clearTimeout(connectTimeout);
	// Safety: clear the spinner if no status update resolves the attempt.
	connectTimeout = setTimeout(() => {
		connecting = undefined;
	}, 20000);
}

function handleScan() {
	scanWifi(deviceId);
	scanning = true;
	setTimeout(() => {
		scanning = false;
	}, 20000);
}

function handleConnectSaved(uuid: string, network: AvailableWifiNetwork) {
	if (ifaceBusy) return;
	resetInteraction();
	beginConnect(uuid, network.ssid);
	connectWifi(uuid, network);
}

function handleDisconnect(uuid: string, network: AvailableWifiNetwork) {
	disconnectWifi(uuid, network);
}

/** New (unsaved) network: secured → reveal inline password form; open → connect now. */
function handleConnectNew(network: AvailableWifiNetwork) {
	if (ifaceBusy) return;
	confirmForget = undefined;
	if (isSecured(network)) {
		pendingNew = network;
		password = '';
		showPassword = false;
	} else {
		beginConnect(network.ssid, network.ssid);
		connectToNewWifi(deviceId, network.ssid, '');
	}
}

function submitNew() {
	if (!pendingNew || ifaceBusy) return;
	if (isSecured(pendingNew) && password.length < PASSWORD_MIN) return;
	const ssid = pendingNew.ssid;
	const pw = password;
	pendingNew = undefined;
	password = '';
	showPassword = false;
	beginConnect(ssid, ssid);
	connectToNewWifi(deviceId, ssid, pw);
}

function handleForget(uuid: string, network: AvailableWifiNetwork) {
	confirmForget = undefined;
	forgetWifi(uuid, network);
}

// Resolve the connecting spinner + close the dialog once the target goes active.
$effect(() => {
	const target = connecting;
	if (!target) return;
	const match = (iface?.available ?? []).find((n) => n.ssid === target.ssid);
	if (match?.active) {
		clearTimeout(connectTimeout);
		connecting = undefined;
		resetInteraction();
		open = false;
	}
});

// Initial + periodic silent rescan while the dialog is open.
$effect(() => {
	if (!open) return;
	scanWifi(deviceId, false);
	const id = setInterval(() => scanWifi(deviceId, false), 22000);
	return () => clearInterval(id);
});

// Clear transient inline state whenever the dialog closes.
$effect(() => {
	if (!open) {
		resetInteraction();
		connecting = undefined;
		scanning = false;
		clearTimeout(connectTimeout);
	}
});
</script>

<AppDialog
	bind:open
	contentClass="sm:max-w-xl"
	description={ifaceLabel}
	icon={Wifi}
	title={$LL.wifiSelector.dialog.availableNetworks()}
>
	<WifiNetworkList
		{confirmForget}
		{connecting}
		{iface}
		{ifaceBusy}
		networks={sortedNetworks}
		onConfirmForget={(ssid) => (confirmForget = ssid)}
		onConnectNew={handleConnectNew}
		onConnectSaved={handleConnectSaved}
		onDisconnect={handleDisconnect}
		onForget={handleForget}
		onResetInteraction={resetInteraction}
		onScan={handleScan}
		onSubmitNew={submitNew}
		passwordMin={PASSWORD_MIN}
		{pendingNew}
		{scanning}
		bind:password
		bind:showPassword
	/>
</AppDialog>
