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

import type { HotspotInfo } from "@ceraui/rpc/schemas";

import { nmConnGetFields } from "../network/network-manager.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import { isHotspot } from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";

const NM_DEFAULT_HOTSPOT_GATEWAY = "10.42.0.1";

export function parseGatewayIp(raw: string | undefined): string {
	const ip = raw?.split("/")[0]?.trim() ?? "";
	return ip === "" ? NM_DEFAULT_HOTSPOT_GATEWAY : ip;
}

export type HotspotInfoDeps = {
	interfaces: () => Readonly<Record<string, WifiInterface>>;
	getConnIpv4Address: (uuid: string) => Promise<string | undefined>;
};

export const defaultHotspotInfoDeps: HotspotInfoDeps = {
	interfaces: () => getWifiInterfacesByMacAddress(),
	getConnIpv4Address: async (uuid) => {
		const fields = await nmConnGetFields(uuid, ["ipv4.addresses"] as const);
		return fields?.[0];
	},
};

export async function resolveHotspotInfo(
	deps: HotspotInfoDeps,
): Promise<HotspotInfo> {
	const interfaces = deps.interfaces();
	for (const mac in interfaces) {
		const wifiInterface = interfaces[mac];
		if (!wifiInterface || !isHotspot(wifiInterface)) continue;

		const conn = wifiInterface.hotspot.conn;
		if (!conn) continue;

		const raw = await deps.getConnIpv4Address(conn);
		return {
			ssid: wifiInterface.hotspot.name ?? "",
			gatewayIp: parseGatewayIp(raw),
			isActive: true,
		};
	}
	return { ssid: "", gatewayIp: "", isActive: false };
}
