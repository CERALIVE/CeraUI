/*
    CeraUI - web UI for the CERALIVE project
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

/* Network interface list */
import { EventEmitter } from "node:events";
import type WebSocket from "ws";

import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { ACTIVE_TO } from "../../helpers/shared.ts";
import { getms } from "../../helpers/time.ts";
import { getMockState, shouldUseMocks } from "../../mocks/mock-service.ts";
import {
	getMockIfconfigOutput,
	shouldMockNetwork,
} from "../../mocks/providers/network.ts";
import { updateBcrptSourceIps } from "../streaming/bcrpt.ts";

import {
	notificationBroadcast,
	notificationRemove,
	notificationSend,
} from "../ui/notifications.ts";
import { broadcastMsg, buildMsg } from "../ui/websocket-server.ts";
import {
	wifiDeviceListAdd,
	wifiDeviceListEndUpdate,
	wifiDeviceListStartUpdate,
} from "../wifi/wifi-device-list.ts";
import { wifiUpdateDevices } from "../wifi/wifi-interfaces.ts";
import { onNetifChange, setNetifState } from "./state/netif-state.ts";
import type { MonitorEvent, NetifState } from "./state-types.ts";

export type NetworkInterface = {
	ip?: string;
	netmask?: string;
	tp: number;
	txb: number;
	enabled: boolean;
	error: number;
};

export type NetworkInterfaceMessage = {
	netif: {
		name: string;
		ip: string;
		enabled: boolean | unknown;
	};
};

export const NETIF_ERR_DUPIPV4 = 0x01;
export const NETIF_ERR_HOTSPOT = 0x02;

let netif: Record<string, NetworkInterface> = {};

// Interfaces excluded from dup-IPv4 detection during a station<->hotspot
// transition: a lingering station lease can transiently share an IP as the
// hotspot comes up, which would fire a false-alarm netif_dup_ip notification.
const dupIpSuppressedIfaces = new Set<string>();

export function setNetifDupIpSuppression(ifname: string, suppressed: boolean) {
	if (suppressed) {
		dupIpSuppressedIfaces.add(ifname);
	} else {
		dupIpSuppressedIfaces.delete(ifname);
	}
}

const networkInterfacesEventEmitter = new EventEmitter();

// Reduced-cadence backstop poll: events are the primary driver now, this only
// refreshes throughput + confirms IP after an event. The old 1s interval is gone.
const NETIF_POLL_INTERVAL_MS = 5000;

// Mirror legacy `netif` into the NetifState cache (mapping `enabled`→`up`).
// setNetifState fires onNetifChange only on a real diff → that callback is the
// sole broadcaster, so identical snapshots produce no `netif` broadcast.
function syncNetifState(): void {
	const next: NetifState = {};
	for (const name in netif) {
		const i = netif[name];
		if (!i) continue;
		next[name] = {
			ip: i.ip,
			up: i.enabled,
			tp: i.tp,
			txb: i.txb,
			error: i.error,
		};
	}
	setNetifState(next);
}

export function triggerNetworkInterfacesChange() {
	// Reconcile + broadcast on any state mutation (poll, UI toggle, hotspot
	// marking) — broadcast fires only when the diff is non-empty.
	syncNetifState();
	networkInterfacesEventEmitter.emit("change");
}

function isNetifUpState(state: string): boolean {
	const s = state.toLowerCase();
	return s === "up" || s.startsWith("connected");
}

function isNetifDownState(state: string): boolean {
	const s = state.toLowerCase();
	return (
		s === "down" ||
		s === "disconnected" ||
		s === "unavailable" ||
		s === "unmanaged" ||
		s.startsWith("deactivat")
	);
}

/**
 * Primary event-driven driver: react to a monitor `device-state` event by
 * adding (link up) or removing (link down) the interface in the legacy `netif`
 * map, then reconcile+broadcast. IP/throughput are NOT carried by the event —
 * the retained slow poll confirms the IP and refreshes throughput afterwards.
 * Other event kinds (connection-state / modem-*) are ignored here.
 */
export function handleNetifMonitorEvent(event: MonitorEvent): void {
	if (event.type !== "device-state") return;

	const name = event.device;
	if (name === "lo" || name.match("^docker") || name.match("^l4tbr")) return;

	let mutated = false;
	if (isNetifUpState(event.state)) {
		if (!netif[name]) {
			// New running interface; IP/throughput get filled in by the next poll.
			netif[name] = { tp: 0, txb: 0, enabled: true, error: 0 };
			mutated = true;
		}
	} else if (isNetifDownState(event.state)) {
		if (netif[name]) {
			delete netif[name];
			mutated = true;
		}
	}

	if (mutated) {
		triggerNetworkInterfacesChange();
	}
}

