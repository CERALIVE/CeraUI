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

import crypto from "node:crypto";
import type WebSocket from "ws";

import { logger } from "../../helpers/logger.ts";
import { getms } from "../../helpers/time.ts";
import {
	type WifiChannel,
	channelFromNM,
	isWifiChannelName,
	wifiChannels,
} from "./wifi-channels.ts";

import {
	nmConnGetFields,
	nmConnSetFields,
	nmConnSetWifiMacAddress,
	nmConnect,
	nmDisconnect,
	nmHotspot,
} from "../network/network-manager.ts";
import { buildMsg, getSocketSenderId } from "../ui/websocket-server.ts";
import {
	getWifiInterfaceByMacAddress,
	getWifiInterfacesByMacAddress,
	wifiRescan,
} from "./wifi-connections.ts";
import {
	type BaseWifiInterface,
	type WifiInterface,
	getMacAddressForWifiInterface,
	wifiUpdateDevices,
} from "./wifi-interfaces.ts";
import { wifiBroadcastState, wifiUpdateSavedConns } from "./wifi.ts";

export type WifiHotspotMessage = {
	hotspot: {
		start?: { device: number };
		stop?: { device: number };
		config?: {
			device: number;
			name: unknown;
			channel: unknown;
			password?: unknown;
		};
	};
};

export type WifiHotspot = {
	conn?: string;
	name?: string;
	password?: string;
	channel?: WifiChannel;
	availableChannels: WifiChannel[];
	warnings: Record<string, boolean>;
	forceHotspotStatus: number;
};

export type WifiInterfaceWithHotspot = BaseWifiInterface & {
	hotspot: WifiHotspot;
};

const HOTSPOT_UP_TO = 10;
const HOTSPOT_UP_FORCE_TO = (HOTSPOT_UP_TO + 2) * 1000;

export async function wifiHotspotStart(
	msg: NonNullable<WifiHotspotMessage["hotspot"]["start"]>,
) {
	if (!msg.device) return;

	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return;

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return;
	if (!canHotspot(wifiInterface)) return; // hotspot not supported, nothing to do

	if (wifiInterface.hotspot.conn) {
		if (wifiInterface.hotspot.conn !== wifiInterface.conn) {
			/* We assume that the operation will succeed, to be able to show an immediate response in the UI
         But especially if we're already connected to a network in client mode, it can take a few
         seconds before NM will show us as 'connected' to our hotspot connection.
         We use wifiForceHotspot() to ensure the device is reported in hotspot mode for this duration
      */
			wifiForceHotspot(wifiInterface, HOTSPOT_UP_FORCE_TO);
			wifiBroadcastState();

			if (await nmConnect(wifiInterface.hotspot.conn, HOTSPOT_UP_TO)) {
				await nmConnSetFields(wifiInterface.hotspot.conn, {
					"connection.autoconnect": "yes",
					"connection.autoconnect-priority": "999",
				});
			} else {
				// Remove the wifiForceHotspot() timer to immediately show the failure by resetting the UI to client mode
				wifiForceHotspot(wifiInterface, -1);
				wifiUpdateDevices();
			}
		}
	} else {
		const ms = macAddress.split(":");
		const name = `BELABOX_${ms[4]}${ms[5]}`;
		const password = crypto.randomBytes(9).toString("base64");

		// Temporary hotspot config to send to the client
		wifiInterface.hotspot.name = name;
		wifiInterface.hotspot.password = password;
		wifiInterface.hotspot.channel = "auto";
		wifiForceHotspot(wifiInterface, HOTSPOT_UP_FORCE_TO);
		wifiBroadcastState();

		// Create the NM connection for the hotspot
		const uuid = await nmHotspot(
			wifiInterface.ifname,
			name,
			password,
			HOTSPOT_UP_TO,
		);
		if (uuid) {
			// Update any settings that we need different from the default
			await nmConnSetFields(uuid, {
				"connection.interface-name": "", // FIXME: This should be the empty but bun currently drops empty arguments
				"connection.autoconnect": "yes",
				"connection.autoconnect-priority": "999",
				"802-11-wireless.mac-address": macAddress,
				"802-11-wireless-security.pmf": "disable",
			});
			// The updated settings will allow the connection to be recognised as our Hotspot connection
			await wifiUpdateSavedConns();
			// Restart the connection with the updated settings (needed to disable pmf)
			wifiForceHotspot(wifiInterface, HOTSPOT_UP_FORCE_TO);
			await nmConnect(uuid, HOTSPOT_UP_TO);
		} else {
			// Remove the wifiForceHotspot() timer to immediately show the failure by resetting the UI to client mode
			wifiForceHotspot(wifiInterface, -1);
			wifiUpdateDevices();
		}
	}
}

export async function wifiHotspotStop(
	msg: NonNullable<WifiHotspotMessage["hotspot"]["stop"]>,
) {
	if (!msg.device) return;

	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return;

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return;
	if (!isHotspot(wifiInterface)) return; // not in hotspot mode, nothing to do

	if (!wifiInterface.hotspot.conn) return;

	await nmConnSetFields(wifiInterface.hotspot.conn, {
		"connection.autoconnect": "no",
	});

	wifiForceHotspot(wifiInterface, -1);
	if (await nmDisconnect(wifiInterface.hotspot.conn)) {
		wifiInterface.conn = null;
		wifiInterface.available.clear();
		wifiBroadcastState();
		wifiRescan();
	}
}

export function canHotspot(
	wifiInterface: WifiInterface,
): wifiInterface is WifiInterfaceWithHotspot {
	return wifiInterface && "hotspot" in wifiInterface;
}

