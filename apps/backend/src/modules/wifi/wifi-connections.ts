/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { logger } from "../../helpers/logger.ts";
import { pollWithBackoff } from "../../helpers/retry.ts";
import { createMonitorManager } from "../network/monitor/monitor-manager.ts";
import {
	type MacAddress,
	nmcliParseSep,
	nmRescan,
	nmScanResults,
} from "../network/network-manager.ts";
import type {
	IMonitorEmitter,
	MonitorEvent,
	WifiState,
} from "../network/state-types.ts";
import {
	getModeForInterface,
	onWifiChange,
	setWifiState,
} from "./state/wifi-state.ts";
import { broadcastWifiState, type WifiNetwork } from "./wifi.ts";
import {
	type WifiAdapterLockKey,
	wifiAdapterLockKey,
} from "./wifi-adapter-lock.ts";
import type { WifiInterface, WifiInterfaceId } from "./wifi-interfaces.ts";

const wifiInterfacesByMacAddress: Record<MacAddress, WifiInterface> = {};

export function getWifiInterfaceByMacAddress(macAddress: MacAddress) {
	return wifiInterfacesByMacAddress[macAddress];
}

export function getWifiInterfacesByMacAddress(): Readonly<
	Record<MacAddress, WifiInterface>
> {
	return wifiInterfacesByMacAddress;
}

/**
 * Look an adapter up by interface name. Monitor events carry an ifname, and the
 * registry key is the adapter's PERMANENT hardware address — which the ifconfig
 * poll's operational address does not reliably equal (NetworkManager randomizes
 * it while scanning), so it must not be used to bridge the two.
 */
export function getWifiInterfaceByIfname(
	ifname: string,
): WifiInterface | undefined {
	for (const wifiInterface of Object.values(wifiInterfacesByMacAddress)) {
		if (wifiInterface?.ifname === ifname) return wifiInterface;
	}
	return undefined;
}

export function removeWifiInterface(macAddress: MacAddress) {
	delete wifiInterfacesByMacAddress[macAddress];
}

export function addWifiInterface(
	macAddress: MacAddress,
	wifiInterface: WifiInterface,
) {
	wifiInterfacesByMacAddress[macAddress] = wifiInterface;
}

export function clearWifiInterfacesForTest(): void {
	for (const macAddress of Object.keys(wifiInterfacesByMacAddress)) {
		delete wifiInterfacesByMacAddress[macAddress];
	}
}

// ─── MAC-keyed state cache + diff-driven broadcast (T10/T15) ─────────────────

/*
  Build an immutable MAC-keyed snapshot from the live interface table. The
  `available` Map is COPIED so a later in-place replacement of a network entry
  produces a real diff against the cached snapshot (reconcileWifi compares the
  active SSID / available-SSID set, not object identity).
*/
function buildWifiState(): WifiState {
	const out: WifiState = {};
	for (const macAddress in wifiInterfacesByMacAddress) {
		const wifiInterface = wifiInterfacesByMacAddress[macAddress];
		if (!wifiInterface) continue;
		out[macAddress] = {
			...wifiInterface,
			available: new Map(wifiInterface.available),
			mode: getModeForInterface(wifiInterface),
		};
	}
	return out;
}

// Set by the onWifiChange callback (registered in wifiStateInit) whenever a
// structural diff triggered a broadcast, so the poll path can tell whether it
// still needs to broadcast a signal-only update.
let diffBroadcastFired = false;

/*
  Refresh the MAC-keyed state cache from the live interfaces. `setWifiState`
  fires the registered `onWifiChange` callback only when reconcileWifi detects a
  meaningful change (mode / connection / active SSID / available-SSID set), which
  is where the broadcast originates. Returns whether a diff broadcast fired.
*/
function wifiSyncState(): boolean {
	diffBroadcastFired = false;
	setWifiState(buildWifiState());
	return diffBroadcastFired;
}

