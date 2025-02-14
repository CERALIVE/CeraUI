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

/* NetworkManager / nmcli based Wifi Manager */

import { type ExecFileException, execFile } from "node:child_process";

import type WebSocket from "ws";

import { logger } from "../helpers/logger.ts";
import { extractMessage } from "../helpers/types.ts";
import { getWifiChannelMap } from "../helpers/wifi-channels.ts";

import {
	nmConnDelete,
	nmConnGetFields,
	nmConnSetWifiMacAddress,
	nmConnect,
	nmConnsGet,
	nmDisconnect,
	nmcliParseSep,
} from "./network-manager.ts";
import {
	broadcastMsg,
	buildMsg,
	getSocketSenderId,
} from "./websocket-server.ts";
import {
	getWifiInterfaceForMacAddress,
	getWifiInterfacesByMacAddress,
	wifiRescan,
	wifiScheduleScanUpdates,
	wifiUpdateScanResult,
} from "./wifi-connections.ts";
import {
	type WifiHotspot,
	type WifiHotspotMessage,
	canHotspot,
	handleHotspotConn,
	isHotspot,
	wifiHotspotConfig,
	wifiHotspotStart,
	wifiHotspotStop,
} from "./wifi-hotspot.ts";
import {
	type BaseWifiInterface,
	type ConnectionUUID,
	type SSID,
	type WifiInterfaceId,
	getMacAddressForWifiInterface,
	getWifiIdToMacAddress,
} from "./wifi-interfaces.ts";

type WifiConnectMessage = {
	connect: ConnectionUUID;
};

type WifiDisconnectMessage = {
	disconnect: ConnectionUUID;
};

type WifiNewMessage = {
	new: {
		device: WifiInterfaceId;
		ssid: SSID;
		password?: string;
	};
};

type WifiForgetMessage = {
	forget: ConnectionUUID;
};

export type WifiMessage = {
	wifi:
		| WifiConnectMessage
		| WifiDisconnectMessage
		| WifiNewMessage
		| WifiHotspotMessage;
};

// 1 - 100
type WifiSignalStrength = number;

export type WifiNetwork = {
	active: boolean; // is it currently connected?
	ssid: SSID;
	signal: WifiSignalStrength;
	security: string;
	freq: number;
};

/* Builds the WiFi status structure sent over the network from the <wd> structures */
export type WifiInterfaceResponseMessage = Pick<
	BaseWifiInterface,
	"ifname" | "conn" | "hw" | "saved"
> & {
	available?: Array<WifiNetwork>;
	hotspot?: Pick<WifiHotspot, "name" | "password" | "channel"> & {
		available_channels: Record<string, { name: string }>;
		warnings?: string[];
	};
	supports_hotspot?: true;
};

export function wifiBuildMsg() {
	const ifs: Record<number, WifiInterfaceResponseMessage> = {};
	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const macAddress in wifiInterfacesByMacAddress) {
		const wifiInterface = wifiInterfacesByMacAddress[macAddress];
		if (!wifiInterface) continue;

		const id = wifiInterface.id;

		ifs[id] = {
			ifname: wifiInterface.ifname,
			conn: wifiInterface.conn,
			hw: wifiInterface.hw,
			saved: {},
		};

		if (isHotspot(wifiInterface)) {
			ifs[id].hotspot = {
				name: wifiInterface.hotspot.name,
				password: wifiInterface.hotspot.password,
				available_channels: getWifiChannelMap(
					wifiInterface.hotspot.availableChannels,
				),
				channel: wifiInterface.hotspot.channel,
			};

			const warnings = Object.keys(wifiInterface.hotspot.warnings);
			if (warnings.length > 0) {
				ifs[id].hotspot.warnings = warnings;
			}
		} else {
			ifs[id].available = Array.from(wifiInterface.available.values());
			ifs[id].saved = wifiInterface.saved;
			if (canHotspot(wifiInterface)) {
				ifs[id].supports_hotspot = true;
			}
		}
	}

	return ifs;
}

export function wifiBroadcastState() {
	broadcastMsg("status", { wifi: wifiBuildMsg() });
}

export async function wifiUpdateSavedConns() {
	const connections = await nmConnsGet("uuid,type");
	if (connections === undefined) return;

	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const wifiInterface of Object.values(wifiInterfacesByMacAddress)) {
		wifiInterface.saved = {};
	}

	for (const connection of connections) {
		try {
			const [uuid, type] = nmcliParseSep(connection) as [
				ConnectionUUID,
				string,
			];

			if (type !== "802-11-wireless") continue;

			// Get the device the connection is bound to and the ssid
			const fields = await nmConnGetFields(uuid, [
				"802-11-wireless.mode",
				"802-11-wireless.ssid",
				"802-11-wireless.mac-address",
			] as const);

			if (fields === undefined) {
				throw new Error("Failed to get connection fields");
			}

			const [mode, ssid, macTmp] = fields;
			if (!ssid) {
				logger.warn("Wifi connection does not have an SSID!", { mode, uuid });
				continue;
			}

			const macAddress = macTmp.toLowerCase();
			if (mode === "ap") {
				handleHotspotConn(macAddress, uuid);
			} else if (mode === "infrastructure") {
				if (macAddress && wifiInterfacesByMacAddress[macAddress]) {
					wifiInterfacesByMacAddress[macAddress].saved[ssid] = uuid;
				}
			}
		} catch (err) {
			if (err instanceof Error) {
				logger.error(
					`Error getting the nmcli connection information: ${err.message}`,
				);
			}
		}
	}
}