export function isHotspot(
	wifiInterface: WifiInterface,
): wifiInterface is WifiInterfaceWithHotspot {
	return (
		canHotspot(wifiInterface) &&
		((wifiInterface.hotspot.conn &&
			wifiInterface.conn === wifiInterface.hotspot.conn) ||
			wifiInterface.hotspot.forceHotspotStatus > getms())
	);
}

function nmConnSetHotspotFields(
	uuid: string,
	name: string,
	password: string,
	channel: string,
) {
	// Validate the requested channel
	if (!isWifiChannelName(channel)) return;

	const newChannel = wifiChannels[channel];
	const settingsToChange = {
		"802-11-wireless.ssid": name,
		"802-11-wireless-security.psk": password,
		"802-11-wireless.band": newChannel.nmBand,
		"802-11-wireless.channel": newChannel.nmChannel,
	};

	// FIXME: This should be an empty string for auto but bun currently drops empty arguments
	//      see https://github.com/oven-sh/bun/pull/17269
	//if (newChannel.nmBand === "") {
	//	// @ts-ignore
	//	// biome-ignore lint/performance/noDelete: see comment above
	//	delete settingsToChange["802-11-wireless.band"];
	//}

	// FIXME: This should be an empty string for auto but bun currently drops empty arguments
	//      see https://github.com/oven-sh/bun/pull/17269
	//if (newChannel.nmChannel === "") {
	//	// @ts-ignore
	//	// biome-ignore lint/performance/noDelete: see comment above
	//	delete settingsToChange["802-11-wireless.channel"];
	//}

	return nmConnSetFields(uuid, settingsToChange);
}

function isHotspotConfigComplete(
	i: WifiInterfaceWithHotspot,
): i is WifiInterfaceWithHotspot & {
	hotspot: { conn: string; name: string; password: string; channel: string };
} {
	return (
		i.hotspot.conn !== undefined &&
		i.hotspot.name !== undefined &&
		i.hotspot.password !== undefined &&
		i.hotspot.channel !== undefined
	);
}

export async function wifiHotspotConfig(
	conn: WebSocket,
	msg: NonNullable<WifiHotspotMessage["hotspot"]["config"]>,
) {
	// Find the Wifi interface
	if (!msg.device) return;

	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return;

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return;
	if (!isHotspot(wifiInterface)) return; // Make sure the interface is already in hotspot mode

	const senderId = getSocketSenderId(conn);

	// Make sure all required fields are present and valid
	if (
		msg.name === undefined ||
		typeof msg.name !== "string" ||
		msg.name.length < 1 ||
		msg.name.length > 32
	) {
		conn.send(
			buildMsg(
				"wifi",
				{ hotspot: { config: { device: msg.device, error: "name" } } },
				senderId,
			),
		);
		return;
	}

	if (
		msg.password === undefined ||
		typeof msg.password !== "string" ||
		msg.password.length < 8 ||
		msg.password.length > 64
	) {
		conn.send(
			buildMsg(
				"wifi",
				{ hotspot: { config: { device: msg.device, error: "password" } } },
				senderId,
			),
		);
		return;
	}

	if (
		msg.channel === undefined ||
		typeof msg.channel !== "string" ||
		!isWifiChannelName(msg.channel)
	) {
		conn.send(
			buildMsg(
				"wifi",
				{ hotspot: { config: { device: msg.device, error: "channel" } } },
				senderId,
			),
		);
		return;
	}

	// Update the NM connection
	if (
		wifiInterface.hotspot.conn &&
		!(await nmConnSetHotspotFields(
			wifiInterface.hotspot.conn,
			msg.name,
			msg.password,
			msg.channel,
		))
	) {
		conn.send(
			buildMsg(
				"wifi",
				{ hotspot: { config: { device: msg.device, error: "saving" } } },
				senderId,
			),
		);
		return;
	}

	// Restart the connection with the updated config
	wifiForceHotspot(wifiInterface, HOTSPOT_UP_FORCE_TO);

	if (
		isHotspotConfigComplete(wifiInterface) &&
		!(await nmConnect(wifiInterface.hotspot.conn, HOTSPOT_UP_TO))
	) {
		conn.send(
			buildMsg(
				"wifi",
				{ hotspot: { config: { device: msg.device, error: "activating" } } },
				senderId,
			),
		);

		// Failed to bring up the hotspot with the new settings; restore it
		wifiForceHotspot(wifiInterface, HOTSPOT_UP_FORCE_TO);

		await nmConnSetHotspotFields(
			wifiInterface.hotspot.conn,
			wifiInterface.hotspot.name,
			wifiInterface.hotspot.password,
			wifiInterface.hotspot.channel,
		);

		await nmConnect(wifiInterface.hotspot.conn, HOTSPOT_UP_TO);

		return;
	}

	// Successfully brought up the hotspot with the new settings, reload the NM connection
	await wifiUpdateSavedConns();

	conn.send(
		buildMsg(
			"wifi",
			{ hotspot: { config: { device: msg.device, success: true } } },
			senderId,
		),
	);
}

function wifiForceHotspot(wifiInterface: WifiInterface, ms: number) {
	if (!canHotspot(wifiInterface)) return;

	if (ms <= 0) {
		wifiInterface.hotspot.forceHotspotStatus = 0;
		return;
	}

	const until = getms() + ms;
	if (until > wifiInterface.hotspot.forceHotspotStatus) {
		wifiInterface.hotspot.forceHotspotStatus = until;
	}
}

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
