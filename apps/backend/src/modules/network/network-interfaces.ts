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
	type DongleMarker,
	getDongleMarker,
	getDongleRecords,
	refreshDongleMetadata,
} from "./dongle-metadata.ts";
import {
	getPolicyRouteVerdict,
	refreshPolicyRouteFlags,
} from "./policy-route-check.ts";
import { refreshRouterCellularAdmin } from "./router-cellular-admin.ts";
import {
	getModemNetMarker,
	getRouterCellularMarker,
	getRouterCellularMarkers,
	type RouterCellularMarker,
	refreshUsbNetMarkers,
	type UsbModemNetMarker,
} from "./router-cellular-scan.ts";
import { onNetifChange, setNetifState } from "./state/netif-state.ts";
import type { MonitorEvent, NetifState } from "./state-types.ts";

export type NetworkInterface = {
	ip?: string;
	netmask?: string;
	tp: number;
	txb: number;
	rxb: number;
	/** Clock reading of the sample that produced `txb`/`rxb`; absent until sampled. */
	sampledAt?: number;
	/** Measured interface throughput in BITS per second over the last window. */
	tx_bps?: number;
	rx_bps?: number;
	enabled: boolean;
	error: number;
	same_subnet_group?: string;
};

/**
 * Throughput in bits/second between two byte-counter samples.
 *
 * Returns 0 when there is no baseline, no elapsed time, or the counter went
 * backwards (interface bounce / 32-bit wrap) — a wrap must read as idle, never
 * as a multi-gigabit spike.
 */
export function computeInterfaceRate(
	currentBytes: number,
	previousBytes: number | undefined,
	elapsedMs: number,
): number {
	if (previousBytes === undefined) return 0;
	if (!Number.isFinite(currentBytes) || !Number.isFinite(previousBytes))
		return 0;
	if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
	const delta = currentBytes - previousBytes;
	if (delta <= 0) return 0;
	return Math.round((delta * 8 * 1000) / elapsedMs);
}

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

/*
  THE DUPLICATE-IP POLICY SPLIT.

  `NETIF_ERR_DUPIPV4` used to answer two different questions with one bit:
  "may this interface be used as a generic source-IP" and "may it join the bond".
  Those have OPPOSITE correct answers once a bind-map exists.

  The first stays NO, and must: an operation that steers by SOURCE ADDRESS —
  the Internet connectivity probe, a route lookup — genuinely cannot tell two
  interfaces holding `192.168.8.100` apart, so binding to that address picks one
  of them arbitrarily. That is measured, not theoretical: the bench's two HiLink
  twins ship ONE factory MAC and both lease the same address.

  The second becomes YES whenever the writer can publish a MAPPING ROW for the
  interface, because the row names the interface as well as the address and the
  sender binds the socket with `SO_BINDTODEVICE` — the twins stop being
  indistinguishable the moment egress is pinned by device rather than by address.
  Two identical lines in `BIND_IPS_FILE` are LEGAL and are exactly what the
  positional sidecar disambiguates.

  So the flag stays raised (the operator still sees the warning band, and the
  probe rules still refuse it), and bond membership asks a separate question.
  `enabled` still governs membership — but a dup-IP interface's `enabled` is
  forced false by the flag itself, so the operator's own choice is tracked apart
  from it here rather than being read out of a bit the error path overwrites.
*/
const operatorBondOptOut = new Set<string>();

export function resetBondOptOut(): void {
	operatorBondOptOut.clear();
}

export function setBondOptOut(ifname: string, optOut: boolean): void {
	if (optOut) operatorBondOptOut.add(ifname);
	else operatorBondOptOut.delete(ifname);
}

export function isDupIpOnly(int: NetworkInterface): boolean {
	return int.error === NETIF_ERR_DUPIPV4;
}

/**
 * May this interface be offered to the bond?
 *
 * A duplicate-IP interface is offered — the caller still has to prove it can
 * publish a mapping row for it, which is what actually makes it usable. Any
 * OTHER error (a hotspot radio) disqualifies it outright, and an operator who
 * toggled the link out of the bond is honoured in both cases.
 */
export function isBondCandidate(name: string, int: NetworkInterface): boolean {
	if (!int.ip) return false;
	if ((int.error & ~NETIF_ERR_DUPIPV4) !== 0) return false;
	if (operatorBondOptOut.has(name)) return false;
	if (isDupIpOnly(int)) return true;
	return int.enabled;
}

