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

/*
  NetworkManager / nmcli based Wifi Manager

  Structs:

  WiFi list <wifiIfs>:
  {
    'mac': <wd>
  }

  WiFi id to MAC address mapping <wifiIdToHwAddr>:
  {
    id: 'mac'
  }

  Wifi device <wd>:
  {
    'id', // numeric id for the adapter - temporary for each belaUI execution
    'ifname': 'wlanX',
    'conn': 'uuid' or undefined; // the active connection
    'hw': 'hardware name',       // the name of the wifi adapter hardware
    'available': Map{<an>},
    'saved': {<sn>},
    'hotspot': {
      'conn': 'uuid',
      'name': 'ssid',
      'password': 'password',
      'availableChannels': ['auto', 'auto_24', 'auto_50'],
      'channel': ^see above,
      'warnings': {} / {modified: true},
    }
  }

  Available network <an>:
  {
    active, // is it currently connected?
    ssid,
    signal: 0-100,
    security,
    freq
  }

  Saved networks {<sn>}:
  {
    ssid: uuid,
  }
*/

import { type ExecFileException, execFile } from "node:child_process";
import crypto from "node:crypto";

import type WebSocket from "ws";

import { getms } from "../helpers/time.ts";
import { extractMessage } from "../helpers/types.ts";

import { logger } from "../helpers/logger.ts";
import { updateMoblinkRelayInterfaces } from "./moblink-relay.ts";
import {
	NETIF_ERR_HOTSPOT,
	getNetworkInterfaces,
	setNetifHotspot,
} from "./network-interfaces.ts";
import {
	nmConnDelete,
	nmConnGetFields,
	nmConnSetFields,
	nmConnSetWifiMac,
	nmConnect,
	nmConnsGet,
	nmDeviceProp,
	nmDevices,
	nmDisconnect,
	nmHotspot,
	nmRescan,
	nmScanResults,
	nmcliParseSep,
} from "./network-manager.ts";
import { updateSrtlaIps } from "./srtla.ts";
import { getIsStreaming } from "./streaming.ts";
import {
	broadcastMsg,
	buildMsg,
	getSocketSenderId,
} from "./websocket-server.ts";
import {
	wifiDeviceListGetHwAddr,
	wifiDeviceListGetInetAddr,
} from "./wifi-device-list.ts";

type WifiConnectMessage = {
	connect: string;
};

type WifiDisconnectMessage = {
	disconnect: string;
};

type WifiNewMessage = {
	new: {
		device: string;
		ssid: string;
		password?: string;
	};
};

type WifiForgetMessage = {
	forget: string;
};

type WifiHotspotMessage = {
	hotspot: {
		start?: { device: string };
		stop?: { device: string };
		config?: {
			device: string;
			name: unknown;
			channel: unknown;
			password?: unknown;
		};
	};
};

export type WifiMessage = {
	wifi:
		| WifiConnectMessage
		| WifiDisconnectMessage
		| WifiNewMessage
		| WifiHotspotMessage;
};

type WifiNetwork = {
	active: boolean;
	ssid: string;
	signal: number;
	security: string;
	freq: number;
};

type BaseWifiInterface = {
	id: number;
	ifname: string;
	conn: string | null;
	hw: string;
	available: Map<string, WifiNetwork>;
	saved: Record<string, string>;
	removed?: true;
};

type WifiHotspot = {
	conn?: string;
	name?: string;
	password?: string;
	channel?: string;
	availableChannels: string[];
	warnings: Record<string, boolean>;
	forceHotspotStatus: number;
};

type WifiInterfaceWithHotspot = BaseWifiInterface & {
	hotspot: WifiHotspot;
};

type WifiInterface = BaseWifiInterface | WifiInterfaceWithHotspot;

let wifiIfId = 0;
const wifiIfs: Record<string, WifiInterface> = {};
let wifiIdToHwAddr: Record<string, string> = {};

