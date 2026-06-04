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
import {
	nmConnGetFields,
	nmConnSetFields,
	nmConnSetWifiMacAddress,
} from "../network/network-manager.ts";
import { channelFromNM } from "./wifi-channels.ts";
import {
	getWifiInterfaceByMacAddress,
	getWifiInterfacesByMacAddress,
} from "./wifi-connections.ts";
import { canHotspot } from "./wifi-hotspot-types.ts";

// ─── NM connection discovery (hotspot bootstrap) ─────────────────────────────

export async function handleHotspotConn(
	macAddress_: string | undefined,
	uuid: string,
) {
	const macAddress = macAddress_ || (await findMacAddressForConnection(uuid));
	if (!macAddress) {
		return;
	}

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) {
		logger.warn("Can not update hotspot connection, interface not found");
		return;
	}

	if (!canHotspot(wifiInterface)) {
		logger.warn(
			"Can not update hotspot connection, interface does not support hotspot",
		);
		return;
	}

	if (
		// Interface already has a different hotspot connection
		wifiInterface.hotspot.conn &&
		wifiInterface.hotspot.conn !== uuid
	) {
		logger.warn(
			"Can not update hotspot connection, interface already has an active connection",
		);
		return;
	}

	/*
    we expect and will update automatically:
    connection.autoconnect-priority: 999

    we expect these settings, otherwise will mark as modified connections:
    802-11-wireless.hidden=no
    802-11-wireless-security.key-mgmt=wpa-psk
    802-11-wireless-security.pairwise=ccmp
    802-11-wireless-security.group=ccmp
    802-11-wireless-security.proto=rsn
    802-11-wireless-security.pmf=1 (disable) - disables requiring WPA3 Protected Management Frames for compatibility
  */
	const settingsFields = [
		"connection.autoconnect-priority",
		"802-11-wireless.ssid",
		"802-11-wireless-security.psk",
		"802-11-wireless.band",
		"802-11-wireless.channel",
	] as const;
	const checkFields = [
		"802-11-wireless.hidden",
		"802-11-wireless-security.key-mgmt",
		"802-11-wireless-security.pairwise",
		"802-11-wireless-security.group",
		"802-11-wireless-security.proto",
		"802-11-wireless-security.pmf",
	] as const;

	const fields = await nmConnGetFields(uuid, [
		...settingsFields,
		...checkFields,
	] as const);

	if (fields === undefined) return;

	/* If the connection doesn't have maximum priority, update it
     This is required to ensure the hotspot is started even if the Wifi
     networks for some matching client connections are available
  */
	if (fields[0] !== "999") {
		await nmConnSetFields(uuid, { "connection.autoconnect-priority": "999" });
	}

	wifiInterface.hotspot.conn = uuid;
	wifiInterface.hotspot.name = fields[1];
	wifiInterface.hotspot.password = fields[2];
	wifiInterface.hotspot.channel = channelFromNM(fields[3], fields[4]);

	if (
		fields[5] !== "no" ||
		fields[6] !== "wpa-psk" ||
		fields[7] !== "ccmp" ||
		fields[8] !== "ccmp" ||
		fields[9] !== "rsn" ||
		fields[10] !== "1"
	) {
		wifiInterface.hotspot.warnings.modified = true;
	}
}

async function findMacAddressForConnection(uuid: string) {
	// Check if the connection is in use for any wifi interface
	const connIfName = (
		await nmConnGetFields(uuid, ["connection.interface-name"] as const)
	)?.[0];

	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const macAddress in wifiInterfacesByMacAddress) {
		const wifiInterface = wifiInterfacesByMacAddress[macAddress];

		if (
			!wifiInterface ||
			!canHotspot(wifiInterface) ||
			(wifiInterface.hotspot.conn !== uuid &&
				wifiInterface.ifname !== connIfName)
		) {
			continue;
		}

		// If we can match the connection against a certain interface
		if (!wifiInterface.hotspot.conn) {
			// And if this interface doesn't already have a hotspot connection
			// Try to update the connection to match the MAC address
			if (await nmConnSetWifiMacAddress(uuid, macAddress)) {
				wifiInterface.hotspot.conn = uuid;
				return macAddress;
			}
		} else {
			// If the interface already has a hotspot connection, then disable autoconnect
			await nmConnSetFields(uuid, { "connection.autoconnect": "no" });
		}

		break;
	}

	return undefined;
}