/*
  Wire the diff-driven broadcast and the event-driven connection up/down path.
  Called once at startup. The monitor is the real `nmcli monitor` supervisor in
  production, or the scripted mock in dev/test (createMonitorManager decides).
*/
export function wifiStateInit(monitor?: IMonitorEmitter): IMonitorEmitter {
	onWifiChange(() => {
		diffBroadcastFired = true;
		broadcastWifiState();
	});

	const emitter =
		monitor ??
		createMonitorManager(() => {
			// A monitor restart has no historical replay — re-poll authoritative
			// scan results to close the gap.
			void wifiUpdateScanResult();
			wifiScheduleScanRefresh();
		});

	emitter.on("monitor-event", handleWifiMonitorEvent);
	emitter.start();
	return emitter;
}

// ─── event-driven connection up/down (from IMonitorEmitter, T12) ─────────────

/*
  React to a monitor event. Connection activate/deactivate carry the connection
  (SSID) name; device-state carries the ifname. Both are TRIGGERS — we update the
  affected interface's connected state and re-sync the cache (which broadcasts on
  a real diff). Modem events are not our concern here.
*/
export function handleWifiMonitorEvent(event: MonitorEvent): void {
	switch (event.type) {
		case "connection-state":
			handleConnectionStateEvent(event.connection, event.state);
			break;
		case "device-state":
			handleDeviceStateEvent(event.device, event.state);
			break;
		default:
			break;
	}
}

/* Mark the given SSID as the active connection on an interface (immutably). */
function markInterfaceConnected(
	wifiInterface: WifiInterface,
	ssid: string,
): void {
	const uuid = wifiInterface.saved[ssid];
	if (uuid) wifiInterface.conn = uuid;

	for (const [key, network] of wifiInterface.available) {
		wifiInterface.available.set(key, { ...network, active: key === ssid });
	}

	if (!wifiInterface.available.has(ssid)) {
		wifiInterface.available.set(ssid, {
			active: true,
			ssid,
			signal: 0,
			security: "",
			freq: 0,
		});
	}
}

/* Clear the active connection on an interface (immutably). */
function markInterfaceDisconnected(wifiInterface: WifiInterface): void {
	wifiInterface.conn = null;
	for (const [key, network] of wifiInterface.available) {
		if (network.active) {
			wifiInterface.available.set(key, { ...network, active: false });
		}
	}
}

function handleConnectionStateEvent(connection: string, state: string): void {
	const up = state === "activated";
	const down = state === "deactivated";
	if (!up && !down) return;

	let changed = false;
	for (const macAddress in wifiInterfacesByMacAddress) {
		const wifiInterface = wifiInterfacesByMacAddress[macAddress];
		if (!wifiInterface) continue;

		const matches =
			wifiInterface.available.has(connection) ||
			connection in wifiInterface.saved;
		if (!matches) continue;

		if (up) {
			markInterfaceConnected(wifiInterface, connection);
		} else {
			markInterfaceDisconnected(wifiInterface);
		}
		changed = true;
	}

	if (changed) wifiSyncState();
}

function handleDeviceStateEvent(device: string, state: string): void {
	const wifiInterface = getWifiInterfaceByIfname(device);
	if (!wifiInterface) return;

	if (state === "disconnected" || state === "unavailable") {
		markInterfaceDisconnected(wifiInterface);
		wifiSyncState();
		return;
	}

	if (state === "connected") {
		// device-state alone lacks the SSID — re-poll authoritative scan results.
		wifiScheduleScanRefresh();
	}
}

// ─── scan-result polling (RETAINED — scan + signal strength) ─────────────────

type ParsedWifiScanRow = {
	active: boolean;
	bssid: string;
	ssid: string;
	signal: number;
	security: string;
	chan: number;
};

