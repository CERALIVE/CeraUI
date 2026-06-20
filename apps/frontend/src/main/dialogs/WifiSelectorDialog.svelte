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
  • Actions: scan / connect / connectNew / disconnect / forget all dispatch via
    the keyed `osCommand` state machine (raw `rpc.wifi.*` calls). `osCommand` owns
    the single failure-feedback path; the subscriptions `wifi` handler routes the
    broadcast result into the op store. This component drives the inline UI only
    (phase-based spinner, calm `timed_out` Retry, close-on-confirm).

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
import { getWifiUUID, networkRename } from '$lib/helpers/NetworkHelper';
import { isSecured } from '$lib/helpers/wifi-selector';
import {
	deriveWifiDisconnectOutcome,
	deriveWifiForgetOutcome,
} from '$lib/helpers/wifi-outcomes';
import {
	confirmOperation,
	getOperationPhase,
	isOperationPending,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc';
import { getWifi } from '$lib/rpc/subscriptions.svelte';
import { wifiScanSignature } from '$lib/rpc/wifi-scan-signature';
import { deriveWifiConnectOutcome } from '$lib/rpc/wifi-connect-outcome';

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

// Scan key — DISTINCT from the connect/disconnect/forget key. The scan op is
// tracked through the keyed async-operation state machine; its `pending` phase
// drives the spinner and its content-signature confirm resolves it.
const scanKey = $derived(`wifi-scan:${deviceId}`);

// Connect / disconnect / forget share ONE key per interface — the osCommand
// re-entry guard enforces a single WiFi mutation in flight at a time.
const wifiOpKey = $derived(`wifi:${deviceId}`);

// Inline interaction state.
// `connecting` is the local intent for the third op sharing `wifiOpKey`: the SSID
// this surface is connecting to. Kept set through `timed_out` so the row can
// render the calm "still connecting / Retry" affordance; cleared on confirm
// (close), hard fail, or idle decay.
let connecting = $state<string | undefined>(undefined);
let pendingNew = $state<AvailableWifiNetwork | undefined>(undefined);
let password = $state('');
let showPassword = $state(false);
let confirmForget = $state<string | undefined>(undefined);

// Local intent for the two ops that share `wifiOpKey`: which uuid this surface
// dispatched a disconnect / forget for. The shared key can't tell connect from
// disconnect/forget apart, so the confirm $effects below gate on these flags and
// resolve only the matching pure outcome.
let disconnecting = $state<string | undefined>(undefined);
let forgetting = $state<string | undefined>(undefined);

// Signature of the available-network set captured at scan dispatch. A later
// broadcast whose signature differs confirms the scan (new/removed AP).
let scanBaseline = $state<string | undefined>(undefined);

function resetInteraction() {
	pendingNew = undefined;
	password = '';
	showPassword = false;
	confirmForget = undefined;
}

// Dispatch a connect (saved or new) through the shared keyed op. The subscriptions
// `wifi` handler resolves the op on the broadcast result; the connect-confirm
// $effect below adds a snapshot-based secondary confirm and owns close-on-success.
async function connectVia(ssid: string, run: () => Promise<unknown>) {
	if (ifaceBusy || isOperationPending(wifiOpKey)) return;
	connecting = ssid;
	await osCommand({
		key: wifiOpKey,
		target: ssid,
		rpc: run,
		failMessage: () => $LL.network.os.operationFailed(),
		busyMessage: () => $LL.network.os.deviceBusy(),
	});
}

async function handleScan() {
	// Capture the baseline BEFORE dispatch so a fresh result is detectable.
	scanBaseline = wifiScanSignature(iface?.available ?? []);
	await osCommand({
		key: scanKey,
		rpc: () => rpc.wifi.scan({ device: deviceId }),
		busyMessage: () => $LL.network.os.deviceBusy(),
		failMessage: () => $LL.network.os.operationFailed(),
	});
}

function handleConnectSaved(uuid: string, network: AvailableWifiNetwork) {
	if (ifaceBusy) return;
	resetInteraction();
	void connectVia(network.ssid, () => rpc.wifi.connect({ uuid }));
}

async function handleDisconnect(uuid: string, network: AvailableWifiNetwork) {
	if (isOperationPending(wifiOpKey)) return;
	disconnecting = uuid;
	await osCommand({
		key: wifiOpKey,
		target: network.ssid,
		rpc: () => rpc.wifi.disconnect({ uuid }),
		failMessage: () => $LL.network.os.operationFailed(),
		busyMessage: () => $LL.network.os.deviceBusy(),
	});
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
		const ssid = network.ssid;
		void connectVia(ssid, () =>
			rpc.wifi.connectNew({ device: deviceId, ssid, password: '' }),
		);
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
	void connectVia(ssid, () =>
		rpc.wifi.connectNew({ device: deviceId, ssid, password: pw }),
	);
}

async function handleForget(uuid: string, network: AvailableWifiNetwork) {
	confirmForget = undefined;
	if (isOperationPending(wifiOpKey)) return;
	forgetting = uuid;
	await osCommand({
		key: wifiOpKey,
		target: network.ssid,
		rpc: () => rpc.wifi.forget({ uuid }),
		failMessage: () => $LL.network.os.operationFailed(),
		busyMessage: () => $LL.network.os.deviceBusy(),
	});
}

// Connect confirm: the subscriptions `wifi` handler routes the broadcast result
// into `wifiOpKey`; this effect adds a snapshot-based SECONDARY confirm (the
// target SSID showing active) and owns close-on-success. The `connecting` intent
// is kept through `timed_out` so the row renders the calm Retry affordance — it
// is cleared only on confirm (close), hard fail, or idle decay.
$effect(() => {
	const ssid = connecting;
	if (!ssid) return;
	const phase = getOperationPhase(wifiOpKey);
	if (phase === 'confirmed') {
		connecting = undefined;
		resetInteraction();
		open = false;
		return;
	}
	if (phase === 'failed' || phase === 'idle') {
		connecting = undefined;
		return;
	}
	if (
		phase === 'pending' &&
		deriveWifiConnectOutcome({}, deviceId, ssid, iface?.available ?? []) === 'confirmed'
	) {
		confirmOperation(wifiOpKey);
	}
});

// Confirm a manual scan when its content signature changes (a new/removed AP),
// NOT on a mere getWifi() reference change — a periodic full-state re-broadcast
// re-references the same set and must not clear the spinner. An environment that
// yields no new networks legitimately produces no change: the absolute TTL valve
// (ASYNC_OP_TTL_MS) then flips the op to timed_out, rendered NEUTRALLY as "scan
// complete", never an error.
$effect(() => {
	if (getOperationPhase(scanKey) !== 'pending') return;
	const currentSig = wifiScanSignature(iface?.available ?? []);
	if (scanBaseline !== undefined && currentSig !== scanBaseline) {
		confirmOperation(scanKey);
		scanBaseline = undefined;
	}
});

// Confirm an in-flight disconnect once the snapshot shows the iface dropped the
// target connection, or release the intent if the op already left `pending`
// (failure / TTL). Gated by the local `disconnecting` intent so the shared
// wifiOpKey is never confirmed for a connect/forget op.
$effect(() => {
	const uuid = disconnecting;
	if (!uuid) return;
	if (getOperationPhase(wifiOpKey) !== 'pending') {
		disconnecting = undefined;
		return;
	}
	if (deriveWifiDisconnectOutcome(iface, uuid) === 'confirmed') {
		confirmOperation(wifiOpKey);
		disconnecting = undefined;
	}
});

// Confirm an in-flight forget once the uuid leaves the saved map, or release the
// intent if the op already left `pending`. Same shared-key guard as disconnect.
$effect(() => {
	const uuid = forgetting;
	if (!uuid) return;
	if (getOperationPhase(wifiOpKey) !== 'pending') {
		forgetting = undefined;
		return;
	}
	if (deriveWifiForgetOutcome(iface?.saved, uuid) === 'confirmed') {
		confirmOperation(wifiOpKey);
		forgetting = undefined;
	}
});

// Initial + periodic silent rescan while the dialog is open. This is a passive
// query-style refresh (no spinner, no toast) — it deliberately does NOT route
// through `osCommand`, which is reserved for the user-initiated scan (`handleScan`,
// keyed on `scanKey`). A fire-and-forget raw `rpc.wifi.scan` keeps the two apart.
$effect(() => {
	if (!open) return;
	void rpc.wifi.scan({ device: deviceId });
	const id = setInterval(() => void rpc.wifi.scan({ device: deviceId }), 22000);
	return () => clearInterval(id);
});

// Clear transient inline state whenever the dialog closes.
$effect(() => {
	if (!open) {
		resetInteraction();
		connecting = undefined;
		disconnecting = undefined;
		forgetting = undefined;
		scanBaseline = undefined;
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
		{deviceId}
		{disconnecting}
		{forgetting}
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
		scanning={getOperationPhase(scanKey) === 'pending'}
		bind:password
		bind:showPassword
	/>
</AppDialog>
