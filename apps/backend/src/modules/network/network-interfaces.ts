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

import { ipToInt, isSameSubnet } from "../../helpers/ip-addresses.ts";
import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { ACTIVE_TO } from "../../helpers/shared.ts";
import { getms } from "../../helpers/time.ts";
import { getMockState, shouldUseMocks } from "../../mocks/mock-service.ts";
import {
	getMockIfconfigOutput,
	shouldMockNetwork,
} from "../../mocks/providers/network.ts";

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
import {
	isPolicyRouteMissing,
	refreshPolicyRouteFlags,
} from "./policy-route-check.ts";
import { onNetifChange, setNetifState } from "./state/netif-state.ts";
import type { MonitorEvent, NetifState } from "./state-types.ts";

export type NetworkInterface = {
	ip?: string;
	netmask?: string;
	tp: number;
	txb: number;
	enabled: boolean;
	error: number;
	same_subnet_group?: string;
};

export type NetworkInterfaceMessage = {
	netif: {
		name: string;
		ip: string;
		enabled: boolean | unknown;
	};
};

/** A chosen interface IPv4; `netmask` is a dotted quad, not a prefix length. */
export type IpAddrSelection = { ip: string; netmask: string };

type ScopedAddress = { ip: string; prefix: number; scope: string };

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
			...(i.ip !== undefined ? { ip: i.ip } : {}),
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
	// Policy-route self-check on the netif cadence: real-device only, cached, and
	// degrade-to-null internally — it never spawns in dev/mock, never blocks, and
	// never throws into this loop.
	void refreshPolicyRouteFlags(netif);
	setInterval(() => {
		void refreshPolicyRouteFlags(netif);
	}, NETIF_POLL_INTERVAL_MS);
}

export function updateNetif() {
	// Use mock data in development mode
	if (shouldMockNetwork()) {
		const mockOutput = getMockIfconfigOutput();
		processIfconfigOutput(mockOutput);
		return;
	}

	void refreshNetifFromOs();
}

// ifconfig (net-tools) reports only ONE IPv4 per interface, so on a link that
// carries both an RFC-3927 link-local (169.254/16) and a real DHCP lease it can
// surface the link-local as THE address. `ip -4 addr show` lists every address
// with a `scope`, letting us prefer the routable global-scope lease. ifconfig
// still drives throughput, RUNNING flags, and the WiFi device list; a missing or
// failing `ip` degrades to ifconfig-only (the prior single-address behavior).
async function resolveIpAddrOverrides(): Promise<
	Map<string, IpAddrSelection> | undefined
> {
	try {
		return parseIpAddrShow(await run("ip", ["-4", "addr", "show"]));
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.debug(`ip -4 addr show unavailable, using ifconfig IPs: ${message}`);
		return undefined;
	}
}

async function refreshNetifFromOs(): Promise<void> {
	try {
		const [ifconfigOut, ipOverrides] = await Promise.all([
			run("ifconfig", []),
			resolveIpAddrOverrides(),
		]);
		processIfconfigOutput(ifconfigOut, ipOverrides);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`Error getting ifconfig: ${message}`);
	}
}

export function processIfconfigOutput(
	stdout: string,
	ipOverrides?: Map<string, IpAddrSelection>,
) {
	let intsChanged = false;
	const newInterfaces: Record<string, NetworkInterface> = {};

	wifiDeviceListStartUpdate();

	const interfaces = stdout.split("\n\n");

	for (const int of interfaces) {
		try {
			const name = int.split(":")[0] ?? "";

			if (name === "lo" || name.match("^docker") || name.match("^l4tbr"))
				continue;

			// Prefer the scope-annotated `ip -4 addr` address (a routable global
			// lease over a link-local) when present; fall back to ifconfig's single
			// inet line otherwise.
			const ipOverride = ipOverrides?.get(name);

			const inetAddrMatch = int.match(/inet (\d+\.\d+\.\d+\.\d+)/);
			const inetAddr = ipOverride?.ip ?? inetAddrMatch?.[1];

			const netmaskMatch = int.match(/netmask (\d+\.\d+\.\d+\.\d+)/);
			const netmask = ipOverride?.netmask ?? netmaskMatch?.[1];

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
				...(inetAddr !== undefined ? { ip: inetAddr } : {}),
				...(netmask !== undefined ? { netmask } : {}),
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

		// Same-subnet detection (informational). Runs AFTER dup-IP so a hard
		// dup-IP pair (now flagged NETIF_ERR_DUPIPV4 → enabled=false) is skipped
		// and never also tagged as a same-subnet group.
		computeSameSubnetGroups(newInterfaces);
	}

	if (wifiDeviceListEndUpdate()) {
		logger.info("updated wifi devices");
		// a delay seems to be needed before NM registers new devices
		setTimeout(wifiUpdateDevices, 1000);
	}

	netif = newInterfaces;

	if (intsChanged) {
		triggerNetworkInterfacesChange();
	}

	// Reconcile + broadcast (covers throughput-only deltas too); no-op when the
	// snapshot is unchanged, replacing the old unconditional per-tick broadcast.
	syncNetifState();
}

function intToIp(int: number): string {
	return [
		(int >>> 24) & 0xff,
		(int >>> 16) & 0xff,
		(int >>> 8) & 0xff,
		int & 0xff,
	].join(".");
}

// An RFC-3927 link-local (169.254/16, iproute2 `scope link`) is a kernel/NM
// auto-assigned fallback; it must never outrank a real routable lease on a link
// that has both.
function isLinkLocalIpv4(ip: string, scope: string): boolean {
	return scope === "link" || ip.startsWith("169.254.");
}

// A global-scope routable lease wins; then any other non-link-local address;
// only as a last resort the link-local (parity with the old single-address read
// for a link that carries nothing else).
function selectPreferredAddress(
	addrs: ScopedAddress[],
): ScopedAddress | undefined {
	return (
		addrs.find(
			(a) => a.scope === "global" && !isLinkLocalIpv4(a.ip, a.scope),
		) ??
		addrs.find((a) => !isLinkLocalIpv4(a.ip, a.scope)) ??
		addrs[0]
	);
}

function prefixToNetmask(prefix: number): string {
	if (prefix <= 0) return "0.0.0.0";
	if (prefix >= 32) return "255.255.255.255";
	return intToIp((0xffffffff << (32 - prefix)) >>> 0);
}

/**
 * Parse `ip -4 addr show` into iface → chosen {ip, netmask}. `ip` lists EVERY
 * IPv4 per interface with its `scope`, so unlike single-address ifconfig we can
 * prefer the routable global lease over an RFC-3927 link-local when a link has
 * both — the fix for a board that would otherwise advertise its link-local.
 */
export function parseIpAddrShow(stdout: string): Map<string, IpAddrSelection> {
	const byIface = new Map<string, ScopedAddress[]>();
	let current: string | undefined;

	for (const line of stdout.split("\n")) {
		const header = line.match(/^\d+:\s+([^:@\s]+)/);
		if (header?.[1]) {
			current = header[1];
			continue;
		}
		if (current === undefined) continue;

		const addr = line.match(/^\s*inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)\b/);
		if (!addr?.[1] || !addr[2]) continue;
		const scope = line.match(/\bscope\s+(\S+)/)?.[1] ?? "global";

		const list = byIface.get(current) ?? [];
		list.push({ ip: addr[1], prefix: Number.parseInt(addr[2], 10), scope });
		byIface.set(current, list);
	}

	const selected = new Map<string, IpAddrSelection>();
	for (const [name, addrs] of byIface) {
		const chosen = selectPreferredAddress(addrs);
		if (chosen) {
			selected.set(name, {
				ip: chosen.ip,
				netmask: prefixToNetmask(chosen.prefix),
			});
		}
	}
	return selected;
}