// Parse one nmcli `device wifi list` terse row. A malformed row would otherwise
// store NaN signal/chan — a wrong value silently broadcast to the UI; instead we
// log the raw row and return null (a typed "no result") so callers skip it.
// Format: IN-USE:BSSID:SSID:MODE:CHAN:RATE:SIGNAL:BARS:SECURITY
export function parseWifiScanRow(raw: string): ParsedWifiScanRow | null {
	const [active, bssid, ssid, _mode, chan, _rate, signal, _bars, security] =
		nmcliParseSep(raw) as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];

	// An empty SSID is a hidden network, not a parse failure — skip it quietly.
	if (ssid == null || ssid === "") return null;

	const signalValue = Number.parseInt(signal ?? "", 10);
	const chanValue = Number.parseInt(chan ?? "", 10);
	if (Number.isNaN(signalValue) || Number.isNaN(chanValue)) {
		logger.warn(
			`wifiUpdateScanResult: skipping unparseable nmcli scan row: ${JSON.stringify(raw)}`,
		);
		return null;
	}

	return {
		active: active === "*",
		bssid: bssid ?? "",
		ssid,
		signal: signalValue,
		security: security ?? "",
		chan: chanValue,
	};
}

export async function wifiUpdateScanResult(): Promise<boolean> {
	// Retry transient nmcli scan/list failures with exponential backoff (T7).
	const wifiNetworks = await pollWithBackoff(
		() =>
			nmScanResults("IN-USE,BSSID,SSID,MODE,CHAN,RATE,SIGNAL,BARS,SECURITY"),
		{
			maxAttempts: 3,
			baseDelayMs: 200,
			maxDelayMs: 1000,
			emptyResultError: () => new Error("nmcli wifi list returned no results"),
			onExhausted: (err) =>
				logger.debug(`wifiUpdateScanResult: scan failed after retries: ${err}`),
		},
	);
	/*
	  `undefined` is a failed READ, never an empty result: `nmScanResults` splits
	  a successful empty answer into `[""]`, so a genuinely empty scan reaches the
	  clear-and-refill below and honestly blanks the lists. A failed read must NOT
	  — blanking on a transient nmcli failure would report every network as gone.
	*/
	if (!wifiNetworks) return false;

	for (const wifiInterface of Object.values(wifiInterfacesByMacAddress)) {
		wifiInterface.available = new Map();
	}

	for (const wifiNetwork of wifiNetworks) {
		const parsed = parseWifiScanRow(wifiNetwork);
		if (!parsed) continue;
		const { active, ssid, signal, security, chan } = parsed;

		// All wifi interfaces see the same scan results. Add this network to every
		// interface; the active flag indicates which interface is connected.
		for (const wifiInterface of Object.values(wifiInterfacesByMacAddress)) {
			if (!wifiInterface || (!active && wifiInterface.available.has(ssid)))
				continue;

			wifiInterface.available.set(ssid, {
				active,
				ssid,
				signal,
				security,
				freq: chan,
			} satisfies WifiNetwork);
		}
	}

	// Update the cache and broadcast from the diff. Signal-only fluctuations do
	// not trip reconcileWifi, so broadcast directly when nothing structural
	// changed (preserves the original per-poll signal-strength broadcast).
	if (!wifiSyncState()) {
		broadcastWifiState();
	}
	return true;
}

// ─── debounced scan refresh (HARD CUTOVER from the 6-timer schedule) ─────────

/*
  WiFi scan results settle some time after a rescan is issued / a new adapter is
  plugged in. Instead of fanning out a fixed cascade of timers, we DEBOUNCE a
  single refresh: each new rescan cancels the pending timer and re-arms it, so
  repeated rescans collapse to exactly one scan after the quiet window.
*/
export const WIFI_SCAN_REFRESH_DEBOUNCE_MS = 3000;

let scanRefreshTimer: ReturnType<typeof setTimeout> | null = null;
// The action run when the debounce fires. Overridable in tests to observe
// execution deterministically without spawning nmcli.
let scanRefreshAction: () => unknown = wifiUpdateScanResult;

export function wifiScheduleScanRefresh(): void {
	if (scanRefreshTimer !== null) {
		clearTimeout(scanRefreshTimer);
	}
	scanRefreshTimer = setTimeout(() => {
		scanRefreshTimer = null;
		void scanRefreshAction();
	}, WIFI_SCAN_REFRESH_DEBOUNCE_MS);
}