export function onNetworkInterfacesChange(callback: () => void) {
	networkInterfacesEventEmitter.on("change", callback);

	return () => {
		networkInterfacesEventEmitter.off("change", callback);
	};
}

export function getNetworkInterfaces() {
	return netif;
}

function broadcastNetif(): void {
	broadcastMsg("netif", netIfBuildMsg(), getms() - ACTIVE_TO);
}

export function initNetworkInterfaceMonitoring() {
	onNetifChange(broadcastNetif);
	updateNetif();
	setInterval(updateNetif, NETIF_POLL_INTERVAL_MS);
}

export function updateNetif() {
	// Use mock data in development mode
	if (shouldMockNetwork()) {
		const mockOutput = getMockIfconfigOutput();
		processIfconfigOutput(mockOutput);
		return;
	}

	run("ifconfig", [])
		.then(processIfconfigOutput)
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Error getting ifconfig: ${message}`);
		});
}

export function processIfconfigOutput(stdout: string) {
	let intsChanged = false;
	const newInterfaces: Record<string, NetworkInterface> = {};

	wifiDeviceListStartUpdate();

	const interfaces = stdout.split("\n\n");

	for (const int of interfaces) {
		try {
			const name = int.split(":")[0] ?? "";

			if (name === "lo" || name.match("^docker") || name.match("^l4tbr"))
				continue;

			const inetAddrMatch = int.match(/inet (\d+\.\d+\.\d+\.\d+)/);
			const inetAddr = inetAddrMatch?.[1];

			const netmaskMatch = int.match(/netmask (\d+\.\d+\.\d+\.\d+)/);
			const netmask = netmaskMatch?.[1];

			const flags = (int.match(/flags=\d+<([A-Z,]+)>/)?.[1] ?? "").split(",");
			const isRunning = flags.includes("RUNNING");

			// update the list of WiFi devices
			if (name?.match("^wlan")) {
				const hwAddr = int.match(/ether ([0-9a-f:]+)/);
				if (hwAddr?.[1]) {
					wifiDeviceListAdd(name, hwAddr[1], isRunning ? inetAddr : null);
				}
			}

			if (!isRunning) continue;

			const txBytesMatch = int.match(/TX packets \d+ {2}bytes \d+/);
			const txBytes = Number.parseInt(
				(txBytesMatch?.[0] ?? "").split(" ").pop() ?? "0",
				10,
			);

			let tp = 0;
			if (netif[name]) {
				tp = txBytes - netif[name].txb;
			}

			const enabled = !netif[name] || netif[name].enabled;
			const error = netif[name] ? netif[name].error : 0;
			newInterfaces[name] = {
				ip: inetAddr,
				netmask,
				txb: txBytes,
				tp,
				enabled,
				error,
			};

			// Detect interfaces that are new or with a different address
			if (!netif[name] || netif[name].ip !== inetAddr) {
				intsChanged = true;
			}
		} catch (err) {
			logger.error(`Error parsing ifconfig: ${err}`);
		}
	}

	// Detect removed interfaces
	for (const i in netif) {
		if (!newInterfaces[i]) {
			intsChanged = true;
		}
	}

	if (intsChanged) {
		const intAddrs: Record<string, string | Array<string>> = {};

		// Detect duplicate IP adddresses and set error status
		for (const i in newInterfaces) {
			const newInterface = newInterfaces[i];
			if (!newInterface?.ip) continue;

			clearNetifDup(newInterface);
			if (dupIpSuppressedIfaces.has(i)) continue;
			const currentValue = intAddrs[newInterface.ip];

			if (currentValue === undefined) {
				intAddrs[newInterface.ip] = i;
			} else {
				if (Array.isArray(currentValue)) {
					currentValue.push(i);
				} else {
					setNetifDup(newInterfaces[currentValue]);
					intAddrs[newInterface.ip] = [currentValue, i];
				}
				setNetifDup(newInterface);
			}
		}

		// Send out an error message for duplicate IP addresses
		let msg = "";
		for (const d in intAddrs) {
			if (Array.isArray(intAddrs[d])) {
				if (msg !== "") {
					msg += "; ";
				}
				msg += `Interfaces ${intAddrs[d].join(", ")} can't be used because they share the same IP address: ${d}`;
			}
		}

		if (msg === "") {
			notificationRemove("netif_dup_ip");
		} else {
			notificationBroadcast("netif_dup_ip", "error", msg, 0, true, true);
		}
	}

	if (wifiDeviceListEndUpdate()) {
		logger.info("updated wifi devices");
		// a delay seems to be needed before NM registers new devices
		setTimeout(wifiUpdateDevices, 1000);
	}

	netif = newInterfaces;

	if (intsChanged) {
		triggerNetworkInterfacesChange();
		void updateBcrptSourceIps();
	}

	// Reconcile + broadcast (covers throughput-only deltas too); no-op when the
	// snapshot is unchanged, replacing the old unconditional per-tick broadcast.
	syncNetifState();
}

