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

import type WebSocket from "ws";

import { setNetifDupIpSuppression } from "../network/network-interfaces.ts";
import {
	nmConnect,
	nmConnSetFields,
	nmDisconnect,
} from "../network/network-manager.ts";
import { withDeviceLock } from "../network/state/device-lock.ts";
import { buildMsg, getSocketSenderId } from "../ui/websocket-server.ts";
import { isWifiChannelName, wifiChannels } from "./wifi-channels.ts";
import { getWifiInterfaceByMacAddress, wifiRescan } from "./wifi-connections.ts";
import { settlePending, syncWifiStateCache } from "./wifi-hotspot-monitor.ts";
import {
	HOTSPOT_UP_TO,
	isHotspot,
	type WifiHotspotMessage,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import { getMacAddressForWifiInterface } from "./wifi-interfaces.ts";
import { broadcastWifiState, wifiUpdateSavedConns } from "./wifi.ts";

// ─── hotspot config validation constants ──────────────────────────────────────

/** Minimum length for hotspot SSID name. */
const HOTSPOT_NAME_MIN_LENGTH = 1;
/** Maximum length for hotspot SSID name. */
const HOTSPOT_NAME_MAX_LENGTH = 32;
/** Minimum length for hotspot password. */
const HOTSPOT_PASSWORD_MIN_LENGTH = 8;
/** Maximum length for hotspot password. */
const HOTSPOT_PASSWORD_MAX_LENGTH = 64;

// ─── stop ────────────────────────────────────────────────────────────────────

export async function wifiHotspotStop(
	msg: NonNullable<WifiHotspotMessage["hotspot"]["stop"]>,
) {
	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return;

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return;
	if (!isHotspot(wifiInterface)) return; // not in hotspot mode, nothing to do
	if (!wifiInterface.hotspot.conn) return;

	// Any in-flight confirmation for this device is now moot.
	settlePending(wifiInterface.ifname, false);

	await withDeviceLock(wifiInterface.ifname, () =>
		stopHotspotLocked(macAddress, wifiInterface),
	);
}

async function stopHotspotLocked(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
): Promise<void> {
	const conn = wifiInterface.hotspot.conn;
	if (!conn) return;

	wifiInterface.hotspot.transition = "deactivating";
	broadcastWifiState();
	syncWifiStateCache(macAddress, wifiInterface);

	await nmConnSetFields(conn, { "connection.autoconnect": "no" });

	if (await nmDisconnect(conn)) {
		wifiInterface.conn = null;
		wifiInterface.available.clear();
	}

	wifiInterface.hotspot.transition = undefined;
	setNetifDupIpSuppression(wifiInterface.ifname, false);
	broadcastWifiState();
	syncWifiStateCache(macAddress, wifiInterface);
	wifiRescan();
}

// ─── config ──────────────────────────────────────────────────────────────────

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
		msg.name.length < HOTSPOT_NAME_MIN_LENGTH ||
		msg.name.length > HOTSPOT_NAME_MAX_LENGTH
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
		msg.password.length < HOTSPOT_PASSWORD_MIN_LENGTH ||
		msg.password.length > HOTSPOT_PASSWORD_MAX_LENGTH
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

	const name = msg.name;
	const password = msg.password;
	const channel = msg.channel;

	// Serialize the reconfigure against other hotspot operations on this device.
	const lock = await withDeviceLock(wifiInterface.ifname, () =>
		reconfigureHotspotLocked(
			macAddress,
			wifiInterface,
			name,
			password,
			channel,
		),
	);

	if (!lock.success) {
		conn.send(
			buildMsg(
				"wifi",
				{ hotspot: { config: { device: msg.device, error: "saving" } } },
				senderId,
			),
		);
		return;
	}

	const result = lock.result;
	if (result === "saving" || result === "activating") {
		conn.send(
			buildMsg(
				"wifi",
				{ hotspot: { config: { device: msg.device, error: result } } },
				senderId,
			),
		);
		return;
	}

	conn.send(
		buildMsg(
			"wifi",
			{ hotspot: { config: { device: msg.device, success: true } } },
			senderId,
		),
	);
}

type ReconfigureResult = "ok" | "saving" | "activating";

async function reconfigureHotspotLocked(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	name: string,
	password: string,
	channel: string,
): Promise<ReconfigureResult> {
	// Update the NM connection
	if (
		wifiInterface.hotspot.conn &&
		!(await nmConnSetHotspotFields(
			wifiInterface.hotspot.conn,
			name,
			password,
			channel,
		))
	) {
		return "saving";
	}

	// Restart the connection with the updated config
	wifiInterface.hotspot.transition = "activating";
	broadcastWifiState();

	if (
		isHotspotConfigComplete(wifiInterface) &&
		!(await nmConnect(wifiInterface.hotspot.conn, HOTSPOT_UP_TO))
	) {
		// Failed to bring up the hotspot with the new settings; restore it.
		await nmConnSetHotspotFields(
			wifiInterface.hotspot.conn,
			wifiInterface.hotspot.name,
			wifiInterface.hotspot.password,
			wifiInterface.hotspot.channel,
		);

		await nmConnect(wifiInterface.hotspot.conn, HOTSPOT_UP_TO);

		wifiInterface.hotspot.transition = undefined;
		broadcastWifiState();
		syncWifiStateCache(macAddress, wifiInterface);
		return "activating";
	}

	// Successfully brought up the hotspot with the new settings, reload the conn.
	wifiInterface.hotspot.transition = undefined;
	await wifiUpdateSavedConns();
	broadcastWifiState();
	syncWifiStateCache(macAddress, wifiInterface);
	return "ok";
}
