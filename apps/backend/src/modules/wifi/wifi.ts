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

/* NetworkManager / nmcli based Wifi Manager */

import type WebSocket from "ws";

import { logger } from "../../helpers/logger.ts";
import { pollWithBackoff } from "../../helpers/retry.ts";
import { DEFAULT_SPAWN_TIMEOUT_MS } from "../../helpers/spawn-policy.ts";
import { extractMessage } from "../../helpers/types.ts";
import {
	getMockState,
	getScenarioConfig,
	getWifiSignal,
	mockWifiNetworks,
	mockWifiRadios,
	mockWifiUuidForSsid,
	shouldUseMocks,
} from "../../mocks/mock-service.ts";
import { getMockHotspotConfig } from "../../mocks/providers/wifi.ts";
import {
	type ConnectionUUID,
	type MacAddress,
	nmConnDelete,
	nmConnect,
	nmConnGetFields,
	nmConnSetWifiMacAddress,
	nmConnsGet,
	nmcliParseSep,
	nmDisconnect,
} from "../network/network-manager.ts";
import {
	broadcastMsg,
	buildMsg,
	getSocketSenderId,
} from "../ui/websocket-server.ts";
import { getWifiChannelMap } from "./wifi-channels.ts";
import {
	getWifiInterfaceByMacAddress,
	getWifiInterfacesByMacAddress,
	wifiRescan,
	wifiScheduleScanRefresh,
	wifiUpdateScanResult,
} from "./wifi-connections.ts";
import { wifiHotspotStart } from "./wifi-hotspot-activation.ts";
import { wifiHotspotConfig, wifiHotspotStop } from "./wifi-hotspot-config.ts";
import { handleHotspotConn } from "./wifi-hotspot-discovery.ts";
import {
	canHotspot,
	isHotspot,
	type WifiHotspot,
	type WifiHotspotMessage,
} from "./wifi-hotspot-types.ts";
import {
	type BaseWifiInterface,
	getMacAddressForWifiInterface,
	getWifiIdToMacAddress,
	type SSID,
	type WifiInterface,
	type WifiInterfaceId,
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

type WifiScanMessage = {
	scan: WifiInterfaceId;
};

export type WifiMessage = {
	wifi:
		| WifiConnectMessage
		| WifiDisconnectMessage
		| WifiNewMessage
		| WifiForgetMessage
		| WifiScanMessage
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
	"ifname" | "hw" | "saved"
> & {
	// Empty string = no active connection (the wire convention every build path
	// uses); the real path coerces BaseWifiInterface.conn's null to "" to match.
	conn: string;
	available?: Array<WifiNetwork>;
	hotspot?: Pick<WifiHotspot, "name" | "password" | "channel"> & {
		available_channels: Record<string, { name: string }>;
		warnings?: string[];
	};
	supports_hotspot?: true;
	mode?: "station" | "hotspot";
	transition?: "activating" | "deactivating";
};

export function wifiBuildMsg() {
	// Return mock WiFi data in development mode
	if (shouldUseMocks()) {
		const config = getScenarioConfig();
		if (!config.wifi) return {};

		const state = getMockState();
		const ifs: Record<string, WifiInterfaceResponseMessage> = {};

		mockWifiRadios.forEach((radio, index) => {
			if (state.wifiModes[radio.device] === "hotspot") {
				const hotspot = getMockHotspotConfig(radio.device);
				ifs[index] = {
					ifname: radio.ifname,
					conn: hotspot.uuid,
					hw: radio.macAddress,
					saved: {},
					hotspot: {
						name: hotspot.name,
						password: hotspot.password,
						channel: hotspot.channel,
						available_channels: getWifiChannelMap([
							"auto",
							"auto_24",
							"auto_50",
						]),
					},
				} satisfies WifiInterfaceResponseMessage;
				return;
			}

			const wlanState = state.wifiConnections.get(radio.device);
			const activeSsid = wlanState?.activeNetwork;
			const savedNetworks = wlanState?.savedNetworks ?? [];

			const available: WifiNetwork[] = mockWifiNetworks
				.map((network) => ({
					active: network.ssid === activeSsid,
					ssid: network.ssid,
					signal: Math.round(getWifiSignal(network.ssid)),
					security: network.security,
					freq: network.frequency,
				}))
				.sort((a, b) => b.signal - a.signal);

			const saved: Record<string, string> = {};
			for (const ssid of savedNetworks) {
				saved[ssid] = mockWifiUuidForSsid(ssid);
			}

			ifs[index] = {
				ifname: radio.ifname,
				conn: activeSsid ? mockWifiUuidForSsid(activeSsid) : "",
				hw: radio.macAddress,
				saved,
				available,
				...(radio.supports_hotspot ? { supports_hotspot: true } : {}),
			} satisfies WifiInterfaceResponseMessage;
		});

		return ifs;
	}

	const ifs: Record<string, WifiInterfaceResponseMessage> = {};
	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const macAddress in wifiInterfacesByMacAddress) {
		const wifiInterface = wifiInterfacesByMacAddress[macAddress];
		if (!wifiInterface) continue;

		const id = wifiInterface.id;

		const entry: WifiInterfaceResponseMessage = {
			ifname: wifiInterface.ifname,
			conn: wifiInterface.conn ?? "",
			hw: wifiInterface.hw,
			saved: {},
		};
		ifs[id] = entry;

		if (isHotspot(wifiInterface)) {
			const hotspot: NonNullable<WifiInterfaceResponseMessage["hotspot"]> = {
				...(wifiInterface.hotspot.name !== undefined
					? { name: wifiInterface.hotspot.name }
					: {}),
				...(wifiInterface.hotspot.password !== undefined
					? { password: wifiInterface.hotspot.password }
					: {}),
				available_channels: getWifiChannelMap(
					wifiInterface.hotspot.availableChannels,
				),
				...(wifiInterface.hotspot.channel !== undefined
					? { channel: wifiInterface.hotspot.channel }
					: {}),
			};

			const warnings = Object.keys(wifiInterface.hotspot.warnings);
			if (warnings.length > 0) {
				hotspot.warnings = warnings;
			}
			entry.hotspot = hotspot;
		} else {
			entry.available = Array.from(wifiInterface.available.values());
			entry.saved = wifiInterface.saved;
			if (canHotspot(wifiInterface)) {
				entry.supports_hotspot = true;
			}
		}

		entry.mode = isHotspot(wifiInterface) ? "hotspot" : "station";
		if (canHotspot(wifiInterface) && wifiInterface.hotspot.transition) {
			entry.transition = wifiInterface.hotspot.transition;
		}
	}

	return ifs;
}

export function broadcastWifiState() {
	broadcastMsg("status", { wifi: wifiBuildMsg() });
}

/*
  Record one saved infrastructure connection on the interface(s) it can be used
  from. A profile bound to a MAC that a present adapter reports is attributed to
  that adapter only. Any other profile — no bound MAC (created outside CeraUI:
  nmtui, `nmcli device wifi connect`, a baked image profile) or a bound MAC that
  matches no present adapter (MAC randomization / swapped adapter) — is registered
  on every adapter, mirroring the scan path where all interfaces see all networks.
  Without this fallback an active-but-unbound connection resolves no UUID and the
  UI shows "Connect" on the network the device is already connected to.
*/
export function registerSavedWifiConnection(
	interfaces: Record<MacAddress, WifiInterface>,
	macAddress: MacAddress,
	ssid: SSID,
	uuid: ConnectionUUID,
): void {
	const boundInterface = macAddress ? interfaces[macAddress] : undefined;
	if (boundInterface) {
		boundInterface.saved[ssid] = uuid;
		return;
	}
	for (const wifiInterface of Object.values(interfaces)) {
		wifiInterface.saved[ssid] = uuid;
	}
}

export async function wifiUpdateSavedConns() {
	// Retry transient nmcli connection-list failures with exponential backoff (T7).
	const connections = await pollWithBackoff(() => nmConnsGet("uuid,type"), {
		maxAttempts: 3,
		baseDelayMs: 200,
		maxDelayMs: 1000,
		emptyResultError: () =>
			new Error("nmcli connection list returned no results"),
		onExhausted: (err) =>
			logger.debug(`wifiUpdateSavedConns: list failed after retries: ${err}`),
	});
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
				void handleHotspotConn(macAddress, uuid);
			} else if (mode === "infrastructure") {
				registerSavedWifiConnection(
					wifiInterfacesByMacAddress,
					macAddress,
					ssid,
					uuid,
				);
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
		wifiScheduleScanRefresh();
	}
}