/* Searches saved connections in wifiIfs by UUID */
function wifiSearchConnection(uuid: string) {
	let connFound: string | undefined;

	const wifiIdToMacAddress = getWifiIdToMacAddress();
	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const id in wifiIdToMacAddress) {
		const macAddress = getMacAddressForWifiInterface(Number.parseInt(id, 10));
		if (!macAddress) continue;

		const wifiInterface = wifiInterfacesByMacAddress[macAddress];
		if (!wifiInterface) continue;

		for (const s in wifiInterface.saved) {
			if (wifiInterface.saved[s] === uuid) {
				connFound = id;
				break;
			}
		}
	}

	return connFound;
}

async function wifiDisconnect(uuid: ConnectionUUID) {
	if (wifiSearchConnection(uuid) === undefined) return;

	if (await nmDisconnect(uuid)) {
		await wifiUpdateScanResult();
		wifiScheduleScanUpdates();
	}
}

async function wifiForget(uuid: ConnectionUUID) {
	if (wifiSearchConnection(uuid) === undefined) return;

	if (await nmConnDelete(uuid)) {
		await wifiUpdateSavedConns();
		await wifiUpdateScanResult();
		wifiScheduleScanUpdates();
	}
}

async function wifiDeleteFailedConns() {
	const connections = (await nmConnsGet(
		"uuid,type,timestamp",
	)) as Array<string>;
	for (const connection of connections) {
		const [uuid, type, ts] = nmcliParseSep(connection) as [
			string,
			string,
			string,
		];
		if (type !== "802-11-wireless") continue;
		if (ts === "0") {
			await nmConnDelete(uuid);
		}
	}
}

function wifiNew(conn: WebSocket, msg: WifiNewMessage["new"]) {
	if (!msg.device || !msg.ssid) return;

	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return;

	const wifiInterface = getWifiInterfaceForMacAddress(macAddress);
	if (!wifiInterface) return;

	const args = [
		"-w",
		"15",
		"device",
		"wifi",
		"connect",
		msg.ssid,
		"ifname",
		wifiInterface.ifname,
	];

	if (msg.password) {
		args.push("password");
		args.push(msg.password);
	}

	const senderId = getSocketSenderId(conn);

	execFile(
		"nmcli",
		args,
		async (error: ExecFileException | null, stdout: string, stderr: string) => {
			if (error || stdout.match("^Error:")) {
				await wifiDeleteFailedConns();

				if (stdout.match("Secrets were required, but not provided")) {
					conn.send(
						buildMsg(
							"wifi",
							{ new: { error: "auth", device: msg.device } },
							senderId,
						),
					);
				} else {
					conn.send(
						buildMsg(
							"wifi",
							{ new: { error: "generic", device: msg.device } },
							senderId,
						),
					);
				}
			} else {
				const success = stdout.match(/successfully activated with '(.+)'/);
				if (success?.[1]) {
					const uuid = success[1];
					if (!(await nmConnSetWifiMacAddress(uuid, macAddress))) {
						logger.warn(
							"Failed to set the MAC address for the newly created connection",
						);
					}

					await wifiUpdateSavedConns();
					await wifiUpdateScanResult();

					conn.send(
						buildMsg(
							"wifi",
							{ new: { success: true, device: msg.device } },
							senderId,
						),
					);
				} else {
					logger.warn(
						`wifiNew: no error but not matching a successful connection msg in:\n${stdout}\n${stderr}`,
					);
				}
			}
		},
	);
}

async function wifiConnect(conn: WebSocket, uuid: ConnectionUUID) {
	const deviceId = wifiSearchConnection(uuid);
	if (deviceId === undefined) return;

	const senderId = getSocketSenderId(conn);
	const success = await nmConnect(uuid);
	await wifiUpdateScanResult();
	conn.send(buildMsg("wifi", { connect: success, device: deviceId }, senderId));
}

export function handleWifi(conn: WebSocket, msg: WifiMessage["wifi"]) {
	for (const type in msg) {
		switch (type) {
			case "connect":
				wifiConnect(
					conn,
					extractMessage<WifiConnectMessage, typeof type>(msg, type),
				);
				break;

			case "disconnect":
				wifiDisconnect(
					extractMessage<WifiDisconnectMessage, typeof type>(msg, type),
				);
				break;

			case "scan":
				wifiRescan();
				break;

			case "new":
				wifiNew(conn, extractMessage<WifiNewMessage, typeof type>(msg, type));
				break;

			case "forget":
				wifiForget(extractMessage<WifiForgetMessage, typeof type>(msg, type));
				break;

			case "hotspot": {
				const hotspotMessage = extractMessage<WifiHotspotMessage, typeof type>(
					msg,
					type,
				);
				if ("start" in hotspotMessage && hotspotMessage.start) {
					wifiHotspotStart(hotspotMessage.start);
				} else if ("stop" in hotspotMessage && hotspotMessage.stop) {
					wifiHotspotStop(hotspotMessage.stop);
				} else if ("config" in hotspotMessage && hotspotMessage.config) {
					wifiHotspotConfig(conn, hotspotMessage.config);
				}
				break;
			}
		}
	}
}
