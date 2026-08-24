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
import { m } from '@ceraui/i18n/svelte';
import type { AvailableWifiNetwork, WifiStatus } from '@ceraui/rpc/schemas';
import { TriangleAlert, Wifi } from '@lucide/svelte';
import { untrack } from 'svelte';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { networkConstraints } from '$lib/components/streaming/ValidationAdapter';
import { getWifiUUID, networkRename } from '$lib/helpers/NetworkHelper';
import { isSecured, wifiRowBlock } from '$lib/helpers/wifi-selector';
import {
	deriveWifiDisconnectOutcome,
	deriveWifiForgetOutcome,
} from '$lib/helpers/wifi-outcomes';
import {
	confirmOperation,
	getOperationPhase,
	getOperationReason,
	isOperationPending,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc';
import { getWifi } from '$lib/rpc/subscriptions.svelte';
import { hasScanGenerationAdvanced } from '$lib/rpc/wifi-scan-generation';
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

// THE scan key for this adapter — ONE op for the manual tap AND the periodic
// background refresh, DISTINCT from the connect/disconnect/forget key.
//
// They used to be two keys (`wifi-scan:` and `wifi-scan-auto:`), which is what
// made cross-confirmation possible: two ops watched the same shared evidence
// (the content of `available`), so whichever broadcast landed first resolved
// BOTH, and a periodic tick could clear the operator's manual spinner without
// their scan having finished. With one op there is nothing to cross-confirm,
// and the confirmation is the adapter's own scan generation rather than shared
// content. The two INTENTS are still distinguished — see `scanIntent` — so the
// background poll still never toasts and still never drives the spinner.
const scanKey = $derived(`wifi-scan:${deviceId}`);

// Connect / disconnect / forget share ONE key per interface — the osCommand
// re-entry guard enforces a single WiFi mutation in flight at a time.
const wifiOpKey = $derived(`wifi:${deviceId}`);

// How often the open dialog refreshes the list in the background.
const PERIODIC_SCAN_INTERVAL_MS = 22_000;

// A scan-error surface flag: true when the scan op left the machine in `failed`.
// Extends the list's scanning-vs-empty distinction with a calm failure state. A
// subsequent successful scan re-arms the op and clears it.
const scanError = $derived(getOperationPhase(scanKey) === 'failed');

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

// The device's own TYPED refusal for the last join this surface dispatched.
// Latched locally rather than read off the async-op phase, which decays to
// `idle` after ASYNC_OP_TERMINAL_LINGER_MS — the UpdatesDialog precedent. Before
// this, an `auth` refusal resolved the op and rendered NOTHING, so a wrong
// password was indistinguishable from a join that never happened.
let joinFailure = $state<string | undefined>(undefined);

// Local intent for the two ops that share `wifiOpKey`: which uuid this surface
// dispatched a disconnect / forget for. The shared key can't tell connect from
// disconnect/forget apart, so the confirm $effects below gate on these flags and
// resolve only the matching pure outcome.
let disconnecting = $state<string | undefined>(undefined);
let forgetting = $state<string | undefined>(undefined);

// Which intent the in-flight scan is serving. The op is shared, so this is what
// keeps a background tick from driving the operator's spinner or toasting at
// them. A manual tap arriving while a background tick is in flight PROMOTES it
// rather than dispatching a second scan — the operator's request is exactly what
// that run already delivers.
let scanIntent = $state<'manual' | 'auto' | undefined>(undefined);

// This adapter's scan generation as captured at dispatch. The scan is confirmed
// when the device reports a HIGHER one, so an honest empty result confirms just
// as a fruitful one does. `scanAwaitingGeneration` distinguishes "no scan has
// been dispatched" from "a scan was dispatched against generation undefined".
let scanBaseline = $state<number | undefined>(undefined);
let scanAwaitingGeneration = $state(false);

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
	joinFailure = undefined;
	connecting = ssid;
	await osCommand({
		key: wifiOpKey,
		target: ssid,
		rpc: run,
		failMessage: () => m["network.os.operationFailed"](),
		busyMessage: () => m["network.os.deviceBusy"](),
	});
}

/**
 * Dispatch a scan on THIS adapter's single keyed op, or join the one already in
 * flight. Never a second RPC for the same adapter — the device coalesces them
 * anyway, and a joined caller is served by the run it joined.
 */
async function dispatchScan(intent: 'manual' | 'auto') {
	if (isOperationPending(scanKey)) {
		if (intent === 'manual') scanIntent = 'manual';
		return;
	}
	scanIntent = intent;
	// Capture the baseline BEFORE dispatch, or a generation that advanced while
	// the RPC was in flight would be read as the pre-scan value.
	scanBaseline = iface?.scanGeneration;
	scanAwaitingGeneration = true;
	await osCommand({
		key: scanKey,
		rpc: () => rpc.wifi.scan({ device: deviceId }),
		silent: intent === 'auto',
		busyMessage: () => m["network.os.deviceBusy"](),
		failMessage: () => m["network.os.operationFailed"](),
	});
}

async function handleScan() {
	await dispatchScan('manual');
}

function handleConnectSaved(uuid: string, network: AvailableWifiNetwork) {
	if (ifaceBusy || wifiRowBlock(network, iface?.capabilities)) return;
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
		failMessage: () => m["network.os.operationFailed"](),
		busyMessage: () => m["network.os.deviceBusy"](),
	});
}

