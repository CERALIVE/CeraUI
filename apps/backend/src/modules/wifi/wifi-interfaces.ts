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
	nmConnGetFields,
	nmcliParseSep,
	nmDeviceProp,
	nmDevices,
} from "../network/network-manager.ts";
import {
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "../system/cli-parse.ts";
import { getDerivedApChannels, refreshHotspotChannels } from "./regdomain.ts";
import {
	broadcastWifiState,
	type WifiNetwork,
	wifiUpdateSavedConns,
} from "./wifi.ts";
import { refreshWifiCapabilities } from "./wifi-capabilities.ts";
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
import { handleHotspotConn } from "./wifi-hotspot-discovery.ts";
import {
	canHotspot,
	isApMode,
	type WifiHotspot,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import {
	resolveWifiPermanentMac,
	retainWifiPermanentMacs,
} from "./wifi-permanent-mac.ts";

export type SSID = string;
export type WifiInterfaceId = number;

export type WifiActiveMode = "ap" | "infrastructure" | "unknown";

export type BaseWifiInterface = {
	id: WifiInterfaceId; // numeric id for the adapter - temporary for each CeraLive execution
	ifname: string;
	conn: ConnectionUUID | null; // the active connection, gated on the radio holding an IP
	/*
	  NM's active connection WITHOUT the `conn` IP gate. The gate is right for
	  bonding (a client link with no lease is unusable) but must never decide
	  AP-vs-client: a hotspot whose IP the ifconfig poll had not yet cached
	  collapsed to "station", rendering a broadcasting radio as
	  "Connected · <ssid>" with Connect/In-Bond controls one tick and
	  "Disconnected" the next.
	*/
	activeConn?: ConnectionUUID | null;
	activeMode?: WifiActiveMode;
	hw: string; // the name of the wifi adapter hardware
	available: Map<SSID, WifiNetwork>;
	saved: Record<SSID, ConnectionUUID>;
	/*
	  EVERY profile this adapter has for an SSID, not just the one `saved` names.
	  NetworkManager happily holds several — a CeraUI-created profile plus one an
	  image baked in, or two an operator made under different names — and `saved`
	  is keyed by SSID, so it can only ever surface ONE of them.

	  That is invisible until Forget: the operator forgets the network, exactly
	  one profile is deleted, the sibling keeps the SSID in this map, and the row
	  still reads "Saved". Board-observed on a Rock 5B+ (2026-08-19), where
	  `4G-UFI-611A` and `ufi-recovery` were two NM profiles for the ONE SSID
	  `4G-UFI-611A`: the delete succeeded and the UI was indistinguishable from a
	  Forget that had done nothing.

	  It stays OFF the wire. The frontend acts on one uuid and the schema is
	  unchanged; only `wifiForget` reads this, because only Forget means "remove
	  this network", where connect/disconnect mean "act on this connection".
	*/
	savedAll: Record<SSID, ConnectionUUID[]>;
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

const connectionModeCache = new Map<ConnectionUUID, WifiActiveMode>();

export function resetWifiConnectionModeCache() {
	connectionModeCache.clear();
}

export function parseWifiConnectionMode(
	raw: string | undefined,
): WifiActiveMode {
	if (raw === "ap") return "ap";
	if (raw === "infrastructure") return "infrastructure";
	return "unknown";
}

// An `unknown` result is NOT cached: it means the nmcli read failed, and caching
// it would permanently pin an AP radio to the client-mode UI.
async function resolveConnectionMode(
	uuid: ConnectionUUID,
): Promise<WifiActiveMode> {
	const cached = connectionModeCache.get(uuid);
	if (cached !== undefined) return cached;

	const fields = await nmConnGetFields(uuid, ["802-11-wireless.mode"] as const);
	const mode = parseWifiConnectionMode(fields?.[0]);
	if (mode !== "unknown") connectionModeCache.set(uuid, mode);
	return mode;
}

async function syncActiveConnection(
	wifiInterface: WifiInterface,
	macAddress: MacAddress,
	activeConn: ConnectionUUID | null,
): Promise<boolean> {
	const previousConn = wifiInterface.activeConn ?? null;
	const previousMode = wifiInterface.activeMode;

	if (activeConn === null) {
		wifiInterface.activeConn = null;
		delete wifiInterface.activeMode;
		return previousConn !== null || previousMode !== undefined;
	}

	const mode = await resolveConnectionMode(activeConn);
	wifiInterface.activeConn = activeConn;
	wifiInterface.activeMode = mode;

	// NM is the authority on AP mode, so adopt the AP profile as this radio's
	// hotspot connection here rather than waiting on the saved-connection sweep
	// (which only runs when a NEW adapter appears).
	if (
		mode === "ap" &&
		canHotspot(wifiInterface) &&
		wifiInterface.hotspot.conn !== activeConn
	) {
		await handleHotspotConn(macAddress, activeConn, { active: true });
	}

	return previousConn !== activeConn || previousMode !== mode;
}

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
	const seenIfnames: string[] = [];

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

			const activeConn: ConnectionUUID | null =
				connUuid !== "" ? connUuid : null;
			const conn =
				activeConn !== null && wifiDeviceListGetInetAddress(ifname)
					? activeConn
					: null;
			const currentMac = wifiDeviceListGetMacAddress(ifname);
			if (!currentMac) continue;

			/*
			  Adapters are keyed by their PERMANENT hardware address, never the
			  operational one the ifconfig poll reports: NetworkManager randomizes
			  that while scanning, and a re-keyed registry silently discards the
			  adapter's adopted hotspot profile, saved-connection map and id.
			*/
			seenIfnames.push(ifname);
			const macAddress = await resolveWifiPermanentMac(ifname, currentMac);

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
					savedAll: {},
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
					// Fold in the concrete channels the kernel currently permits.
					refreshHotspotChannels(hotspot, getDerivedApChannels());
					(newInterface as WifiInterfaceWithHotspot).hotspot = hotspot;
				}
				newDevices = true;
				statusChange = true;
				addWifiInterface(macAddress, newInterface);
			}

			const updatedInterface = getWifiInterfaceByMacAddress(macAddress);
			if (updatedInterface) {
				wifiIdToMacAddress[updatedInterface.id] = macAddress;
				if (
					await syncActiveConnection(updatedInterface, macAddress, activeConn)
				) {
					statusChange = true;
				}
			}
		} catch (err) {
			if (err instanceof Error) {
				logger.error(
					`Error getting the nmcli WiFi device information: ${err.message}`,
				);
			}
		}
	}

	retainWifiPermanentMacs(seenIfnames);
	// Fire-and-forget: the capability read is bounded and never throws, and the
	// wire builder serves whatever the last successful read produced.
	void refreshWifiCapabilities(seenIfnames);

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
			if (wifiInterface && isApMode(wifiInterface)) {
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