/** Number of pending debounce timers (0 or 1). Test introspection. */
export function wifiPendingScanRefreshCount(): number {
	return scanRefreshTimer === null ? 0 : 1;
}

/** Cancel any pending debounced scan refresh. */
export function wifiCancelScanRefresh(): void {
	if (scanRefreshTimer !== null) {
		clearTimeout(scanRefreshTimer);
		scanRefreshTimer = null;
	}
}

/** Test seam: override the action run when the debounce timer fires. */
export function setScanRefreshAction(action: () => unknown): void {
	scanRefreshAction = action;
}

/*
  A rescan spawns `nmcli device wifi rescan`, and every nmcli process opens its
  own connection to the SYSTEM D-Bus. `wifi.scan` is an RPC any client may issue
  as fast as it likes, so an unguarded `wifiRescan` lets a caller spawn nmcli
  without bound — and root's `max_connections_per_user` (256 by default) is a
  DEVICE-WIDE resource, not this module's. Once it is exhausted, every nmcli on
  the box fails `Could not create NMClient object`, which takes down WiFi
  connect / disconnect / forget, the gateway election and the modem profile
  writes with it. Measured on a Rock 5B+ (2026-08-19): 250-330 concurrent
  `nmcli device wifi rescan` processes and a bus so saturated `busctl` itself
  could not list names.

  The client that produced that storm has been fixed (CeraUI's own WiFi dialog
  re-triggered its own periodic scan on every RPC round-trip), but the guard
  stays: a device must not be knockable over by a repeated read RPC, whoever
  sends it. Concurrent callers JOIN the in-flight run rather than yielding —
  their intent ("refresh the scan results") is exactly what that run delivers,
  so joining serves them without a second spawn. Same discipline as
  `signalRecheckInFlight` in `modules/streaming/sources.ts`.

  THE GUARD IS PER ADAPTER, NOT PER DEVICE. It used to be one process-wide
  promise, so a board with two radios scanned ONE of them: the second adapter's
  caller joined the first adapter's run, which had already dispatched
  `nmcli device wifi rescan ifname <the other radio>`, and came back "served" by
  a scan its own radio never performed. Two radios are two independent pieces of
  hardware — the bus pressure this guard exists to bound is per nmcli process,
  and two of them is two, not two hundred. So the map is keyed on the SAME
  canonical per-adapter identity every WiFi mutation serializes on
  (`wifiAdapterLockKey`, the adapter's permanent MAC), and one key's in-flight
  run can never answer for another's.
*/
const rescanInFlight = new Map<WifiScanKey, Promise<void>>();

/*
  The key a device-LESS `wifiRescan()` coalesces on: "refresh every radio". A
  MAC can never normalize to it, and neither can a wire device id, so it cannot
  collide with a real adapter's key. Its completion stamps EVERY known adapter,
  because that is what it actually refreshed.
*/
const WIFI_SCAN_ALL_KEY = "*";

/** The identity a scan is coalesced and stamped on. */
export type WifiScanKey = WifiAdapterLockKey;

export type WifiScanStamp = {
	/** Strictly increasing per adapter; stamped only by a COMPLETED scan cycle. */
	readonly generation: number;
	/** Epoch ms of that completion. Diagnostic — never the confirmation signal. */
	readonly at: number;
};

const scanStamps = new Map<WifiScanKey, WifiScanStamp>();

/*
  Resolve the wire device id to the adapter's canonical key.

  The canonical answer is `wifiAdapterLockKey` over the adapter's permanent MAC —
  the same string `wifiInterfacesByMacAddress` is keyed on and the same one every
  WiFi mutation locks on, so a scan and a mutation can never disagree about which
  radio they are talking about.

  An id no adapter answers to falls back to the wire id itself. That is NOT a
  second identity scheme: it is the only identity such a caller has, and losing
  coalescing entirely for an unresolvable adapter would reopen the spawn storm
  this guard exists to close. It is also what keeps the mock scenarios — which
  serve radios from a fixture and populate no registry — coalescing and stamping
  like a real board.
*/
export function wifiScanKeyForDevice(device: WifiInterfaceId): WifiScanKey {
	for (const macAddress in wifiInterfacesByMacAddress) {
		if (wifiInterfacesByMacAddress[macAddress]?.id === device) {
			return wifiAdapterLockKey(macAddress);
		}
	}
	return `dev:${device}`;
}

