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
import { getHotspotCredentials } from "./hotspot-credentials.ts";
import { getDerivedApChannels, refreshHotspotChannels } from "./regdomain.ts";
import {
	broadcastWifiState,
	type WifiNetwork,
	wifiUpdateSavedConns,
} from "./wifi.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
	withWifiAdapterLocks,
} from "./wifi-adapter-lock.ts";
import {
	notifyWifiAdapterModeDiscovery,
	observeWifiHotspotLoss,
} from "./wifi-adapter-mode-events.ts";
import {
	cancelWifiAdapterReconciliation,
	clearWifiAdapterReconcile,
} from "./wifi-adapter-reconcile-retry.ts";
import { retryWifiAdapterReconcile } from "./wifi-adapter-reconciler.ts";
import { supportsApStaConcurrency } from "./wifi-ap-sta-capability.ts";
import { quiesceHotspotAutoconnect } from "./wifi-autoconnect-policy.ts";
import { refreshWifiCapabilities } from "./wifi-capabilities.ts";
import type { AutoWifiChannel } from "./wifi-channels.ts";
import {
	concurrentApIfname,
	isConcurrentApIfname,
	isQualifiedNmManagedHybrid,
	isSupportedWifiIfname,
	observeConcurrentInterfacesAtFirstDiscovery,
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
import { reconcileHybridStationChannel } from "./wifi-hotspot-config.ts";
import { handleHotspotConn } from "./wifi-hotspot-discovery.ts";
import {
	canHotspot,
	isApMode,
	isConcurrentHotspot,
	type WifiHotspot,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import { wifiAdapterKeyPort } from "./wifi-permanent-mac.ts";
import {
	type RadioIdentity,
	recordWifiRadioShadowFailure,
	sameRadioLifetime,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import { wifiRadioObservation } from "./wifi-radio-observation.ts";
import {
	invalidateWifiRadioRow,
	notifyWifiRadioPublication,
	projectWifiRadioIncarnation,
} from "./wifi-radio-publication.ts";
import {
	transitionVirtualBinding,
	type VirtualHotspotBinding,
} from "./wifi-virtual-binding.ts";

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
	concurrentHotspot?: VirtualHotspotBinding;
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

const wifiIdToMacAddress: Record<WifiInterfaceId, MacAddress> = {};

export function getWifiIdToMacAddress() {
	return wifiIdToMacAddress;
}

export function getMacAddressForWifiInterface(id: WifiInterfaceId) {
	return wifiIdToMacAddress[id];
}

let unavailableDeviceRetryExpiry = 0;
let wifiIfId = 0;
const wifiUpdateTimers = new Set<ReturnType<typeof setTimeout>>();
let wifiDiscoveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
let discoveryController = new AbortController();
let wifiDeviceRefreshCompleted = false;
const classifiedWifiIfnames = new Map<string, number>();
const nonWifiIfnames = new Map<string, number>();

// The destination is addressable before discovery has finished both AP legs.
const pendingPortHandoffs = new WeakSet<WifiInterface>();

export function isWifiModeTargetPending(row: WifiInterface): boolean {
	return pendingPortHandoffs.has(row);
}

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

export function scheduleWifiUpdate(
	delayMs: number,
): ReturnType<typeof setTimeout> | undefined {
	if (discoveryController.signal.aborted) return;
	const timer = setTimeout(() => {
		wifiUpdateTimers.delete(timer);
		if (wifiDiscoveryRetryTimer === timer) wifiDiscoveryRetryTimer = undefined;
		void wifiUpdateDevices();
	}, delayMs).unref();
	wifiUpdateTimers.add(timer);
	return timer;
}

export function scheduleWifiDiscoveryRetry(): void {
	if (unavailableDeviceRetryExpiry === 0)
		unavailableDeviceRetryExpiry = getms() + 5 * 60 * 1_000;
	if (getms() < unavailableDeviceRetryExpiry && wifiUpdateTimers.size === 0)
		wifiDiscoveryRetryTimer = scheduleWifiUpdate(3_000);
}

export function clearWifiDiscoveryRetry(): void {
	if (
		Object.values(getWifiInterfacesByMacAddress()).some(
			(row) => row.degradedReason === "unavailable",
		)
	)
		return;
	if (wifiDiscoveryRetryTimer !== undefined) {
		clearTimeout(wifiDiscoveryRetryTimer);
		wifiUpdateTimers.delete(wifiDiscoveryRetryTimer);
		wifiDiscoveryRetryTimer = undefined;
	}
}

function cancelWifiUpdateTimers(): void {
	for (const timer of wifiUpdateTimers) clearTimeout(timer);
	wifiUpdateTimers.clear();
	wifiDiscoveryRetryTimer = undefined;
	unavailableDeviceRetryExpiry = 0;
	cancelWifiAdapterReconciliation();
}

export function stopWifiUpdateLoopForTest(): void {
	cancelWifiUpdateTimers();
}

export function resetWifiInterfaceDiscoveryForTest(): void {
	cancelWifiUpdateTimers();
	discoveryController.abort();
	discoveryController = new AbortController();
	resetWifiScanRefreshForTest();
	wifiRadioIdentity.resetCollisionHistoryForTest();
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

function hotspotObservation(row: WifiInterface): string | undefined {
	return canHotspot(row)
		? JSON.stringify([
				row.hotspot.conn,
				row.hotspot.name,
				row.hotspot.password,
				row.hotspot.channel,
				row.hotspot.security,
			])
		: undefined;
}

function contradictoryVirtual(
	row: WifiInterface,
	identities: ReadonlyMap<string, RadioIdentity>,
	ifname = row.concurrentHotspot?.ifname ?? concurrentApIfname(row.ifname),
): boolean {
	const parent = identities.get(row.ifname)?.lifetime;
	const virtual = identities.get(ifname)?.lifetime;
	return (
		parent !== undefined &&
		virtual !== undefined &&
		(parent.phyPath !== virtual.phyPath || parent.wiphy !== virtual.wiphy)
	);
}

function observeActiveConnection(
	row: WifiInterface,
	activeConn: ConnectionUUID | null,
	mode: WifiActiveMode,
): boolean {
	const previousConn = row.activeConn ?? null;
	const previousMode = row.activeMode;
	const retired = transitionVirtualBinding(row, {
		kind: "parent",
		connection: activeConn,
		mode,
	});
	row.activeConn = activeConn;
	if (activeConn === null) delete row.activeMode;
	else row.activeMode = mode;
	return (
		retired || previousConn !== activeConn || previousMode !== row.activeMode
	);
}

async function syncActiveConnection(
	wifiInterface: WifiInterface,
	macAddress: MacAddress,
	activeConn: ConnectionUUID | null,
): Promise<boolean> {
	const detailsBefore = hotspotObservation(wifiInterface);
	const mode =
		activeConn === null ? "unknown" : await resolveConnectionMode(activeConn);
	if (discoveryController.signal.aborted) return false;
	const changed = observeActiveConnection(wifiInterface, activeConn, mode);
	if (
		activeConn !== null &&
		mode === "ap" &&
		canHotspot(wifiInterface) &&
		(wifiInterface.hotspot.conn !== activeConn ||
			wifiInterface.degradedReason === "permanent-mac-unresolved")
	) {
		await handleHotspotConn(macAddress, activeConn, { active: true });
	}
	return changed || detailsBefore !== hotspotObservation(wifiInterface);
}

let activeDiscovery: Promise<boolean | undefined> | undefined;
let queuedDiscovery:
	| ReturnType<typeof Promise.withResolvers<boolean | undefined>>
	| undefined;

async function reconcileSampledWifiRegistry(): Promise<boolean> {
	const observation = wifiRadioIdentity.publishedObservation;
	const activeConnections = new Map<string, string | null>();
	for (const row of Object.values(getWifiInterfacesByMacAddress())) {
		activeConnections.set(row.ifname, row.activeConn ?? row.conn);
		if (row.concurrentHotspot)
			activeConnections.set(
				row.concurrentHotspot.ifname,
				row.concurrentHotspot.activeConn,
			);
	}
	if (
		!(await quiesceHotspotAutoconnect(
			wifiRadioIdentity.state.rows,
			activeConnections,
		))
	) {
		return false;
	}
	if (
		discoveryController.signal.aborted ||
		observation !== wifiRadioIdentity.publishedObservation
	)
		return false;
	const registry = getWifiInterfacesByMacAddress();
	for (const [key, row] of Object.entries(registry)) {
		const next = wifiRadioIdentity.state.rows.get(row.ifname);
		if (next && next.row === row && next.key !== key && registry[next.key]) {
			// The next full discovery can resolve both sides of a port swap.
			scheduleWifiUpdate(0);
			return false;
		}
	}
	let statusChange = false;
	for (const [key, row] of Object.entries(registry)) {
		const identity = wifiRadioIdentity.state.rows.get(row.ifname);
		if (identity?.row !== row) continue;
		const checked = await withWifiAdapterLock(
			wifiAdapterLockKey(key),
			async () => {
				const active = activeConnections.get(row.ifname) ?? null;
				if ((row.activeConn ?? row.conn) !== active) {
					if (active === null) row.conn = null;
					if (await syncActiveConnection(row, key, active)) statusChange = true;
				}
				if (
					row.concurrentHotspot?.activeConn &&
					activeConnections.get(row.concurrentHotspot.ifname) === null
				)
					if (transitionVirtualBinding(row, { kind: "retire" }))
						statusChange = true;
				if (key !== identity.key) {
					const activeAp =
						isApMode(row) || Boolean(row.concurrentHotspot?.activeConn);
					if (
						(key.includes("@") || identity.key.includes("@")) &&
						!activeAp &&
						canHotspot(row)
					) {
						const {
							conn: _conn,
							name: _name,
							password: _password,
							channel: _channel,
							security: _security,
							...idle
						} = row.hotspot;
						row.hotspot = idle;
					}
					removeWifiInterface(key, "transfer");
					addWifiInterface(identity.key, row);
					wifiIdToMacAddress[row.id] = identity.key;
				}
				if (identity.degradedReason === undefined) delete row.degradedReason;
				else row.degradedReason = identity.degradedReason;
			},
		);
		if (!checked.success) {
			retryWifiAdapterReconcile(
				wifiAdapterLockKey(key),
				undefined,
				"discovery",
			);
			return false;
		}
	}
	if (statusChange) broadcastWifiState();
	for (const key of Object.keys(getWifiInterfacesByMacAddress()))
		clearWifiAdapterReconcile(wifiAdapterLockKey(key), "discovery");
	queueMicrotask(() => {
		if (!discoveryController.signal.aborted)
			void notifyWifiAdapterModeDiscovery();
	});
	return true;
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
	const previousIdentities = wifiRadioIdentity.state.rows;
	const activeBefore = Object.values(getWifiInterfacesByMacAddress()).filter(
		(row) => isApMode(row) || isConcurrentHotspot(row),
	);
	const activityBefore = new Map(
		Object.values(getWifiInterfacesByMacAddress()).map((row) => [
			row,
			{
				conn: row.conn,
				activeConn: row.activeConn,
				activeMode: row.activeMode,
			},
		]),
	);
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
	const complete = networkDevices?.every((raw) => {
		if (!raw.trim()) return true;
		const fields = nmcliParseSep(raw);
		return (
			fields.length === 4 &&
			fields[0] !== "" &&
			fields[1] !== "" &&
			fields[2] !== ""
		);
	});
	if (!networkDevices || !complete) {
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
	await observeConcurrentInterfacesAtFirstDiscovery(
		networkDevices
			.filter((raw) => raw.trim())
			.map((raw) => nmcliParseSep(raw)[0] ?? ""),
		identities,
	);
	if (signal.aborted) return;
	const listed = new Map(
		networkDevices
			.filter((raw) => raw.trim())
			.map((raw) => {
				const [ifname, , , uuid] = nmcliParseSep(raw);
				return [ifname, uuid || null];
			}),
	);
	const replaced = (ifname: string): boolean => {
		const before = previousIdentities.get(ifname)?.lifetime;
		const after = identities.get(ifname)?.lifetime;
		return (
			before !== undefined &&
			after !== undefined &&
			(before.ifindex !== after.ifindex ||
				before.wiphy !== after.wiphy ||
				before.phyPath !== after.phyPath)
		);
	};
	const observeBusyAdapter = async (
		key: string,
		row: WifiInterface,
	): Promise<void> => {
		const before = activityBefore.get(row);
		const active = listed.get(row.ifname) ?? null;
		if (
			!before ||
			key !== identities.get(row.ifname)?.key ||
			replaced(row.ifname) ||
			active === before.activeConn
		)
			return;
		const mode =
			active === null ? "unknown" : await resolveConnectionMode(active);
		if (
			signal.aborted ||
			observation !== wifiRadioIdentity.publishedObservation ||
			getWifiInterfacesByMacAddress()[key] !== row ||
			row.conn !== before.conn ||
			row.activeConn !== before.activeConn ||
			row.activeMode !== before.activeMode ||
			(active !== null && mode === "unknown")
		)
			return;
		// Observations remain current during an operation; policy and identity transfer wait.
		row.conn =
			active !== null && wifiDeviceListGetInetAddress(row.ifname)
				? active
				: null;
		observeActiveConnection(row, active, mode);
	};
	let operationPending = false;
	for (const [key, row] of Object.entries(getWifiInterfacesByMacAddress())) {
		const probe = await withWifiAdapterLock(
			wifiAdapterLockKey(key),
			async () => true,
		);
		if (probe.success) continue;
		await observeBusyAdapter(key, row);
		retryWifiAdapterReconcile(wifiAdapterLockKey(key), undefined, "discovery");
		operationPending = true;
	}
	if (operationPending) return;
	if (!(await quiesceHotspotAutoconnect(identities, listed))) {
		return;
	}
	if (signal.aborted) return;
	// Evaluate absence against the complete roster, before adopting any parent AP.
	for (const row of Object.values(getWifiInterfacesByMacAddress())) {
		const binding = row.concurrentHotspot;
		if (
			binding &&
			(!listed.has(row.ifname) ||
				!listed.has(binding.ifname) ||
				contradictoryVirtual(row, identities) ||
				replaced(row.ifname) ||
				replaced(binding.ifname))
		) {
			if (
				transitionVirtualBinding(row, {
					kind: "discard",
					parentConn: listed.get(row.ifname) ?? null,
				})
			)
				statusChange = true;
		}
	}

	const seenIfnames: string[] = [];
	const presentKeys = new Set<string>();
	const concurrentDevices = new Map<string, ConnectionUUID | null>();
	const observedKeys = new Set(
		Array.from(identities.values(), ({ key }) => key),
	);
	const registry = getWifiInterfacesByMacAddress();
	const swapLocks = new Set<string>();
	for (const [key, row] of Object.entries(registry)) {
		const next = identities.get(row.ifname)?.key;
		if (next && next !== key && registry[next]) {
			swapLocks.add(wifiAdapterLockKey(key));
			swapLocks.add(wifiAdapterLockKey(next));
		}
	}
	// Once a row moves, a busy adapter cannot leave the roster half-transferred.
	if (swapLocks.size) {
		for (const key of [...Object.keys(registry), ...observedKeys])
			swapLocks.add(wifiAdapterLockKey(key));
	}

	const transferRoster = async () => {
		if (!swapLocks.size)
			for (const id of Object.keys(wifiIdToMacAddress))
				delete wifiIdToMacAddress[Number(id)];
		for (const networkDevice of networkDevices) {
			try {
				const [ifname, type, state] = nmcliParseSep(networkDevice) as [
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
					const active = listed.get(ifname);
					concurrentDevices.set(
						ifname,
						state.startsWith("connected") && active && active !== "--"
							? active
							: null,
					);
					continue;
				}
				if (!isSupportedWifiIfname(ifname)) continue;
				const previous = Object.entries(getWifiInterfacesByMacAddress()).find(
					([, row]) => row.ifname === ifname,
				);
				const owner =
					previous?.[0] ?? identities.get(ifname)?.key ?? `degraded:${ifname}`;
				const checked = await withWifiAdapterLocks(
					[wifiAdapterLockKey(owner)],
					async () => {
						if (state === "unavailable") {
							classificationComplete = false;
							unavailableDevices = true;
							seenIfnames.push(ifname);
							const existed = Object.values(
								getWifiInterfacesByMacAddress(),
							).some((wifiInterface) => wifiInterface?.ifname === ifname);
							const row = recordDegradedWifiInterface(
								ifname,
								"unavailable",
								identities.get(ifname)?.key ?? `degraded:${ifname}`,
							);
							presentKeys.add(
								identities.get(ifname)?.key ?? `degraded:${ifname}`,
							);
							transitionVirtualBinding(row, {
								kind: "parent",
								connection: null,
								mode: "unknown",
							});
							row.conn = null;
							row.activeConn = null;
							delete row.activeMode;
							invalidateWifiRadioRow(row, observation);
							if (observation !== undefined)
								wifiRadioIdentity.associateRows([row], observation);
							if (existed) statusChange = true;
							else newDevices = true;
							return;
						}

						const activeConn = listed.get(ifname) ?? null;
						const conn =
							activeConn !== null && wifiDeviceListGetInetAddress(ifname)
								? activeConn
								: null;
						const currentMac = wifiDeviceListGetMacAddress(ifname);
						if (!currentMac) {
							classificationComplete = false;
							seenIfnames.push(ifname);
							const existed = Object.values(
								getWifiInterfacesByMacAddress(),
							).some((wifiInterface) => wifiInterface?.ifname === ifname);
							const row = recordDegradedWifiInterface(
								ifname,
								"operational-mac-missing",
								identities.get(ifname)?.key ?? `degraded:${ifname}`,
							);
							presentKeys.add(
								identities.get(ifname)?.key ?? `degraded:${ifname}`,
							);
							transitionVirtualBinding(row, {
								kind: "parent",
								connection: null,
								mode: "unknown",
							});
							row.conn = null;
							row.activeConn = null;
							delete row.activeMode;
							invalidateWifiRadioRow(row, observation);
							if (observation !== undefined)
								wifiRadioIdentity.associateRows([row], observation);
							if (existed) statusChange = true;
							else newDevices = true;
							return;
						}

						seenIfnames.push(ifname);
						const identity = identities.get(ifname);
						const macAddress = identity?.key ?? `degraded:${ifname}`;
						const permanentMacResolved =
							identity?.classification === "verified";
						const before = previousIdentities.get(ifname);
						const samePortRadio =
							identity &&
							before &&
							sameRadioLifetime(before.lifetime, identity.lifetime) &&
							(before.key.includes("@") || identity.key.includes("@"));
						let recoveredId: WifiInterfaceId | undefined;
						for (const [key, candidate] of Object.entries(
							getWifiInterfacesByMacAddress(),
						)) {
							if (
								key !== macAddress &&
								candidate?.ifname === ifname &&
								(candidate.degradedReason !== undefined ||
									(samePortRadio && !observedKeys.has(key))) &&
								!getWifiInterfaceByMacAddress(macAddress)
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
								return;
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
									isQualifiedNmManagedHybrid(ifname) &&
									(await supportsApStaConcurrency(ifname));
								if (signal.aborted) return;

								const bandCapability: AutoWifiChannel[] = ["auto"];
								if (parsedProps.value.supports5Ghz)
									bandCapability.push("auto_50");
								if (parsedProps.value.supports2Ghz)
									bandCapability.push("auto_24");

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
							if (
								previous &&
								previous[0] !== macAddress &&
								(wifiAdapterKeyPort(previous[0]) ||
									wifiAdapterKeyPort(macAddress))
							)
								pendingPortHandoffs.add(updatedInterface);
							presentKeys.add(macAddress);
							invalidateWifiRadioRow(updatedInterface, observation);
							wifiIdToMacAddress[updatedInterface.id] = macAddress;
							if (observation !== undefined)
								wifiRadioIdentity.associateRows(
									[updatedInterface],
									observation,
								);
							if (
								await syncActiveConnection(
									updatedInterface,
									macAddress,
									activeConn,
								)
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
					},
				);
				if (!checked.success) {
					if (previous) await observeBusyAdapter(previous[0], previous[1]);
					retryWifiAdapterReconcile(
						wifiAdapterLockKey(owner),
						undefined,
						"discovery",
					);
					return false;
				}
			} catch (err) {
				classificationComplete = false;
				if (err instanceof Error) {
					logger.error(
						`Error getting the nmcli WiFi device information: ${err.message}`,
					);
				}
			}
			if (signal.aborted) return false;
		}
		for (const id of Object.keys(wifiIdToMacAddress).map(Number)) {
			const key = wifiIdToMacAddress[id];
			if (key && !presentKeys.has(key)) delete wifiIdToMacAddress[id];
		}
		return true;
	};
	const transferred = await withWifiAdapterLocks(swapLocks, transferRoster);
	if (!transferred.success) {
		for (const key of swapLocks)
			retryWifiAdapterReconcile(key, undefined, "discovery");
		return;
	}
	if (!transferred.result) return;

	for (const [registryKey, wifiInterface] of Object.entries(
		getWifiInterfacesByMacAddress(),
	)) {
		const identity = identities.get(wifiInterface.ifname);
		if (!canHotspot(wifiInterface) || identity?.key !== registryKey) continue;
		const expected = concurrentApIfname(wifiInterface.ifname);
		const stored =
			identity.classification === "verified"
				? getHotspotCredentials(registryKey)
				: undefined;
		const knownProfiles = new Set([
			wifiInterface.hotspot.conn,
			stored?.conn,
			...(stored?.previousConns ?? []),
		]);
		const candidates: Array<{
			ifname: string;
			activeConn: ConnectionUUID | null;
		}> = [];
		let unresolvedVirtual = false;
		for (const [ifname, activeConn] of concurrentDevices) {
			if (contradictoryVirtual(wifiInterface, identities, ifname)) continue;
			if (activeConn !== null) {
				if (
					ifname !== expected &&
					ifname !== wifiInterface.concurrentHotspot?.ifname &&
					!knownProfiles.has(activeConn)
				)
					continue;
				const mode = await resolveConnectionMode(activeConn);
				if (mode === "unknown") unresolvedVirtual = true;
				if (mode !== "ap") continue;
			} else if (
				ifname !== expected &&
				ifname !== wifiInterface.concurrentHotspot?.ifname
			)
				continue;
			candidates.push({ ifname, activeConn });
		}
		if (signal.aborted) return;
		if (getWifiInterfaceByMacAddress(registryKey) !== wifiInterface) continue;
		const stopTargetKnown =
			(wifiInterface.activeConn === null ||
				wifiInterface.activeMode === "ap" ||
				wifiInterface.activeMode === "infrastructure") &&
			!unresolvedVirtual;
		const active = candidates.filter(
			(candidate) => candidate.activeConn !== null,
		);
		const chosen =
			active.find(
				(candidate) => candidate.activeConn === wifiInterface.hotspot.conn,
			) ??
			(active.length === 1
				? active[0]
				: active.length === 0
					? (candidates.find(
							(candidate) =>
								candidate.ifname === wifiInterface.concurrentHotspot?.ifname,
						) ?? candidates.find((candidate) => candidate.ifname === expected))
					: undefined);
		if (!chosen) {
			if (stopTargetKnown && active.length === 0)
				pendingPortHandoffs.delete(wifiInterface);
			if (transitionVirtualBinding(wifiInterface, { kind: "discard" })) {
				statusChange = true;
			}
			continue;
		}
		const { ifname: virtualIfname, activeConn } = chosen;

		const detailsBefore = hotspotObservation(wifiInterface);
		const bindingChanged = transitionVirtualBinding(wifiInterface, {
			kind: "set",
			ifname: virtualIfname,
			activeConn,
		});
		if (activeConn) {
			await handleHotspotConn(
				wifiInterface.degradedReason === "permanent-mac-unresolved"
					? registryKey
					: undefined,
				activeConn,
				{ active: true },
			);
			if (signal.aborted) return;
		}
		if (stopTargetKnown) pendingPortHandoffs.delete(wifiInterface);
		if (activeConn && !isWifiModeTargetPending(wifiInterface)) {
			await reconcileHybridStationChannel(registryKey, wifiInterface);
			if (signal.aborted) return;
		}
		if (bindingChanged || detailsBefore !== hotspotObservation(wifiInterface)) {
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
		if (wifiInterface && (wifiInterface.removed || !presentKeys.has(i))) {
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
	logger.debug("Wifi interfaces refreshed", {
		count: Object.keys(wifiInterfacesByMacAddress).length,
	});

	/* If some wifi adapters were marked unavailable, recheck periodically
     This might happen when the system has just booted up and the adapter
     typically becomes available within 30 seconds.
     Uses a timeout to avoid polling nmcli forever */
	if (unavailableDevices) {
		if (unavailableDeviceRetryExpiry === 0) {
			scheduleWifiDiscoveryRetry();
			logger.warn(
				"One or more Wifi interfaces are unavailable. Will retry periodically for the next 5 minutes",
			);
		} else if (getms() < unavailableDeviceRetryExpiry) {
			scheduleWifiDiscoveryRetry();
			logger.warn(
				"One or more Wifi interfaces are still unavailable. Retrying in 3 seconds...",
			);
		}
	} else {
		unavailableDeviceRetryExpiry = 0;
	}

	for (const key of Object.keys(getWifiInterfacesByMacAddress()))
		clearWifiAdapterReconcile(wifiAdapterLockKey(key), "discovery");
	for (const row of activeBefore)
		if (!isApMode(row) && !isConcurrentHotspot(row))
			observeWifiHotspotLoss(row);
	queueMicrotask(() => {
		void notifyWifiAdapterModeDiscovery();
	});
	wifiDeviceRefreshCompleted = classificationComplete;
	if (topologyGeneration !== getNetifTopologyGeneration())
		scheduleWifiUpdate(0);
	triggerNetworkInterfacesChange();
	return statusChange;
}