const networkInterfacesEventEmitter = new EventEmitter();

// Reduced-cadence backstop poll: events are the primary driver now, this only
// refreshes throughput + confirms IP after an event. The old 1s interval is gone.
const NETIF_POLL_INTERVAL_MS = 5000;
const ROUTER_ADMIN_POLL_INTERVAL_MS = 30_000;

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

// `updateGwQueue` (gateways.ts) is ONE-SHOT: it is cleared after a successful
// election and the periodic caller then exits forever, so a default route lost
// afterwards is never re-elected. Re-queueing on every topology edge — an
// interface appearing or disappearing, and a dongle's up/gated transition — is
// what makes default-route recovery ONGOING rather than boot-only.
//
// The hook is INSTALLED BY `initNetworkInterfaceMonitoring`, not statically
// imported: `gateways.ts` imports this module, so a static edge back would
// cycle, and an unwired default keeps a test that only drives the parser from
// dialing real DNS through `updateGw`.
let queueUpdateGwHook: (() => void) | null = null;

/** Install (or clear, with `null`) the gateway re-election hook. */
export function setQueueUpdateGwHook(fn: (() => void) | null): void {
	queueUpdateGwHook = fn;
}

function notifyTopologyChange(): void {
	if (!queueUpdateGwHook) return;
	try {
		queueUpdateGwHook();
	} catch (err) {
		logger.debug(`queueUpdateGw hook failed: ${err}`);
	}
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
			netif[name] = { tp: 0, txb: 0, rxb: 0, enabled: true, error: 0 };
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
		notifyTopologyChange();
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

/**
 * Poll the dongle runtime metadata on the netif cadence.
 *
 * A dongle's state changes WITHOUT the live `netif` map changing (a gated veth
 * is not RUNNING, so it never enters that map at all), which means
 * `triggerNetworkInterfacesChange`'s diff can never see it. On a real edge this
 * therefore broadcasts directly, and re-queues gateway election because an
 * `up`/gated transition changes which interfaces can carry a default route.
 */
async function refreshDongleState(): Promise<void> {
	try {
		if (!(await refreshDongleMetadata())) return;
		broadcastNetif();
		notifyTopologyChange();
	} catch (err) {
		logger.debug(`dongle metadata refresh degraded: ${err}`);
	}
}

export function initNetworkInterfaceMonitoring() {
	onNetifChange(broadcastNetif);
	updateNetif();
	setInterval(updateNetif, NETIF_POLL_INTERVAL_MS);
	void import("./gateways.ts")
		.then((m) => setQueueUpdateGwHook(() => m.queueUpdateGw()))
		.catch((err: unknown) => {
			logger.warn(`gateway re-election hook unavailable: ${err}`);
		});
	void refreshDongleState();
	setInterval(() => {
		void refreshDongleState();
	}, NETIF_POLL_INTERVAL_MS);
	// Policy-route self-check on the netif cadence: real-device only, cached, and
	// degrade-to-null internally — it never spawns in dev/mock, never blocks, and
	// never throws into this loop.
	void refreshPolicyRouteFlags(netif);
	setInterval(() => {
		void refreshPolicyRouteFlags(netif);
	}, NETIF_POLL_INTERVAL_MS);
	void refreshRouterCellularState();
	setInterval(() => {
		void refreshRouterCellularState();
	}, NETIF_POLL_INTERVAL_MS);
	void refreshRouterAdminState();
	setInterval(() => {
		void refreshRouterAdminState();
	}, ROUTER_ADMIN_POLL_INTERVAL_MS);
}

/**
 * The `modems` roster now contains a row per classified dongle, and that row is
 * derived from data this module owns — so a marker or address edge has to push
 * the roster too, or the Cellular section would sit up to a full modem poll
 * behind the Ethernet-side truth it was relocated from.
 *
 * Imported lazily to keep the dependency one-directional: `modem-wire-producer`
 * reads this module statically, so a static import back would close the cycle.
 */
async function broadcastModemRoster(): Promise<void> {
	try {
		const { broadcastModems } = await import("../modems/modem-status.ts");
		broadcastModems();
	} catch (err) {
		logger.debug(`modem roster rebroadcast degraded: ${err}`);
	}
}

/**
 * Read each classified dongle's own admin API on its OWN slow cadence.
 *
 * It is deliberately NOT on the 5 s netif cadence: this one spawns `curl`
 * against a device on the far side of a USB link, so it is the most expensive
 * probe in this module and the least urgent — a dongle's SIM state and firmware
 * name do not move between ticks.
 */
export async function refreshRouterAdminState(): Promise<void> {
	try {
		const targets = new Map<string, string>();
		for (const [ifname, marker] of getRouterCellularMarkers()) {
			targets.set(ifname, marker.vid_pid);
		}
		if (!(await refreshRouterCellularAdmin(targets))) return;
		await broadcastModemRoster();
	} catch (err) {
		logger.debug(`router-cellular admin refresh degraded: ${err}`);
	}
}

/**
 * Re-read the USB descriptors behind the live interfaces on the netif cadence.
 *
 * A classification edge is invisible to `triggerNetworkInterfacesChange`'s diff
 * — the netif map is byte-identical when a device merely re-enumerates into a
 * different composition — so a real edge broadcasts directly, exactly as the
 * dongle metadata refresh does.
 */
async function refreshRouterCellularState(): Promise<void> {
	try {
		if (!(await refreshUsbNetMarkers(Object.keys(netif)))) return;
		broadcastNetif();
		await broadcastModemRoster();
	} catch (err) {
		logger.debug(`router-cellular refresh degraded: ${err}`);
	}
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
	now: number = getms(),
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
			const rxBytesMatch = int.match(/RX packets \d+ {2}bytes \d+/);
			const rxBytes = Number.parseInt(
				(rxBytesMatch?.[0] ?? "").split(" ").pop() ?? "0",
				10,
			);

			const previous = netif[name];
			let tp = 0;
			if (previous) {
				tp = txBytes - previous.txb;
			}

			const elapsedMs =
				previous?.sampledAt !== undefined ? now - previous.sampledAt : 0;
			const txBps = computeInterfaceRate(txBytes, previous?.txb, elapsedMs);
			const rxBps = computeInterfaceRate(rxBytes, previous?.rxb, elapsedMs);

			const enabled = !previous || previous.enabled;
			const error = previous ? previous.error : 0;
			newInterfaces[name] = {
				...(inetAddr !== undefined ? { ip: inetAddr } : {}),
				...(netmask !== undefined ? { netmask } : {}),
				txb: txBytes,
				rxb: rxBytes,
				sampledAt: now,
				tx_bps: txBps,
				rx_bps: rxBps,
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
				// NOT "can't be used": since the (ip,iface) bind map exists these
				// links DO bond when a per-interface mapping is in force. What the
				// shared address really costs is every operation that steers by
				// source IP, which cannot tell the pair apart.
				msg += `Interfaces ${intAddrs[d].join(", ")} share the same IP address: ${d}. Checks that steer by address can't tell them apart; they can still be bonded when per-interface link mapping is active`;
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
		notifyTopologyChange();
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
		tx_bps?: number;
		rx_bps?: number;
		dongle?: DongleMarker | null;
		router_cellular?: RouterCellularMarker | null;
		usb_modem_net?: UsbModemNetMarker | null;
	};
};

// Interfaces that carried a dongle marker on the PREVIOUS projection. A name
// that drops out of this set gets exactly one `dongle: null` frame, which is
// what makes the marker retractable rather than a permanent latch.
let lastDongleMarked = new Set<string>();

/** Drop the retraction bookkeeping (test isolation). */
export function resetDongleMarkerTracking(): void {
	lastDongleMarked = new Set();
}

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
			...(networkInterface.tx_bps !== undefined
				? { tx_bps: networkInterface.tx_bps }
				: {}),
			...(networkInterface.rx_bps !== undefined
				? { rx_bps: networkInterface.rx_bps }
				: {}),
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

		const policyRouteVerdict = getPolicyRouteVerdict(i);
		if (policyRouteVerdict !== undefined) {
			entry.policy_route_missing = policyRouteVerdict;
		}
	}

	applyDongleProjection(m);
	applyRouterCellularProjection(m);
	applyModemNetProjection(m);
	return m;
}

