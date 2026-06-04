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
import { type WifiNetwork, broadcastWifiState } from "./wifi.ts";
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

export async function wifiUpdateScanResult() {
	// Retry transient nmcli scan/list failures with exponential backoff (T7).
	const wifiNetworks = await pollWithBackoff(
		() => nmScanResults("active,ssid,signal,security,freq,device"),
		{
			maxAttempts: 3,
			baseDelayMs: 200,
			maxDelayMs: 1000,
			emptyResultError: () =>
				new Error("nmcli wifi list returned no results"),
			onExhausted: (err) =>
				logger.debug(`wifiUpdateScanResult: scan failed after retries: ${err}`),
		},
	);
	if (!wifiNetworks) return;

	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const wifiInterface of Object.values(wifiInterfacesByMacAddress)) {
		wifiInterface.available = new Map();
	}

	for (const wifiNetwork of wifiNetworks) {
		const [active, ssid, signal, security, freq, device] = nmcliParseSep(
			wifiNetwork,
		) as [string, string, string, string, string, string];

		if (ssid == null || ssid === "") continue;

		const macAddress = wifiDeviceListGetMacAddress(device);
		if (!macAddress) continue;

		const wifiInterface = wifiInterfacesByMacAddress[macAddress];
		if (
			!wifiInterface ||
			(active !== "yes" && wifiInterface.available.has(ssid))
		)
			continue;

		wifiInterface.available.set(ssid, {
			active: active === "yes",
			ssid,
			signal: Number.parseInt(signal, 10),
			security,
			freq: Number.parseInt(freq, 10),
		});
	}

	// Update the cache and broadcast from the diff. Signal-only fluctuations do
	// not trip reconcileWifi, so broadcast directly when nothing structural
	// changed (preserves the original per-poll signal-strength broadcast).
	if (!wifiSyncState()) {
		broadcastWifiState();
	}
}

/*
  The WiFi scan results are updated some time after a rescan command is issued /
  some time after a new WiFi adapter is plugged in.
  This function sets up a number of timers to broadcast the updated scan results
  with the expectation that eventually it will capture any relevant new results
*/
const pendingScanUpdates: Array<ReturnType<typeof setTimeout>> = [];

export function wifiScheduleScanUpdates() {
	for (const timer of pendingScanUpdates) {
		clearTimeout(timer);
	}

	pendingScanUpdates.push(setTimeout(wifiUpdateScanResult, 1000));
	pendingScanUpdates.push(setTimeout(wifiUpdateScanResult, 3000));
	pendingScanUpdates.push(setTimeout(wifiUpdateScanResult, 5000));
	pendingScanUpdates.push(setTimeout(wifiUpdateScanResult, 10000));
	pendingScanUpdates.push(setTimeout(wifiUpdateScanResult, 15000));
	pendingScanUpdates.push(setTimeout(wifiUpdateScanResult, 20000));
}

export async function wifiRescan() {
	await nmRescan();

	/* A rescan request will fail if a previous one is in progress,
     but we still attempt to update the results */
	await wifiUpdateScanResult();
	wifiScheduleScanUpdates();
}
