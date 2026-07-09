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
import { getms } from "../../helpers/time.ts";

import {
	getNetworkInterfaces,
	NETIF_ERR_HOTSPOT,
	setNetifHotspot,
	triggerNetworkInterfacesChange,
} from "../network/network-interfaces.ts";
import {
	type ConnectionUUID,
	type MacAddress,
	nmcliParseSep,
	nmDeviceProp,
	nmDevices,
} from "../network/network-manager.ts";
import { updateBcrptSourceIps } from "../streaming/bcrpt.ts";
import {
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "../system/cli-parse.ts";
import {
	broadcastWifiState,
	type WifiNetwork,
	wifiUpdateSavedConns,
} from "./wifi.ts";
import {
	addWifiInterface,
	getWifiInterfaceByMacAddress,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
	wifiScheduleScanRefresh,
	wifiUpdateScanResult,
} from "./wifi-connections.ts";
import {
	wifiDeviceListGetInetAddress,
	wifiDeviceListGetMacAddress,
} from "./wifi-device-list.ts";
import {
	isHotspot,
	type WifiHotspot,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";

export type SSID = string;
export type WifiInterfaceId = number;

export type BaseWifiInterface = {
	id: WifiInterfaceId; // numeric id for the adapter - temporary for each CeraLive execution
	ifname: string;
	conn: ConnectionUUID | null; // the active connection
	hw: string; // the name of the wifi adapter hardware
	available: Map<SSID, WifiNetwork>;
	saved: Record<SSID, ConnectionUUID>;
	removed?: true;
};

export type WifiInterface = BaseWifiInterface | WifiInterfaceWithHotspot;

export type WifiDeviceProperties = {
	readonly hw: string;
	readonly supportsAp: boolean;
	readonly supports5Ghz: boolean;
	readonly supports2Ghz: boolean;
};

function parseNmcliBoolean(value: string | undefined): boolean | undefined {
	if (value === "yes") return true;
	if (value === "no") return false;
	return undefined;
}

export function parseWifiDeviceProperties(
	prop: readonly string[] | undefined,
): ParseResult<WifiDeviceProperties> {
	if (prop === undefined || prop.length < 5) {
		return parseFail(
			"parseWifiDeviceProperties",
			"expected 5 fields from nmcli device properties",
			JSON.stringify(prop ?? null),
		);
	}

	const [vendorRaw, productRaw, apRaw, fiveGhzRaw, twoGhzRaw] = prop;
	const supportsAp = parseNmcliBoolean(apRaw);
	const supports5Ghz = parseNmcliBoolean(fiveGhzRaw);
	const supports2Ghz = parseNmcliBoolean(twoGhzRaw);
	if (
		supportsAp === undefined ||
		supports5Ghz === undefined ||
		supports2Ghz === undefined
	) {
		return parseFail(
			"parseWifiDeviceProperties",
			"expected yes/no WiFi capability fields",
			JSON.stringify(prop),
		);
	}

	const vendor = (vendorRaw ?? "").replace("Corporation", "").trim();
	const productCandidate =
		productRaw?.match(/[[(](.+)[\])]/)?.[1] ?? productRaw;
	const product = productCandidate?.trim();
	if (!vendor || !product) {
		return parseFail(
			"parseWifiDeviceProperties",
			"missing vendor or product field",
			JSON.stringify(prop),
		);
	}

	return parseOk({
		hw: `${vendor} ${product}`,
		supportsAp,
		supports5Ghz,
		supports2Ghz,
	});
}

let wifiIdToMacAddress: Record<WifiInterfaceId, MacAddress> = {};

export function getWifiIdToMacAddress() {
	return wifiIdToMacAddress;
}

export function getMacAddressForWifiInterface(id: WifiInterfaceId) {
	return wifiIdToMacAddress[id];
}

let unavailableDeviceRetryExpiry = 0;
let wifiIfId = 0;

export async function wifiUpdateDevices() {
	let newDevices = false;
	let statusChange = false;
	let unavailableDevices = false;

	const networkDevices = await nmDevices("device,type,state,con-uuid");
	if (!networkDevices) return;

	// sorts the results alphabetically by interface name
	networkDevices.sort();

	// mark all WiFi adapters as removed
	for (const wifiInterface of Object.values(getWifiInterfacesByMacAddress())) {
		wifiInterface.removed = true;
	}

	// Rebuild the id to mac address map
	wifiIdToMacAddress = {};

	for (const networkDevice of networkDevices) {
		try {
			const [ifname, type, state, connUuid] = nmcliParseSep(networkDevice) as [
				string,
				string,
				string,
				string,
			];

			if (type !== "wifi") continue;
			if (state === "unavailable") {
				unavailableDevices = true;
				continue;
			}

			const conn =
				connUuid !== "" && wifiDeviceListGetInetAddress(ifname)
					? connUuid
					: null;
			const macAddress = wifiDeviceListGetMacAddress(ifname);
			if (!macAddress) continue;

			const wifiInterface = getWifiInterfaceByMacAddress(macAddress);

			if (wifiInterface) {
				// the interface is still available
				delete wifiInterface.removed;

				if (ifname !== wifiInterface.ifname) {
					wifiInterface.ifname = ifname;
					statusChange = true;
				}
				if (conn !== wifiInterface.conn) {
					wifiInterface.conn = conn;
					statusChange = true;
				}
			} else {
				const id = wifiIfId++;

				const parsedProps = parseWifiDeviceProperties(
					await nmDeviceProp(
						ifname,
						"GENERAL.VENDOR,GENERAL.PRODUCT,WIFI-PROPERTIES.AP,WIFI-PROPERTIES.5GHZ,WIFI-PROPERTIES.2GHZ",
					),
				);
				if (!parsedProps.ok) {
					logParseError(parsedProps);
					continue;
				}

				const newInterface = {
					id,
					ifname,
					hw: parsedProps.value.hw,
					conn,
					available: new Map(),
					saved: {},
				};

				if (parsedProps.value.supportsAp) {
					const hotspot: WifiHotspot = {
						warnings: {},
						availableChannels: ["auto"],
					};
					if (parsedProps.value.supports5Ghz) {
						hotspot.availableChannels.push("auto_50");
					}
					if (parsedProps.value.supports2Ghz) {
						hotspot.availableChannels.push("auto_24");
					}
					(newInterface as WifiInterfaceWithHotspot).hotspot = hotspot;
				}
				newDevices = true;
				statusChange = true;
				addWifiInterface(macAddress, newInterface);
			}

			const updatedInterface = getWifiInterfaceByMacAddress(macAddress);
			if (updatedInterface) {
				wifiIdToMacAddress[updatedInterface.id] = macAddress;
			}
		} catch (err) {
			if (err instanceof Error) {
				logger.error(
					`Error getting the nmcli WiFi device information: ${err.message}`,
				);
			}
		}
	}

	// delete removed adapters
	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const i in wifiInterfacesByMacAddress) {
		const wifiInterface = wifiInterfacesByMacAddress[i];
		if (wifiInterface?.removed) {
			removeWifiInterface(i);
			statusChange = true;
		}
	}

	if (newDevices) {
		await wifiUpdateSavedConns();
		wifiScheduleScanRefresh();
	}

	if (statusChange) {
		await wifiUpdateScanResult();
		wifiScheduleScanRefresh();
	}

	if (newDevices || statusChange) {
		broadcastWifiState();

		// Mark any WiFi hotspot interfaces as unavailable for bonding
		let hotspotCount = 0;
		const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
		const networkInterfaces = getNetworkInterfaces();
		for (const i in wifiInterfacesByMacAddress) {
			const wifiInterface = wifiInterfacesByMacAddress[i];
			if (wifiInterface && isHotspot(wifiInterface)) {
				const n = networkInterfaces[wifiInterface.ifname];
				if (!n) continue;
				if (n.error & NETIF_ERR_HOTSPOT) continue;

				setNetifHotspot(n);
				hotspotCount++;
			}
		}

		if (hotspotCount) {
			triggerNetworkInterfacesChange();
			// Remove hotspot IPs from the source IP address list for BCRPT
			void updateBcrptSourceIps();
		}
	}
	logger.debug("Wifi interfaces", wifiInterfacesByMacAddress);

	/* If some wifi adapters were marked unavailable, recheck periodically
     This might happen when the system has just booted up and the adapter
     typically becomes available within 30 seconds.
     Uses a timeout to avoid polling nmcli forever */
	if (unavailableDevices) {
		if (unavailableDeviceRetryExpiry === 0) {
			unavailableDeviceRetryExpiry = getms() + 5 * 60 * 1_000; // 5 minute timeout
			setTimeout(wifiUpdateDevices, 3_000);
			logger.warn(
				"One or more Wifi interfaces are unavailable. Will retry periodically for the next 5 minutes",
			);
		} else if (getms() < unavailableDeviceRetryExpiry) {
			setTimeout(wifiUpdateDevices, 3_000);
			logger.warn(
				"One or more Wifi interfaces are still unavailable. Retrying in 3 seconds...",
			);
		}
	} else {
		unavailableDeviceRetryExpiry = 0;
	}

	return statusChange;
}