// Interfaces that carried a router-cellular marker on the PREVIOUS projection,
// so a name that drops out gets exactly one `router_cellular: null` frame.
let lastRouterCellularMarked = new Set<string>();

/** Drop the retraction bookkeeping (test isolation). */
export function resetRouterCellularTracking(): void {
	lastRouterCellularMarked = new Set();
}

/**
 * Stamp the router-cellular marker onto the WIRE PROJECTION only.
 *
 * Unlike the dongle marker this NEVER unions a row in: the classification is a
 * statement about an interface the kernel already enumerated, so a device the
 * netif scan cannot see is a device this has nothing to say about. And unlike
 * the dongle marker its retraction is NOT the row's last frame — the interface
 * is still there, it merely stopped classifying (a mode switch, a replug that
 * re-enumerated it as an MM-managed modem), so the row must survive it.
 */
function applyRouterCellularProjection(
	m: NetworkInterfaceResponseMessage,
): void {
	const marked = new Set<string>();

	for (const name in m) {
		const entry = m[name];
		if (!entry) continue;
		const marker = getRouterCellularMarker(name);
		if (marker) {
			entry.router_cellular = marker;
			marked.add(name);
		} else if (lastRouterCellularMarked.has(name)) {
			entry.router_cellular = null;
		}
	}

	lastRouterCellularMarked = marked;
}