/* Builds the WiFi status structure sent over the network from the <wd> structures */
type WifiInterfaceResponseMessage = Pick<
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
	for (const i in wifiIfs) {
		const wifiInterface = wifiIfs[i];
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

function wifiBroadcastState() {
	broadcastMsg("status", { wifi: wifiBuildMsg() });
}

const wifiChannels = {
	auto: { name: "Auto (any band)", nmBand: "", nmChannel: "" },
	auto_24: { name: "Auto (2.4 GHz)", nmBand: "bg", nmChannel: "" },
	auto_50: { name: "Auto (5.0 GHz)", nmBand: "a", nmChannel: "" },
} as const;

const isWifiChannelName = (
	channel: string,
): channel is keyof typeof wifiChannels => channel in wifiChannels;

function getWifiChannelMap(list: Array<string>) {
	const map: Record<string, { name: string }> = {};
	for (const e of list) {
		if (isWifiChannelName(e)) {
			map[e] = { name: wifiChannels[e].name };
		} else {
			logger.info(`Unknown WiFi channel ${e}`);
		}
	}

	return map;
}

function channelFromNM(band: string, channel: string | number) {
	for (const i in wifiChannels) {
		if (
			isWifiChannelName(i) &&
			band === wifiChannels[i].nmBand &&
			(channel === wifiChannels[i].nmChannel ||
				(channel === 0 && wifiChannels[i].nmChannel === ""))
		) {
			return i;
		}
	}

	return "auto";
}

async function findMacAddressForConnection(uuid: string) {
	// Check if the connection is in use for any wifi interface
	const connIfName = (
		await nmConnGetFields(uuid, ["connection.interface-name"] as const)
	)?.[0];

	for (const macAddress in wifiIfs) {
		const wifiInterface = wifiIfs[macAddress];

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
			if (await nmConnSetWifiMac(uuid, macAddress)) {
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

async function handleHotspotConn(macAddr_: string | undefined, uuid: string) {
	const macAddr = macAddr_ || (await findMacAddressForConnection(uuid));
	if (!macAddr) {
		return;
	}

	const wifiInterface = wifiIfs[macAddr];
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

async function wifiUpdateSavedConns() {
	const connections = await nmConnsGet("uuid,type");
	if (connections === undefined) return;

	for (const wifiInterface of Object.values(wifiIfs)) {
		wifiInterface.saved = {};
	}

	for (const connection of connections) {
		try {
			const [uuid, type] = nmcliParseSep(connection) as [string, string];

			if (type !== "802-11-wireless") continue;

			// Get the device the connection is bound to and the ssid
			const fields = await nmConnGetFields(uuid, [
				"802-11-wireless.mode",
				"802-11-wireless.ssid",
				"802-11-wireless.mac-address",
			] as const);

			if (fields === undefined)
				throw new Error("Failed to get connection fields");

			const [mode, ssid, macTmp] = fields;
			if (!ssid) {
				logger.warn("Wifi connection does not have an SSID!", { mode, uuid });
				continue;
			}

			const macAddr = macTmp.toLowerCase();
			if (mode === "ap") {
				handleHotspotConn(macAddr, uuid);
			} else if (mode === "infrastructure") {
				if (macAddr && wifiIfs[macAddr]) {
					wifiIfs[macAddr].saved[ssid] = uuid;
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

async function wifiUpdateScanResult() {
	const wifiNetworks = await nmScanResults(
		"active,ssid,signal,security,freq,device",
	);
	if (!wifiNetworks) return;

	for (const wifiInterface of Object.values(wifiIfs)) {
		wifiInterface.available = new Map();
	}

	for (const wifiNetwork of wifiNetworks) {
		const [active, ssid, signal, security, freq, device] = nmcliParseSep(
			wifiNetwork,
		) as [string, string, string, string, string, string];

		if (ssid == null || ssid === "") continue;

		const hwAddr = wifiDeviceListGetHwAddr(device);
		if (!hwAddr) continue;

		const wifiInterface = wifiIfs[hwAddr];
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
function wifiScheduleScanUpdates() {
	setTimeout(wifiUpdateScanResult, 1000);
	setTimeout(wifiUpdateScanResult, 3000);
	setTimeout(wifiUpdateScanResult, 5000);
	setTimeout(wifiUpdateScanResult, 10000);
	setTimeout(wifiUpdateScanResult, 15000);
	setTimeout(wifiUpdateScanResult, 20000);
}

let unavailableDeviceRetryExpiry = 0;

export async function wifiUpdateDevices() {
	let newDevices = false;
	let statusChange = false;
	let unavailableDevices = false;

	const networkDevices = await nmDevices("device,type,state,con-uuid");
	if (!networkDevices) return;

	// sorts the results alphabetically by interface name
	networkDevices.sort();

	// mark all WiFi adapters as removed
	for (const wifiInterface of Object.values(wifiIfs)) {
		wifiInterface.removed = true;
	}

	// Rebuild the id-to-hwAddr map
	wifiIdToHwAddr = {};

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
				connUuid !== "" && wifiDeviceListGetInetAddr(ifname) ? connUuid : null;
			const hwAddr = wifiDeviceListGetHwAddr(ifname);
			if (!hwAddr) continue;

			const wifiInterface = wifiIfs[hwAddr];

			if (wifiInterface) {
				// the interface is still available
				wifiInterface.removed = undefined;

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

				const prop = (await nmDeviceProp(
					ifname,
					"GENERAL.VENDOR,GENERAL.PRODUCT,WIFI-PROPERTIES.AP,WIFI-PROPERTIES.5GHZ,WIFI-PROPERTIES.2GHZ",
				)) as [string, string, string, string, string];
				const vendor = prop[0].replace("Corporation", "").trim();
				const pb = prop[1].match(/[\[(](.+)[\])]/);
				const product = pb ? pb[1] : prop[1];

				const newInterface = {
					id,
					ifname,
					hw: `${vendor} ${product}`,
					conn,
					available: new Map(),
					saved: {},
				};

				if (prop[2] === "yes") {
					const hotspot: WifiHotspot = {
						forceHotspotStatus: 0,
						warnings: {},
						availableChannels: ["auto"],
					};
					if (prop[3] === "yes") {
						hotspot.availableChannels.push("auto_50");
					}
					if (prop[4] === "yes") {
						hotspot.availableChannels.push("auto_24");
					}
					(newInterface as WifiInterfaceWithHotspot).hotspot = hotspot;
				}
				newDevices = true;
				statusChange = true;
				wifiIfs[hwAddr] = newInterface;
			}

			const updatedInterface = wifiIfs[hwAddr];
			if (updatedInterface) {
				wifiIdToHwAddr[updatedInterface.id] = hwAddr;
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
	for (const i in wifiIfs) {
		const wifiInterface = wifiIfs[i];
		if (wifiInterface?.removed) {
			delete wifiIfs[i];
			statusChange = true;
		}
	}

	if (newDevices) {
		await wifiUpdateSavedConns();
		wifiScheduleScanUpdates();
	}

	if (statusChange) {
		await wifiUpdateScanResult();
		wifiScheduleScanUpdates();
	}
	if (newDevices || statusChange) {
		wifiBroadcastState();

		// Mark any WiFi hotspot interfaces as unavailable for bonding
		let hotspotCount = 0;
		const netif = getNetworkInterfaces();
		for (const i in wifiIfs) {
			const wifiInterface = wifiIfs[i];
			if (wifiInterface && isHotspot(wifiInterface)) {
				const n = netif[wifiInterface.ifname];
				if (!n) continue;
				if (n.error & NETIF_ERR_HOTSPOT) continue;

				setNetifHotspot(n);
				hotspotCount++;
			}
		}
		if (hotspotCount && getIsStreaming()) {
			updateSrtlaIps();
		}
	}
	logger.debug("Wifi interfaces", wifiIfs);

	updateMoblinkRelayInterfaces();

	/* If some wifi adapters were marked unavailable, recheck periodically
     This might happen when the system has just booted up and the adapter
     typically becomes available within 30 seconds.
     Uses a 5 minute timeout to avoid polling nmcli forever */
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

async function wifiRescan() {
	await nmRescan();

	/* A rescan request will fail if a previous one is in progress,
     but we still attempt to update the results */
	await wifiUpdateScanResult();
	wifiScheduleScanUpdates();
}

/* Searches saved connections in wifiIfs by UUID */
function wifiSearchConnection(uuid: string) {
	let connFound: string | undefined;
	for (const i in wifiIdToHwAddr) {
		const macAddr = wifiIdToHwAddr[i];
		if (!macAddr) continue;

		const wifiInterface = wifiIfs[macAddr];
		if (!wifiInterface) continue;

		for (const s in wifiInterface.saved) {
			if (wifiInterface.saved[s] === uuid) {
				connFound = i;
				break;
			}
		}
	}

	return connFound;
}

async function wifiDisconnect(uuid: string) {
	if (wifiSearchConnection(uuid) === undefined) return;

	if (await nmDisconnect(uuid)) {
		await wifiUpdateScanResult();
		wifiScheduleScanUpdates();
	}
}

async function wifiForget(uuid: string) {
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

	const mac = wifiIdToHwAddr[msg.device];
	if (!mac) return;

	const wifiInterface = wifiIfs[mac];
	if (!wifiInterface) return;

	const device = wifiInterface.ifname;

	const args = [
		"-w",
		"15",
		"device",
		"wifi",
		"connect",
		msg.ssid,
		"ifname",
		device,
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
					if (!(await nmConnSetWifiMac(uuid, mac))) {
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

async function wifiConnect(conn: WebSocket, uuid: string) {
	const deviceId = wifiSearchConnection(uuid);
	if (deviceId === undefined) return;

	const senderId = getSocketSenderId(conn);
	const success = await nmConnect(uuid);
	await wifiUpdateScanResult();
	conn.send(buildMsg("wifi", { connect: success, device: deviceId }, senderId));
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

const HOTSPOT_UP_TO = 10;
const HOTSPOT_UP_FORCE_TO = (HOTSPOT_UP_TO + 2) * 1000;

async function wifiHotspotStart(
	msg: NonNullable<WifiHotspotMessage["hotspot"]["start"]>,
) {
	if (!msg.device) return;

	const mac = wifiIdToHwAddr[msg.device];
	if (!mac) return;

	const wifiInterface = wifiIfs[mac];
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
		const ms = mac.split(":");
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
				"connection.interface-name": "",
				"connection.autoconnect": "yes",
				"connection.autoconnect-priority": "999",
				"802-11-wireless.mac-address": mac,
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

async function wifiHotspotStop(
	msg: NonNullable<WifiHotspotMessage["hotspot"]["stop"]>,
) {
	if (!msg.device) return;

	const mac = wifiIdToHwAddr[msg.device];
	if (!mac) return;

	const i = wifiIfs[mac];
	if (!i) return;
	if (!isHotspot(i)) return; // not in hotspot mode, nothing to do

	if (!i.hotspot.conn) return;

	await nmConnSetFields(i.hotspot.conn, { "connection.autoconnect": "no" });

	wifiForceHotspot(i, -1);
	if (await nmDisconnect(i.hotspot.conn)) {
		i.conn = null;
		i.available.clear();
		wifiBroadcastState();
		wifiRescan();
	}
}

function canHotspot(
	wifiInterface: WifiInterface,
): wifiInterface is WifiInterfaceWithHotspot {
	return wifiInterface && "hotspot" in wifiInterface;
}

function isHotspot(
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
	if (newChannel.nmBand === "") {
		// @ts-ignore
		// biome-ignore lint/performance/noDelete: see comment above
		delete settingsToChange["802-11-wireless.band"];
	}

	// FIXME: This should be an empty string for auto but bun currently drops empty arguments
	//      see https://github.com/oven-sh/bun/pull/17269
	if (newChannel.nmChannel === "") {
		// @ts-ignore
		// biome-ignore lint/performance/noDelete: see comment above
		delete settingsToChange["802-11-wireless.channel"];
	}

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

/*
  Expects:
  {
    device: device id,
    name,
    password,
    channel  // from wifiChannels
  }
*/
async function wifiHotspotConfig(
	conn: WebSocket,
	msg: NonNullable<WifiHotspotMessage["hotspot"]["config"]>,
) {
	// Find the Wifi interface
	if (!msg.device) return;

	const mac = wifiIdToHwAddr[msg.device];
	if (!mac) return;

	const i = wifiIfs[mac];
	if (!i) return;
	if (!isHotspot(i)) return; // Make sure the interface is already in hotspot mode

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
		i.hotspot.conn &&
		!(await nmConnSetHotspotFields(
			i.hotspot.conn,
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
	wifiForceHotspot(i, HOTSPOT_UP_FORCE_TO);

	if (
		isHotspotConfigComplete(i) &&
		!(await nmConnect(i.hotspot.conn, HOTSPOT_UP_TO))
	) {
		conn.send(
			buildMsg(
				"wifi",
				{ hotspot: { config: { device: msg.device, error: "activating" } } },
				senderId,
			),
		);

		// Failed to bring up the hotspot with the new settings; restore it
		wifiForceHotspot(i, HOTSPOT_UP_FORCE_TO);

		await nmConnSetHotspotFields(
			i.hotspot.conn,
			i.hotspot.name,
			i.hotspot.password,
			i.hotspot.channel,
		);

		await nmConnect(i.hotspot.conn, HOTSPOT_UP_TO);

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