async function wifiForget(uuid: ConnectionUUID) {
	if (wifiSearchConnection(uuid) === undefined) return;

	if (await nmConnDelete(uuid)) {
		await wifiUpdateSavedConns();
		await wifiUpdateScanResult();
		wifiScheduleScanRefresh();
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

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
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

	void runWifiNew(conn, msg, macAddress, args, senderId);
}

async function runWifiNew(
	conn: WebSocket,
	msg: WifiNewMessage["new"],
	macAddress: string,
	args: string[],
	senderId: ReturnType<typeof getSocketSenderId>,
) {
	const proc = Bun.spawn(["nmcli", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	// bounded-command (spawn-policy): cap a hung nmcli connect at the wall-clock
	// budget so a stuck join never leaves the request pending forever.
	const killTimer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// best-effort: the process may have already exited
		}
	}, DEFAULT_SPAWN_TIMEOUT_MS);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	clearTimeout(killTimer);
	const error = exitCode !== 0;

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
				void wifiConnect(
					conn,
					extractMessage<WifiConnectMessage, typeof type>(msg, type),
				);
				break;

			case "disconnect":
				void wifiDisconnect(
					extractMessage<WifiDisconnectMessage, typeof type>(msg, type),
				);
				break;

			case "scan":
				void wifiRescan();
				break;

			case "new":
				wifiNew(conn, extractMessage<WifiNewMessage, typeof type>(msg, type));
				break;

			case "forget":
				void wifiForget(
					extractMessage<WifiForgetMessage, typeof type>(msg, type),
				);
				break;

			case "hotspot": {
				const hotspotMessage = extractMessage<WifiHotspotMessage, typeof type>(
					msg,
					type,
				);
				if ("start" in hotspotMessage && hotspotMessage.start) {
					void wifiHotspotStart(hotspotMessage.start);
				} else if ("stop" in hotspotMessage && hotspotMessage.stop) {
					void wifiHotspotStop(hotspotMessage.stop);
				} else if ("config" in hotspotMessage && hotspotMessage.config) {
					void wifiHotspotConfig(conn, hotspotMessage.config);
				}
				break;
			}
		}
	}
}
