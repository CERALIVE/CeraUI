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
import { getms } from "../../helpers/time.ts";
import {
	getNetifTopologyGeneration,
	getNetworkInterfaceIncarnation,
	getNetworkInterfaces,
	NETIF_ERR_HOTSPOT,
	setNetifHotspot,
	triggerNetworkInterfacesChange,
} from "../network/network-interfaces.ts";
import {
	type ConnectionUUID,
	type MacAddress,
	nmConnGetFields,
	nmcliParseSep,
	nmDeviceProp,
	nmDevices,
} from "../network/network-manager.ts";
import {
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "../system/cli-parse.ts";
import { getDerivedApChannels, refreshHotspotChannels } from "./regdomain.ts";
import {
	broadcastWifiState,
	type WifiNetwork,
	wifiUpdateSavedConns,
} from "./wifi.ts";
import { notifyWifiAdapterModeDiscovery } from "./wifi-adapter-mode-events.ts";
import { supportsApStaConcurrency } from "./wifi-ap-sta-capability.ts";
import { refreshWifiCapabilities } from "./wifi-capabilities.ts";
import type { AutoWifiChannel } from "./wifi-channels.ts";
import {
	concurrentApIfname,
	ensureConcurrentApInterface,
	isConcurrentApIfname,
	isSupportedWifiIfname,
} from "./wifi-concurrent-interface.ts";
import {
	addWifiInterface,
	getWifiInterfaceByMacAddress,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
	resetWifiScanRefreshForTest,
	terminateWifiScanRefresh,
	wifiScheduleScanRefresh,
	wifiUpdateScanResult,
} from "./wifi-connections.ts";
import {
	wifiDeviceListGetInetAddress,
	wifiDeviceListGetMacAddress,
} from "./wifi-device-list.ts";
import { handleHotspotConn } from "./wifi-hotspot-discovery.ts";
import {
	canHotspot,
	isApMode,
	type WifiHotspot,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import {
	type RadioIdentity,
	recordWifiRadioShadowFailure,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import { wifiRadioObservation } from "./wifi-radio-observation.ts";
import {
	invalidateWifiRadioRow,
	notifyWifiRadioPublication,
	projectWifiRadioIncarnation,
} from "./wifi-radio-publication.ts";

export type SSID = string;
export type WifiInterfaceId = number;

export type WifiActiveMode = "ap" | "infrastructure" | "unknown";

export type WifiAdapterDegradedReason =
	| "unavailable"
	| "operational-mac-missing"
	| "permanent-mac-unresolved";

export type BaseWifiInterface = {
	id: WifiInterfaceId; // numeric id for the adapter - temporary for each CeraLive execution
	ifname: string;
	conn: ConnectionUUID | null; // the active connection, gated on the radio holding an IP
	/*
	  NM's active connection WITHOUT the `conn` IP gate. The gate is right for
	  bonding (a client link with no lease is unusable) but must never decide
	  AP-vs-client: a hotspot whose IP the ifconfig poll had not yet cached
	  collapsed to "station", rendering a broadcasting radio as
	  "Connected · <ssid>" with Connect/In-Bond controls one tick and
	  "Disconnected" the next.
	*/
	activeConn?: ConnectionUUID | null;
	activeMode?: WifiActiveMode;
	hw: string; // the name of the wifi adapter hardware
	available: Map<SSID, WifiNetwork>;
	saved: Record<SSID, ConnectionUUID>;
	/*
	  EVERY profile this adapter has for an SSID, not just the one `saved` names.
	  NetworkManager happily holds several — a CeraUI-created profile plus one an
	  image baked in, or two an operator made under different names — and `saved`
	  is keyed by SSID, so it can only ever surface ONE of them.

	  That is invisible until Forget: the operator forgets the network, exactly
	  one profile is deleted, the sibling keeps the SSID in this map, and the row
	  still reads "Saved". Board-observed on a Rock 5B+ (2026-08-19), where
	  `4G-UFI-611A` and `ufi-recovery` were two NM profiles for the ONE SSID
	  `4G-UFI-611A`: the delete succeeded and the UI was indistinguishable from a
	  Forget that had done nothing.

	  It stays OFF the wire. The frontend acts on one uuid and the schema is
	  unchanged; only `wifiForget` reads this, because only Forget means "remove
	  this network", where connect/disconnect mean "act on this connection".
	*/
	savedAll: Record<SSID, ConnectionUUID[]>;
	removed?: true;
	supportsApStaConcurrency?: boolean;
	concurrentHotspot?: {
		ifname: string;
		activeConn: ConnectionUUID | null;
	};
	degradedReason?: WifiAdapterDegradedReason;
};

export type WifiInterface = BaseWifiInterface | WifiInterfaceWithHotspot;

export type WifiDeviceProperties = {
	readonly hw: string;
	readonly supportsAp: boolean;
	readonly supports5Ghz: boolean;
	readonly supports2Ghz: boolean;
};

function parseNmcliBoolean(value: string | undefined): boolean | undefined {
	if (value === "yes") return true;
	if (value === "no") return false;
	return undefined;
}

export function parseWifiDeviceProperties(
	prop: readonly string[] | undefined,
): ParseResult<WifiDeviceProperties> {
	if (prop === undefined || prop.length < 5) {
		return parseFail(
			"parseWifiDeviceProperties",
			"expected 5 fields from nmcli device properties",
			JSON.stringify(prop ?? null),
		);
	}

	const [vendorRaw, productRaw, apRaw, fiveGhzRaw, twoGhzRaw] = prop;
	const supportsAp = parseNmcliBoolean(apRaw);
	const supports5Ghz = parseNmcliBoolean(fiveGhzRaw);
	const supports2Ghz = parseNmcliBoolean(twoGhzRaw);
	if (
		supportsAp === undefined ||
		supports5Ghz === undefined ||
		supports2Ghz === undefined
	) {
		return parseFail(
			"parseWifiDeviceProperties",
			"expected yes/no WiFi capability fields",
			JSON.stringify(prop),
		);
	}

	const vendor = (vendorRaw ?? "").replace("Corporation", "").trim();
	const productCandidate =
		productRaw?.match(/[[(](.+)[\])]/)?.[1] ?? productRaw;
	const product = productCandidate?.trim();
	if (!vendor || !product) {
		return parseFail(
			"parseWifiDeviceProperties",
			"missing vendor or product field",
			JSON.stringify(prop),
		);
	}

	return parseOk({
		hw: `${vendor} ${product}`,
		supportsAp,
		supports5Ghz,
		supports2Ghz,
	});
}

let wifiIdToMacAddress: Record<WifiInterfaceId, MacAddress> = {};

export function getWifiIdToMacAddress() {
	return wifiIdToMacAddress;
}

export function getMacAddressForWifiInterface(id: WifiInterfaceId) {
	return wifiIdToMacAddress[id];
}

let unavailableDeviceRetryExpiry = 0;
let wifiIfId = 0;
const wifiUpdateTimers = new Set<ReturnType<typeof setTimeout>>();
let discoveryController = new AbortController();
let wifiDeviceRefreshCompleted = false;
const classifiedWifiIfnames = new Map<string, number>();
const nonWifiIfnames = new Map<string, number>();

/** Only a completed device refresh can classify the current netif snapshot. */
export function wifiZonesReady(): boolean {
	for (const [name, incarnation] of nonWifiIfnames) {
		if (getNetworkInterfaceIncarnation(name) !== incarnation)
			nonWifiIfnames.delete(name);
	}
	const names = Object.keys(getNetworkInterfaces()).filter(
		(name) => isSupportedWifiIfname(name) && !nonWifiIfnames.has(name),
	);
	if (names.length === 0) return true;
	if (!wifiDeviceRefreshCompleted) return false;
	const wifi = Object.values(getWifiInterfacesByMacAddress());
	return names.every((ifname) => {
		const incarnation = getNetworkInterfaceIncarnation(ifname);
		return (
			incarnation !== undefined &&
			classifiedWifiIfnames.get(ifname) === incarnation &&
			wifi.some(
				(entry) =>
					entry.ifname === ifname &&
					!entry.removed &&
					(entry.activeConn === null ||
						entry.activeMode === "ap" ||
						entry.activeMode === "infrastructure"),
			)
		);
	});
}

export function scheduleWifiUpdate(delayMs: number): void {
	if (discoveryController.signal.aborted) return;
	const timer = setTimeout(() => {
		wifiUpdateTimers.delete(timer);
		void wifiUpdateDevices();
	}, delayMs).unref();
	wifiUpdateTimers.add(timer);
}

function cancelWifiUpdateTimers(): void {
	for (const timer of wifiUpdateTimers) clearTimeout(timer);
	wifiUpdateTimers.clear();
	unavailableDeviceRetryExpiry = 0;
}

export function stopWifiUpdateLoopForTest(): void {
	cancelWifiUpdateTimers();
}

export function resetWifiInterfaceDiscoveryForTest(): void {
	cancelWifiUpdateTimers();
	discoveryController.abort();
	discoveryController = new AbortController();
	resetWifiScanRefreshForTest();
	wifiIfId = 0;
	wifiDeviceRefreshCompleted = false;
	classifiedWifiIfnames.clear();
	nonWifiIfnames.clear();
}

export function recordDegradedWifiInterface(
	ifname: string,
	reason: WifiAdapterDegradedReason,
	registryKey?: string,
): WifiInterface {
	const entries = Object.entries(getWifiInterfacesByMacAddress());
	const previous =
		(registryKey === undefined
			? undefined
			: entries.find(([key]) => key === registryKey)) ??
		entries.find(([, wifiInterface]) => wifiInterface?.ifname === ifname);
	const existing = previous?.[1];
	if (
		existing &&
		(registryKey === undefined || registryKey === previous?.[0])
	) {
		delete existing.removed;
		existing.ifname = ifname;
		existing.degradedReason = reason;
		return existing;
	}
	if (previous) removeWifiInterface(previous[0]);
	const degraded: WifiInterface = {
		id: existing?.id ?? wifiIfId++,
		ifname,
		conn: null,
		hw: ifname,
		available: new Map(),
		saved: {},
		savedAll: {},
		degradedReason: reason,
	};
	addWifiInterface(registryKey ?? `degraded:${ifname}`, degraded);
	return degraded;
}

const connectionModeCache = new Map<ConnectionUUID, WifiActiveMode>();

export function resetWifiConnectionModeCache() {
	connectionModeCache.clear();
}

export function parseWifiConnectionMode(
	raw: string | undefined,
): WifiActiveMode {
	if (raw === "ap") return "ap";
	if (raw === "infrastructure") return "infrastructure";
	return "unknown";
}

// An `unknown` result is NOT cached: it means the nmcli read failed, and caching
// it would permanently pin an AP radio to the client-mode UI.
async function resolveConnectionMode(
	uuid: ConnectionUUID,
): Promise<WifiActiveMode> {
	const cached = connectionModeCache.get(uuid);
	if (cached !== undefined) return cached;

	const fields = await nmConnGetFields(uuid, ["802-11-wireless.mode"] as const);
	const mode = parseWifiConnectionMode(fields?.[0]);
	if (mode !== "unknown") connectionModeCache.set(uuid, mode);
	return mode;
}

async function syncActiveConnection(
	wifiInterface: WifiInterface,
	macAddress: MacAddress,
	activeConn: ConnectionUUID | null,
): Promise<boolean> {
	const previousConn = wifiInterface.activeConn ?? null;
	const previousMode = wifiInterface.activeMode;

	if (activeConn === null) {
		wifiInterface.activeConn = null;
		delete wifiInterface.activeMode;
		return previousConn !== null || previousMode !== undefined;
	}

	const mode = await resolveConnectionMode(activeConn);
	if (discoveryController.signal.aborted) return false;
	wifiInterface.activeConn = activeConn;
	wifiInterface.activeMode = mode;

	// NM is the authority on AP mode, so adopt the AP profile as this radio's
	// hotspot connection here rather than waiting on the saved-connection sweep
	// (which only runs when a NEW adapter appears).
	if (
		mode === "ap" &&
		wifiInterface.degradedReason !== "permanent-mac-unresolved" &&
		canHotspot(wifiInterface) &&
		wifiInterface.hotspot.conn !== activeConn
	) {
		await handleHotspotConn(macAddress, activeConn, { active: true });
	}

	return previousConn !== activeConn || previousMode !== mode;
}

let activeDiscovery: Promise<boolean | undefined> | undefined;
let queuedDiscovery:
	| ReturnType<typeof Promise.withResolvers<boolean | undefined>>
	| undefined;

function reconcileSampledWifiRegistry(): void {
	for (const [key, row] of Object.entries(getWifiInterfacesByMacAddress())) {
		const identity = wifiRadioIdentity.state.rows.get(row.ifname);
		if (identity?.row !== row) continue;
		if (key !== identity.key) {
			removeWifiInterface(key);
			addWifiInterface(identity.key, row);
			wifiIdToMacAddress[row.id] = identity.key;
		}
		if (identity.degradedReason === undefined) delete row.degradedReason;
		else row.degradedReason = identity.degradedReason;
	}
}

export function terminateWifiDiscovery(): void {
	discoveryController.abort();
	cancelWifiUpdateTimers();
	terminateWifiScanRefresh();
	// Undefined already means discovery produced no update; do not strand waiters.
	queuedDiscovery?.resolve(undefined);
	queuedDiscovery = undefined;
}

export function wifiUpdateDevices(): Promise<boolean | undefined> {
	if (discoveryController.signal.aborted) return Promise.resolve(undefined);
	if (activeDiscovery) {
		queuedDiscovery ??= Promise.withResolvers<boolean | undefined>();
		return queuedDiscovery.promise;
	}

	const run = discoverWifiDevices();
	activeDiscovery = run;
	const finish = () => {
		activeDiscovery = undefined;
		const queued = queuedDiscovery;
		queuedDiscovery = undefined;
		if (queued) wifiUpdateDevices().then(queued.resolve, queued.reject);
	};
	// A queued caller needs a read begun after its call, even if this run fails.
	void run.then(finish, finish);
	return run;
}

async function discoverWifiDevices() {
	wifiDeviceRefreshCompleted = false;
	classifiedWifiIfnames.clear();
	nonWifiIfnames.clear();
	let classificationComplete = true;
	const signal = discoveryController.signal;
	const wireBefore = new Map(
		Object.values(getWifiInterfacesByMacAddress()).map((row) => [
			row,
			projectWifiRadioIncarnation(
				row,
				wifiRadioIdentity.state.rows.get(row.ifname),
			),
		]),
	);
	let observation: number | undefined;
	try {
		wifiRadioObservation.stop();
		observation = wifiRadioIdentity.captureObservation();
	} catch {
		recordWifiRadioShadowFailure();
	}
	for (const row of Object.values(getWifiInterfacesByMacAddress())) {
		invalidateWifiRadioRow(row, observation);
	}
	let newDevices = false;
	let statusChange = false;
	let unavailableDevices = false;

	const topologyGeneration = getNetifTopologyGeneration();
	const networkDevices = await nmDevices("device,type,state,con-uuid");
	if (signal.aborted) return;
	if (topologyGeneration !== getNetifTopologyGeneration()) {
		scheduleWifiUpdate(0);
		return;
	}
	if (!networkDevices) {
		if (observation !== undefined) {
			try {
				wifiRadioObservation.enqueue(
					Object.values(getWifiInterfacesByMacAddress()).map((row) => ({
						ifname: row.ifname,
						row,
						...(row.degradedReason
							? { degradedReason: row.degradedReason }
							: {}),
					})),
					observation,
					reconcileSampledWifiRegistry,
				);
			} catch {
				recordWifiRadioShadowFailure();
			}
		}
		return;
	}

	// sorts the results alphabetically by interface name
	networkDevices.sort();

	if (observation !== undefined) {
		try {
			const sampled = await wifiRadioObservation.sample(
				networkDevices.flatMap((raw) => {
					const [ifname, type, state] = nmcliParseSep(raw);
					if (
						!ifname ||
						type !== "wifi" ||
						(!isSupportedWifiIfname(ifname) && !isConcurrentApIfname(ifname))
					)
						return [];
					const degradedReason: WifiAdapterDegradedReason | undefined =
						state === "unavailable"
							? "unavailable"
							: !wifiDeviceListGetMacAddress(ifname)
								? "operational-mac-missing"
								: undefined;
					return [{ ifname, ...(degradedReason ? { degradedReason } : {}) }];
				}),
				observation,
				reconcileSampledWifiRegistry,
			);
			if (!sampled) return;
		} catch {
			recordWifiRadioShadowFailure();
		}
	}
	if (signal.aborted) return;
	const identities =
		wifiRadioIdentity.publishedObservation === observation
			? wifiRadioIdentity.state.rows
			: new Map<string, RadioIdentity>();

	// mark all WiFi adapters as removed
	for (const wifiInterface of Object.values(getWifiInterfacesByMacAddress())) {
		invalidateWifiRadioRow(wifiInterface, observation);
		wifiInterface.removed = true;
	}

	// Rebuild the id to mac address map
	wifiIdToMacAddress = {};
	const seenIfnames: string[] = [];
	const concurrentDevices = new Map<string, ConnectionUUID | null>();

	for (const networkDevice of networkDevices) {
		try {
			const [ifname, type, state, connUuid] = nmcliParseSep(networkDevice) as [
				string,
				string,
				string,
				string,
			];

			if (type !== "wifi") {
				const incarnation = getNetworkInterfaceIncarnation(ifname);
				if (
					type &&
					type !== "unknown" &&
					incarnation !== undefined &&
					topologyGeneration === getNetifTopologyGeneration()
				)
					nonWifiIfnames.set(ifname, incarnation);
				continue;
			}
			if (isConcurrentApIfname(ifname)) {
				concurrentDevices.set(ifname, connUuid !== "" ? connUuid : null);
				continue;
			}
			if (!isSupportedWifiIfname(ifname)) continue;
			if (state === "unavailable") {
				classificationComplete = false;
				unavailableDevices = true;
				seenIfnames.push(ifname);
				const existed = Object.values(getWifiInterfacesByMacAddress()).some(
					(wifiInterface) => wifiInterface?.ifname === ifname,
				);
				const row = recordDegradedWifiInterface(
					ifname,
					"unavailable",
					identities.get(ifname)?.key ?? `degraded:${ifname}`,
				);
				row.conn = null;
				row.activeConn = null;
				delete row.activeMode;
				invalidateWifiRadioRow(row, observation);
				if (observation !== undefined)
					wifiRadioIdentity.associateRows([row], observation);
				if (existed) statusChange = true;
				else newDevices = true;
				continue;
			}

			const activeConn: ConnectionUUID | null =
				connUuid !== "" ? connUuid : null;
			const conn =
				activeConn !== null && wifiDeviceListGetInetAddress(ifname)
					? activeConn
					: null;
			const currentMac = wifiDeviceListGetMacAddress(ifname);
			if (!currentMac) {
				classificationComplete = false;
				seenIfnames.push(ifname);
				const existed = Object.values(getWifiInterfacesByMacAddress()).some(
					(wifiInterface) => wifiInterface?.ifname === ifname,
				);
				const row = recordDegradedWifiInterface(
					ifname,
					"operational-mac-missing",
					identities.get(ifname)?.key ?? `degraded:${ifname}`,
				);
				invalidateWifiRadioRow(row, observation);
				if (observation !== undefined)
					wifiRadioIdentity.associateRows([row], observation);
				if (existed) statusChange = true;
				else newDevices = true;
				continue;
			}

			seenIfnames.push(ifname);
			const identity = identities.get(ifname);
			const macAddress = identity?.key ?? `degraded:${ifname}`;
			const permanentMacResolved = identity?.classification === "verified";
			let recoveredId: WifiInterfaceId | undefined;
			for (const [key, candidate] of Object.entries(
				getWifiInterfacesByMacAddress(),
			)) {
				if (
					key !== macAddress &&
					candidate?.ifname === ifname &&
					candidate.degradedReason !== undefined
				) {
					recoveredId = candidate.id;
					removeWifiInterface(key);
					break;
				}
			}

			const wifiInterface = getWifiInterfaceByMacAddress(macAddress);

			if (wifiInterface) {
				invalidateWifiRadioRow(wifiInterface, observation);
				// the interface is still available
				delete wifiInterface.removed;
				if (permanentMacResolved) delete wifiInterface.degradedReason;
				else wifiInterface.degradedReason = "permanent-mac-unresolved";

				if (ifname !== wifiInterface.ifname) {
					wifiInterface.ifname = ifname;
					statusChange = true;
				}
				if (conn !== wifiInterface.conn) {
					wifiInterface.conn = conn;
					statusChange = true;
				}
			} else {
				const id = recoveredId ?? wifiIfId++;

				const parsedProps = parseWifiDeviceProperties(
					await nmDeviceProp(
						ifname,
						"GENERAL.VENDOR,GENERAL.PRODUCT,WIFI-PROPERTIES.AP,WIFI-PROPERTIES.5GHZ,WIFI-PROPERTIES.2GHZ",
					),
				);
				if (signal.aborted) return;
				if (!parsedProps.ok) {
					classificationComplete = false;
					logParseError(parsedProps);
					continue;
				}

				const newInterface: WifiInterface = {
					id,
					ifname,
					hw: parsedProps.value.hw,
					conn,
					available: new Map(),
					saved: {},
					savedAll: {},
					...(!permanentMacResolved
						? { degradedReason: "permanent-mac-unresolved" as const }
						: {}),
				};
				invalidateWifiRadioRow(newInterface, observation);

				if (parsedProps.value.supportsAp) {
					newInterface.supportsApStaConcurrency =
						await supportsApStaConcurrency(ifname);
					if (signal.aborted) return;
					if (newInterface.supportsApStaConcurrency && permanentMacResolved) {
						const concurrentInterface =
							await ensureConcurrentApInterface(ifname);
						if (signal.aborted) return;
						if (concurrentInterface === undefined) {
							newInterface.supportsApStaConcurrency = false;
						}
					}

					const bandCapability: AutoWifiChannel[] = ["auto"];
					if (parsedProps.value.supports5Ghz) bandCapability.push("auto_50");
					if (parsedProps.value.supports2Ghz) bandCapability.push("auto_24");

					const hotspot: WifiHotspot = {
						warnings: {},
						bandCapability,
						availableChannels: [...bandCapability],
					};
					// Fold in the concrete channels the kernel currently permits, and
					// retire any band its regulatory rules forbid initiating on.
					refreshHotspotChannels(hotspot, getDerivedApChannels());
					(newInterface as WifiInterfaceWithHotspot).hotspot = hotspot;
				}
				newDevices = true;
				statusChange = true;
				addWifiInterface(macAddress, newInterface);
			}

			const updatedInterface = getWifiInterfaceByMacAddress(macAddress);
			if (updatedInterface) {
				invalidateWifiRadioRow(updatedInterface, observation);
				wifiIdToMacAddress[updatedInterface.id] = macAddress;
				if (observation !== undefined)
					wifiRadioIdentity.associateRows([updatedInterface], observation);
				if (
					await syncActiveConnection(updatedInterface, macAddress, activeConn)
				) {
					statusChange = true;
				}
				const incarnation = getNetworkInterfaceIncarnation(ifname);
				if (
					incarnation !== undefined &&
					topologyGeneration === getNetifTopologyGeneration()
				)
					classifiedWifiIfnames.set(ifname, incarnation);
				if (
					activeConn !== null &&
					updatedInterface.activeMode !== "ap" &&
					updatedInterface.activeMode !== "infrastructure"
				)
					classificationComplete = false;
			}
		} catch (err) {
			classificationComplete = false;
			if (err instanceof Error) {
				logger.error(
					`Error getting the nmcli WiFi device information: ${err.message}`,
				);
			}
		}
		if (signal.aborted) return;
	}

	for (const wifiInterface of Object.values(getWifiInterfacesByMacAddress())) {
		if (wifiInterface?.supportsApStaConcurrency !== true) continue;
		const virtualIfname = concurrentApIfname(wifiInterface.ifname);
		if (!concurrentDevices.has(virtualIfname)) {
			if (wifiInterface.concurrentHotspot !== undefined) {
				delete wifiInterface.concurrentHotspot;
				statusChange = true;
			}
			continue;
		}

		const activeConn = concurrentDevices.get(virtualIfname) ?? null;
		if (
			activeConn &&
			wifiInterface.degradedReason !== "permanent-mac-unresolved" &&
			canHotspot(wifiInterface)
		) {
			await handleHotspotConn(undefined, activeConn, { active: true });
			if (signal.aborted) return;
		}
		const previous = wifiInterface.concurrentHotspot;
		wifiInterface.concurrentHotspot = { ifname: virtualIfname, activeConn };
		if (
			previous?.ifname !== virtualIfname ||
			previous.activeConn !== activeConn
		) {
			statusChange = true;
		}
	}

	// Fire-and-forget: the capability read is bounded and never throws, and the
	// wire builder serves whatever the last successful read produced.
	void refreshWifiCapabilities(seenIfnames);

	// delete removed adapters
	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const i in wifiInterfacesByMacAddress) {
		const wifiInterface = wifiInterfacesByMacAddress[i];
		if (wifiInterface?.removed) {
			removeWifiInterface(i);
			statusChange = true;
		}
	}

	if (newDevices) {
		await wifiUpdateSavedConns(signal);
		if (signal.aborted) return;
		wifiScheduleScanRefresh();
	}

	if (statusChange) {
		await wifiUpdateScanResult();
		if (signal.aborted) return;
		wifiScheduleScanRefresh();
	}

	if (newDevices || statusChange) {
		broadcastWifiState();

		// Mark any WiFi hotspot interfaces as unavailable for bonding
		let hotspotCount = 0;
		const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
		const networkInterfaces = getNetworkInterfaces();
		for (const i in wifiInterfacesByMacAddress) {
			const wifiInterface = wifiInterfacesByMacAddress[i];
			if (wifiInterface && isApMode(wifiInterface)) {
				const n = networkInterfaces[wifiInterface.ifname];
				if (!n) continue;
				if (n.error & NETIF_ERR_HOTSPOT) continue;

				setNetifHotspot(n);
				hotspotCount++;
			}
		}

		if (hotspotCount) {
			triggerNetworkInterfacesChange();
			// Remove hotspot IPs from the source IP address list for BCRPT
		}
	} else if (
		Object.values(getWifiInterfacesByMacAddress()).some(
			(row) =>
				wireBefore.get(row) !==
				projectWifiRadioIncarnation(
					row,
					wifiRadioIdentity.state.rows.get(row.ifname),
				),
		)
	) {
		notifyWifiRadioPublication();
	}
	if (signal.aborted) return;
	logger.debug("Wifi interfaces", wifiInterfacesByMacAddress);

	/* If some wifi adapters were marked unavailable, recheck periodically
     This might happen when the system has just booted up and the adapter
     typically becomes available within 30 seconds.
     Uses a timeout to avoid polling nmcli forever */
	if (unavailableDevices) {
		if (unavailableDeviceRetryExpiry === 0) {
			unavailableDeviceRetryExpiry = getms() + 5 * 60 * 1_000; // 5 minute timeout
			scheduleWifiUpdate(3_000);
			logger.warn(
				"One or more Wifi interfaces are unavailable. Will retry periodically for the next 5 minutes",
			);
		} else if (getms() < unavailableDeviceRetryExpiry) {
			scheduleWifiUpdate(3_000);
			logger.warn(
				"One or more Wifi interfaces are still unavailable. Retrying in 3 seconds...",
			);
		}
	} else {
		unavailableDeviceRetryExpiry = 0;
	}

	queueMicrotask(() => {
		void notifyWifiAdapterModeDiscovery();
	});
	wifiDeviceRefreshCompleted = classificationComplete;
	if (topologyGeneration !== getNetifTopologyGeneration())
		scheduleWifiUpdate(0);
	triggerNetworkInterfacesChange();
	return statusChange;
}
