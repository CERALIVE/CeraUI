/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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

import { nmRescan, nmScanResults, nmcliParseSep } from "./network-manager.ts";
import { wifiDeviceListGetMacAddress } from "./wifi-device-list.ts";
import type { MacAddress, WifiInterface } from "./wifi-interfaces.ts";
import { wifiBroadcastState } from "./wifi.ts";

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

export async function wifiUpdateScanResult() {
	const wifiNetworks = await nmScanResults(
		"active,ssid,signal,security,freq,device",
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

	wifiBroadcastState();
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