/** New (unsaved) network: secured → reveal inline password form; open → connect now. */
function handleConnectNew(network: AvailableWifiNetwork) {
	if (ifaceBusy || wifiRowBlock(network, iface?.capabilities)) return;
	confirmForget = undefined;
	if (isSecured(network)) {
		pendingNew = network;
		password = '';
		showPassword = false;
	} else {
		const ssid = network.ssid;
		const security = network.security;
		void connectVia(ssid, () =>
			rpc.wifi.connectNew({ device: deviceId, ssid, password: '', security }),
		);
	}
}

function submitNew() {
	if (!pendingNew || ifaceBusy) return;
	if (isSecured(pendingNew) && password.length < PASSWORD_MIN) return;
	const ssid = pendingNew.ssid;
	const security = pendingNew.security;
	const pw = password;
	pendingNew = undefined;
	password = '';
	showPassword = false;
	void connectVia(ssid, () =>
		rpc.wifi.connectNew({ device: deviceId, ssid, password: pw, security }),
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
		failMessage: () => m["network.os.operationFailed"](),
		busyMessage: () => m["network.os.deviceBusy"](),
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
		if (phase === 'failed') joinFailure = getOperationReason(wifiOpKey) ?? 'generic';
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

// Confirm the scan when THIS adapter's generation advances — the device's own
// statement that a scan cycle finished, whatever it found. A scan that turns up
// nothing new, or nothing at all, therefore confirms exactly as a fruitful one
// does, and the empty list it publishes is that scan's honest result rather than
// an unresolved spinner.
//
// A device that reports no generation at all confirms nothing, and the absolute
// TTL valve (ASYNC_OP_TTL_MS) then flips the op to timed_out — rendered
// NEUTRALLY as "scan complete", never an error, exactly as before this field
// existed.
$effect(() => {
	if (getOperationPhase(scanKey) !== 'pending') {
		scanIntent = undefined;
		scanAwaitingGeneration = false;
		return;
	}
	if (!scanAwaitingGeneration) return;
	if (hasScanGenerationAdvanced(scanBaseline, iface?.scanGeneration)) {
		confirmOperation(scanKey);
		scanAwaitingGeneration = false;
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

// Initial + periodic silent rescan while the dialog is open. It shares the ONE
// keyed scan op with the manual tap (so cross-confirmation is structurally
// impossible) and is distinguished only by its `auto` intent, which is what
// keeps it out of the spinner and out of the toast: `silent` suppresses the
// toast — a background op never interrupts with one — so a failing tick surfaces
// only through the calm `wifi-scan-error` band (via `scanError`), and the next
// successful tick re-arms and clears it. It confirms on the SAME generation
// advance the manual scan does; it never `confirmOnResolve`s, because the RPC
// resolving says only that nmcli was dispatched.
//
// THE DISPATCH IS `untrack`ed, AND THAT IS THE WHOLE POINT OF THIS EFFECT.
// `osCommand` reads the async-operation store (its re-entry guard,
// `isOperationPending`) and then WRITES it (`beginOperation`), both before its
// first `await` — i.e. synchronously inside this effect body, where Svelte 5
// records every rune read as a dependency. So the effect subscribed to the very
// operation it dispatches: `confirmOnResolve` flipped `pending → confirmed` the
// moment the RPC resolved, the effect re-ran, the (no-longer-pending) guard let
// a NEW scan through, and that scan's `begin` re-dirtied it again. The interval
// was never the cadence — the RPC round-trip was.
//
// Measured on a Rock 5B+ (2026-08-19): with this dialog CLOSED the device runs
// ONE `nmcli` (the `nmcli monitor` supervisor) and holds 31 system-bus names;
// within five seconds of OPENING it, 250-330 concurrent `nmcli device wifi
// rescan` processes were live and root's `max_connections_per_user=256` D-Bus
// limit was exhausted, after which EVERY nmcli on the box — including this
// backend's own `conn down` / `conn del` — failed with `Could not create
// NMClient object`. That is why WiFi disconnect and forget "did nothing": the
// storm runs exactly while the operator has this dialog open to use them.
//
// Do NOT remove the `untrack`, and do NOT call `osCommand` (or anything else
// that writes the op store) from an effect body without one.
$effect(() => {
	if (!open) return;
	const runSilentScan = () =>
		untrack(() => {
			void dispatchScan('auto');
		});
	runSilentScan();
	const id = setInterval(runSilentScan, PERIODIC_SCAN_INTERVAL_MS);
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
		scanAwaitingGeneration = false;
		scanIntent = undefined;
		joinFailure = undefined;
	}
});
</script>

<AppDialog
	bind:open
	contentClass="sm:max-w-xl"
	description={ifaceLabel}
	icon={Wifi}
	title={m["wifiSelector.dialog.availableNetworks"]()}
>
	{#if joinFailure}
		<div
			class="border-status-warning/30 bg-status-warning/10 mb-3 flex items-start gap-2 rounded-lg border px-3 py-2.5"
			data-reason={joinFailure}
			data-testid="wifi-join-failed"
			role="alert"
		>
			<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
			<div class="min-w-0">
				<p class="text-status-warning text-sm font-semibold">
					{joinFailure === 'auth'
						? m["wifiSelector.error.authFailed"]()
						: m["wifiSelector.error.connectionFailed"]()}
				</p>
				<p class="text-muted-foreground mt-0.5 text-xs">
					{joinFailure === 'auth'
						? m["wifiSelector.error.authFailedDescription"]()
						: m["wifiSelector.error.connectionFailedDescription"]()}
				</p>
			</div>
		</div>
	{/if}

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
		{scanError}
		scanning={scanIntent === 'manual' && getOperationPhase(scanKey) === 'pending'}
		bind:password
		bind:showPassword
	/>
</AppDialog>
