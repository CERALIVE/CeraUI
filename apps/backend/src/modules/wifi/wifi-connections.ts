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
import { wifiDeviceListGetMacAddress } from "./wifi-device-list.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";

const wifiInterfacesByMacAddress: Record<MacAddress, WifiInterface> = {};

export function getWifiInterfaceByMacAddress(macAddress: MacAddress) {
	return wifiInterfacesByMacAddress[macAddress];
}

export function getWifiInterfacesByMacAddress(): Readonly<
	Record<MacAddress, WifiInterface>
> {
	return wifiInterfacesByMacAddress;
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
	const macAddress = wifiDeviceListGetMacAddress(device);
	if (!macAddress) return;

	const wifiInterface = wifiInterfacesByMacAddress[macAddress];
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

export async function wifiUpdateScanResult() {
	// Retry transient nmcli scan/list failures with exponential backoff (T7).
	const wifiNetworks = await pollWithBackoff(
		() => nmScanResults(),
		{
			maxAttempts: 3,
			baseDelayMs: 200,
			maxDelayMs: 1000,
			emptyResultError: () => new Error("nmcli wifi list returned no results"),
			onExhausted: (err) =>
				logger.debug(`wifiUpdateScanResult: scan failed after retries: ${err}`),
		},
	);
	if (!wifiNetworks) return;

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
let scanRefreshAction: () => void | Promise<void> = wifiUpdateScanResult;

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
export function setScanRefreshAction(action: () => void | Promise<void>): void {
	scanRefreshAction = action;
}

export async function wifiRescan() {
	await nmRescan();

	/* A rescan request will fail if a previous one is in progress,
     but we still attempt to update the results */
	await wifiUpdateScanResult();
	wifiScheduleScanRefresh();
}