// The order is deliberate, we want *hotspot* to have higher priority
const netIfErrors = {
	2: "WiFi hotspot",
	1: "duplicate IPv4 addr",
} as const;

function setNetifError(int: NetworkInterface | undefined, err: number) {
	if (!int) return;

	int.enabled = false;
	int.error |= err;
}

function clearNetifError(int: NetworkInterface | undefined, err: number) {
	if (!int) return;
	int.error &= ~err;
}

function setNetifDup(int: NetworkInterface | undefined) {
	setNetifError(int, NETIF_ERR_DUPIPV4);
}

function clearNetifDup(int: NetworkInterface | undefined) {
	clearNetifError(int, NETIF_ERR_DUPIPV4);
}

export function setNetifHotspot(int: NetworkInterface | undefined) {
	setNetifError(int, NETIF_ERR_HOTSPOT);
}

const isValidNetworkInterfaceErrorCode = (
	e: number,
): e is keyof typeof netIfErrors => e in netIfErrors;

export function getNetifErrorMsg(i: NetworkInterface) {
	if (i.error === 0) return;

	for (const e in netIfErrors) {
		const errorCode = Number.parseInt(e, 10);
		if (i.error & errorCode && isValidNetworkInterfaceErrorCode(errorCode))
			return netIfErrors[errorCode];
	}
}

type NetworkInterfaceResponseMessage = {
	[key: string]: Pick<NetworkInterface, "ip" | "tp" | "enabled"> & {
		error?: string;
	};
};

export function netIfBuildMsg() {
	const m: NetworkInterfaceResponseMessage = {};
	// ifconfig text cannot express the software `enabled` flag, so in dev the
	// read-back overlays enabled/ip from MockState (written by configure).
	const mockConfigs = shouldUseMocks()
		? getMockState().netifConfigs
		: undefined;
	for (const i in netif) {
		const networkInterface = netif[i];
		if (!networkInterface) continue;

		m[i] = {
			ip: networkInterface.ip,
			tp: networkInterface.tp,
			enabled: networkInterface.enabled,
		};

		const mockConfig = mockConfigs?.get(i);
		if (mockConfig) {
			m[i].enabled = mockConfig.enabled;
			if (mockConfig.ip !== undefined) m[i].ip = mockConfig.ip;
		}

		const error = getNetifErrorMsg(networkInterface);
		if (error) {
			m[i].error = error;
		}
	}
	return m;
}

function countActiveNetif() {
	let count = 0;
	for (const int in netif) {
		if (netif[int]?.enabled) count++;
	}
	return count;
}

export function handleNetif(
	conn: WebSocket,
	msg: NetworkInterfaceMessage["netif"],
) {
	const int = netif[msg.name];
	if (!int) return;

	if (int.ip !== msg.ip) return;

	if (msg.enabled === true || msg.enabled === false) {
		if (msg.enabled) {
			const err = getNetifErrorMsg(int);
			if (err) {
				notificationSend(
					conn,
					"netif_enable_error",
					"error",
					`Can't enable ${msg.name}: ${err}`,
					10,
				);
				return;
			}
		} else {
			if (int.enabled && countActiveNetif() === 1) {
				notificationSend(
					conn,
					"netif_disable_all",
					"error",
					"Can't disable all networks",
					10,
				);
				return;
			}
		}

		int.enabled = msg.enabled;
		triggerNetworkInterfacesChange();
	}

	conn.send(buildMsg("netif", netIfBuildMsg()));
}