// Interfaces that carried a modem-net marker on the PREVIOUS projection, so a
// name that drops out gets exactly one `usb_modem_net: null` frame.
let lastModemNetMarked = new Set<string>();

/** Drop the retraction bookkeeping (test isolation). */
export function resetModemNetTracking(): void {
	lastModemNetMarked = new Set();
}

/**
 * Stamp the modem-data-function marker onto the WIRE PROJECTION only.
 *
 * Same rules as the router-cellular projection above, for the same reasons: it
 * never unions a row in, and its retraction keeps the row.
 */
function applyModemNetProjection(m: NetworkInterfaceResponseMessage): void {
	const marked = new Set<string>();

	for (const name in m) {
		const entry = m[name];
		if (!entry) continue;
		const marker = getModemNetMarker(name);
		if (marker) {
			entry.usb_modem_net = marker;
			marked.add(name);
		} else if (lastModemNetMarked.has(name)) {
			entry.usb_modem_net = null;
		}
	}

	lastModemNetMarked = marked;
}

/**
 * Stamp the dongle marker onto the WIRE PROJECTION only.
 *
 * Three things happen here and none of them touches the live `netif` map:
 *
 *  1. a live `dg<N>h` row gains its `{slot, state}` marker;
 *  2. an `acquiring`/`down` dongle — whose veth is administratively DOWN and
 *     address-less, so it is not RUNNING and never enters `netif` at all — is
 *     UNIONED in as a wire-only row with no `ip`, `enabled: false` and zero
 *     counters. `genSrtlaIpList` reads the live map's `enabled && ip`, so it is
 *     untouched by construction rather than by a filter someone could remove;
 *  3. any name marked on the previous projection but not on this one emits one
 *     final `dongle: null` frame, on its live row when it still has one and as a
 *     bare wire-only row when it does not.
 */
function applyDongleProjection(m: NetworkInterfaceResponseMessage): void {
	const marked = new Set<string>();

	for (const name in m) {
		const marker = getDongleMarker(name);
		const entry = m[name];
		if (!entry) continue;
		if (marker) {
			entry.dongle = marker;
			marked.add(name);
		} else if (lastDongleMarked.has(name)) {
			entry.dongle = null;
		}
	}

	for (const [veth, record] of getDongleRecords()) {
		if (m[veth]) continue;
		if (record.state === "up") continue;
		m[veth] = {
			tp: 0,
			enabled: false,
			tx_bps: 0,
			rx_bps: 0,
			dongle: { slot: record.slot, state: record.state },
		};
		marked.add(veth);
	}

	for (const name of lastDongleMarked) {
		if (marked.has(name) || m[name]) continue;
		m[name] = { tp: 0, enabled: false, dongle: null };
	}

	lastDongleMarked = marked;
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
		// A duplicate-IP link's `enabled` is forced false by the flag itself, so a
		// toggle on it can only be recorded as the operator's bond choice. The flag
		// (and its warning band) is deliberately left standing: the link is still
		// unusable for a generic source-IP operation, which is a different claim.
		if (isDupIpOnly(int)) {
			setBondOptOut(msg.name, !msg.enabled);
			triggerNetworkInterfacesChange();
			conn.send(buildMsg("netif", netIfBuildMsg()));
			return;
		}

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
		setBondOptOut(msg.name, !msg.enabled);
		triggerNetworkInterfacesChange();
	}

	conn.send(buildMsg("netif", netIfBuildMsg()));
}