function ifnameForDevice(device: WifiInterfaceId): string | undefined {
	for (const macAddress in wifiInterfacesByMacAddress) {
		const wifiInterface = wifiInterfacesByMacAddress[macAddress];
		if (wifiInterface?.id === device) return wifiInterface.ifname;
	}
	return undefined;
}

/** The last completed scan cycle for `device`, or `undefined` if it has none. */
export function getWifiScanStampForDevice(
	device: WifiInterfaceId,
): WifiScanStamp | undefined {
	return scanStamps.get(wifiScanKeyForDevice(device));
}

/*
  Advance the adapter's scan generation. This is the ONLY writer, and it runs
  only when a scan cycle actually completed — so an EMPTY result advances it
  (the operator's scan finished and found nothing, which is an answer) while a
  failed nmcli read does not (nothing finished, and the previous list stands).
*/
function noteScanCompleted(key: WifiScanKey): void {
	if (key === WIFI_SCAN_ALL_KEY) {
		for (const macAddress in wifiInterfacesByMacAddress) {
			noteScanCompleted(wifiAdapterLockKey(macAddress));
		}
		return;
	}
	scanStamps.set(key, {
		generation: (scanStamps.get(key)?.generation ?? 0) + 1,
		at: Date.now(),
	});
}

/** Test seam: drop every recorded scan generation. */
export function resetWifiScanStampsForTest(): void {
	scanStamps.clear();
}

/* Mirrors `setScanRefreshAction`: lets a test count spawns without an nmcli. */
let rescanAction: (device?: string) => Promise<unknown> = nmRescan;

export function setRescanActionForTest(
	action: (device?: string) => Promise<unknown>,
): void {
	rescanAction = action;
}

/*
  The READ half of a scan cycle, behind its own seam for the same reason
  `rescanAction` is: it decides whether the generation advances, and driving that
  decision in a test must not depend on an nmcli the host does not have.
*/
let scanResultReader: () => Promise<boolean> = wifiUpdateScanResult;

export function setScanResultReaderForTest(
	reader: () => Promise<boolean>,
): void {
	scanResultReader = reader;
}

/**
 * Rescan `device`'s radio, or every radio when no device is named.
 *
 * Concurrent callers for the SAME adapter join one run; callers for DIFFERENT
 * adapters each get their own, because a scan of one radio says nothing about
 * another.
 */
export function wifiRescan(device?: WifiInterfaceId): Promise<void> {
	const key =
		device === undefined ? WIFI_SCAN_ALL_KEY : wifiScanKeyForDevice(device);

	const joined = rescanInFlight.get(key);
	if (joined) return joined;

	const ifname = device === undefined ? undefined : ifnameForDevice(device);
	const run = runRescan(key, ifname).finally(() => {
		rescanInFlight.delete(key);
	});
	rescanInFlight.set(key, run);
	return run;
}

async function runRescan(
	key: WifiScanKey,
	ifname: string | undefined,
): Promise<void> {
	try {
		await rescanAction(ifname);

		/* A rescan request will fail if a previous one is in progress,
     but we still attempt to update the results */
		if (await scanResultReader()) noteScanCompleted(key);
		wifiScheduleScanRefresh();
	} catch (err) {
		// A shared promise must not reject: every joined caller would raise its own
		// unhandled rejection for one failed scan. Both collaborators already
		// degrade internally (nmRescan catches, wifiUpdateScanResult retries then
		// returns), so reaching here is drift worth logging, never worth throwing.
		logger.warn(`wifiRescan failed: ${err}`);
	}
}