function netmaskToPrefix(netmask: string): number {
	let bits = ipToInt(netmask);
	let count = 0;
	while (bits) {
		count += bits & 1;
		bits >>>= 1;
	}
	return count;
}

function subnetCidr(ip: string, netmask: string): string {
	const network = intToIp(ipToInt(ip) & ipToInt(netmask));
	return `${network}/${netmaskToPrefix(netmask)}`;
}

// The AP/hotspot interface is intentionally same-subnet with its DHCP clients,
// so it must never be grouped. It is identified by the existing hotspot markers:
// dup-IP suppression during the station→hotspot transition
// (wifi-hotspot-activation.ts) and the persistent NETIF_ERR_HOTSPOT flag once NM
// confirms hotspot mode (wifi-interfaces.ts).
function isApInterface(name: string, int: NetworkInterface): boolean {
	return (
		dupIpSuppressedIfaces.has(name) || (int.error & NETIF_ERR_HOTSPOT) !== 0
	);
}

// Tag every enabled interface that shares a subnet (same netmask, same network
// address) with another enabled interface on a DIFFERENT IP. Distinct from
// dup-IP: it is not an error (policy routing handles a bonded shared subnet).
// The AP/hotspot and dup-IP-flagged interfaces are excluded. n is tiny, so the
// O(n^2) pairwise scan is fine.
function computeSameSubnetGroups(
	interfaces: Record<string, NetworkInterface>,
): void {
	const candidates: Array<[string, NetworkInterface]> = [];
	for (const name in interfaces) {
		const int = interfaces[name];
		if (!int?.ip || !int.netmask) continue;
		if (!int.enabled) continue;
		if (int.error & NETIF_ERR_DUPIPV4) continue;
		if (isApInterface(name, int)) continue;
		candidates.push([name, int]);
	}

	for (let a = 0; a < candidates.length; a++) {
		const entryA = candidates[a];
		if (!entryA) continue;
		const [, intA] = entryA;
		const ipA = intA.ip;
		const maskA = intA.netmask;
		if (!ipA || !maskA) continue;
		for (let b = a + 1; b < candidates.length; b++) {
			const entryB = candidates[b];
			if (!entryB) continue;
			const [, intB] = entryB;
			const ipB = intB.ip;
			if (!ipB || intB.netmask !== maskA || ipA === ipB) continue;
			if (isSameSubnet(ipA, ipB, maskA)) {
				const cidr = subnetCidr(ipA, maskA);
				intA.same_subnet_group = cidr;
				intB.same_subnet_group = cidr;
			}
		}
	}
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
	return undefined;
}

type NetworkInterfaceResponseMessage = {
	[key: string]: Pick<NetworkInterface, "ip" | "tp" | "enabled"> & {
		error?: string;
		same_subnet_group?: string;
		policy_route_missing?: boolean;
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

		const entry: NetworkInterfaceResponseMessage[string] = {
			...(networkInterface.ip !== undefined ? { ip: networkInterface.ip } : {}),
			tp: networkInterface.tp,
			enabled: networkInterface.enabled,
		};
		m[i] = entry;

		const mockConfig = mockConfigs?.get(i);
		if (mockConfig) {
			entry.enabled = mockConfig.enabled;
			if (mockConfig.ip !== undefined) entry.ip = mockConfig.ip;
		}

		const error = getNetifErrorMsg(networkInterface);
		if (error) {
			entry.error = error;
		}

		if (networkInterface.same_subnet_group) {
			entry.same_subnet_group = networkInterface.same_subnet_group;
		}

		if (isPolicyRouteMissing(i)) {
			entry.policy_route_missing = true;
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
