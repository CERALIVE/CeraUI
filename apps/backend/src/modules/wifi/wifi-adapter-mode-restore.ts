import { logger } from "../../helpers/logger.ts";
import { nmConnect, nmConnGetFields } from "../network/network-manager.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import {
	canUseHotspotConnection,
	getHotspotCredentials,
} from "./hotspot-credentials.ts";
import { getDerivedApChannels, refreshHotspotChannels } from "./regdomain.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import {
	getPersistedWifiAdapterModes,
	isWifiAdapterModeAvailable,
	observedWifiAdapterMode,
	resolveWifiAdapterModeIntentKey,
	wifiAdapterModeCapability,
	wifiAdapterModeOptions,
} from "./wifi-adapter-mode.ts";
import {
	type WifiAdapterModeRestoreSource,
	wifiAdapterModeRestoreSource,
} from "./wifi-adapter-mode-events.ts";
import {
	type AdapterModeTransitionDeps,
	defaultAdapterModeDeps,
} from "./wifi-adapter-mode-transition.ts";
import { withoutWifiRequestBinding } from "./wifi-binding.ts";
import { getWifiCapabilityEvidenceRevision } from "./wifi-capabilities.ts";
import { channelFromNM } from "./wifi-channels.ts";
import {
	type ConcurrentApInterface,
	concurrentApIfname,
	ensureConcurrentApInterface,
	releaseCreatedConcurrentApInterface,
} from "./wifi-concurrent-interface.ts";
import {
	canHotspot,
	HOTSPOT_UP_TO,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";

type RestoreEdge = {
	readonly row: WifiInterface;
	readonly desired: string;
	readonly signature: string;
	readonly completed: boolean;
};

type RestoreCycle = {
	readonly edges: Map<string, RestoreEdge>;
	readonly stopped: () => boolean;
};

type Preferences = typeof getPersistedWifiAdapterModes;

/** Boot-only D12 path. Requests never receive this activation authority. */
async function restoreLimitedHotspot(
	row: WifiInterfaceWithHotspot,
	deps: AdapterModeTransitionDeps,
	readPreferences: Preferences,
	stopped: () => boolean = () => false,
): Promise<boolean> {
	if (stopped()) return false;
	let refusalLogged = false;
	const refuse = (reason: string): false => {
		if (!refusalLogged)
			logger.warn(`limited restore: ${reason} on ${row.ifname}`);
		refusalLogged = true;
		return false;
	};
	const adapters = Object.values(deps.resolveInterfaces()).filter(canHotspot);
	if (adapters.length !== 1 || adapters[0] !== row)
		return refuse("requires exactly one hotspot-capable adapter");
	const preferences = readPreferences();
	const key = resolveWifiAdapterModeIntentKey("limited", preferences, 1);
	if (!key)
		return refuse("requires exactly one logical intent and profile owner");
	const desired = preferences[key];
	const stored = getHotspotCredentials(key);
	if (!stored?.conn || !canUseHotspotConnection(key, stored.conn))
		return refuse("owned profile missing");
	const fields = await nmConnGetFields(stored.conn, [
		"802-11-wireless.mode",
		"802-11-wireless.band",
		"802-11-wireless.channel",
		"connection.interface-name",
	] as const);
	if (stopped()) return false;
	if (fields?.[0] !== "ap") return refuse("owned AP profile missing");
	const channel = channelFromNM(fields[1], fields[2]);
	const admitted = (): boolean => {
		if (stopped()) return false;
		const current = Object.values(deps.resolveInterfaces()).filter(canHotspot);
		if (current.length !== 1 || current[0] !== row)
			return refuse("requires exactly one hotspot-capable adapter");
		if (
			row.degradedReason !== "permanent-mac-unresolved" ||
			observedWifiAdapterMode(row) !== "station" ||
			row.hotspot.transition
		)
			return refuse("adapter is no longer eligible");
		const latest = readPreferences();
		if (
			resolveWifiAdapterModeIntentKey("limited", latest, 1) !== key ||
			latest[key] !== desired
		)
			return refuse("logical intent changed");
		refreshHotspotChannels(row.hotspot, getDerivedApChannels());
		if (channel !== "auto" && !row.hotspot.availableChannels.includes(channel))
			return refuse("stored channel is no longer permitted");
		const concurrency = wifiAdapterModeCapability(
			row,
			deps.readCapabilities,
		).staApComboSupported;
		if (desired === "hybrid" && concurrency !== true)
			return refuse("hybrid capability is not proven");
		if (desired === "hybrid" && fields[3] !== concurrentApIfname(row.ifname))
			return refuse("owned profile does not target the hybrid interface");
		if (desired === "hotspot" && row.conn && getIsStreaming())
			return refuse("streaming keeps the station link");
		return true;
	};
	if (!admitted()) return false;
	let target: ConcurrentApInterface | undefined;
	let accepted = false;
	try {
		if (desired === "hybrid") {
			target = await ensureConcurrentApInterface(row.ifname, admitted);
			if (!admitted()) return false;
			if (!target) return refuse("hybrid interface is unavailable");
		}
		if (!canUseHotspotConnection(key, stored.conn))
			return refuse("profile ownership changed");
		const activated = await nmConnect(stored.conn, HOTSPOT_UP_TO);
		if (stopped()) return false;
		if (!activated) return refuse("activation failed");
		accepted = true;
		logger.warn("hotspot restored on an adapter that could not be identified");
		return true;
	} finally {
		if (!accepted && target?.created)
			await releaseCreatedConcurrentApInterface(target);
	}
}

/** Apply current intent only. Enumerating keys never grants authority to write it. */
async function applyWifiAdapterModes(
	deps: AdapterModeTransitionDeps,
	readPreferences: Preferences,
	cycle?: RestoreCycle,
): Promise<void> {
	try {
		for (const [registryKey, row] of Object.entries(deps.resolveInterfaces())) {
			if (
				normalizeMacAddress(registryKey) ||
				!canHotspot(row) ||
				observedWifiAdapterMode(row) !== "station" ||
				row.hotspot.transition
			)
				continue;
			if (!Object.values(readPreferences()).some((mode) => mode !== "station"))
				continue;
			await withWifiAdapterLock(wifiAdapterLockKey(registryKey), async () => {
				if (cycle?.stopped()) return;
				const preferences = readPreferences();
				const intentKey = resolveWifiAdapterModeIntentKey(
					"limited",
					preferences,
					Object.values(deps.resolveInterfaces()).filter(canHotspot).length,
				);
				const desired = JSON.stringify([
					intentKey,
					intentKey === undefined ? undefined : preferences[intentKey],
				]);
				const signature = JSON.stringify([
					desired,
					Object.keys(deps.resolveInterfaces()),
					row.conn,
					getWifiCapabilityEvidenceRevision(row.ifname),
					getIsStreaming(),
				]);
				const previous = cycle?.edges.get(registryKey);
				if (
					previous?.row === row &&
					((previous.completed && previous.desired === desired) ||
						previous.signature === signature)
				)
					return;
				cycle?.edges.set(registryKey, {
					row,
					desired,
					signature,
					completed: false,
				});
				const completed = await restoreLimitedHotspot(
					row,
					deps,
					readPreferences,
					cycle?.stopped,
				);
				if (cycle?.stopped()) return;
				cycle?.edges.set(registryKey, {
					row,
					desired,
					signature,
					completed,
				});
			});
			break;
		}
		for (const macAddress of Object.keys(readPreferences())) {
			try {
				await withWifiAdapterLock(wifiAdapterLockKey(macAddress), async () => {
					if (cycle?.stopped()) return;
					const key = resolveWifiAdapterModeIntentKey(macAddress);
					if (key === undefined) return;
					const desired = readPreferences()[key];
					const row = deps.resolveInterfaces()[macAddress];
					if (
						!row ||
						desired === undefined ||
						desired === "station" ||
						!canHotspot(row)
					)
						return;
					const previous = cycle?.edges.get(key);
					if (
						previous?.row === row &&
						previous.desired === desired &&
						previous.completed
					)
						return;
					// An observed AP or our own pending activation is never a restore target.
					if (
						observedWifiAdapterMode(row) !== "station" ||
						row.hotspot.transition
					)
						return;
					const capability = wifiAdapterModeCapability(
						row,
						deps.readCapabilities,
					);
					const streaming = getIsStreaming();
					const signature = JSON.stringify([
						desired,
						row.ifname,
						row.conn,
						capability.staApComboSupported,
						getWifiCapabilityEvidenceRevision(row.ifname),
						streaming,
					]);
					if (previous?.row === row && previous.signature === signature) return;
					cycle?.edges.set(key, { row, desired, signature, completed: false });
					if (
						!isWifiAdapterModeAvailable(
							desired,
							wifiAdapterModeOptions(capability),
						)
					) {
						logger.warn(
							`wifi mode restore: activation-failed on ${row.ifname}; leaving ${desired} pending`,
						);
						return;
					}
					if (desired === "hotspot" && row.conn && streaming) {
						logger.warn(
							`wifi mode restore: streaming keeps the station link on ${row.ifname}; leaving hotspot pending`,
						);
						return;
					}
					const result = await deps.startHotspot(
						row.id,
						deps.publishHotspotOutcome,
					);
					if (result.success) {
						cycle?.edges.set(key, { row, desired, signature, completed: true });
					} else {
						logger.warn(
							`wifi mode restore: ${result.error} on ${row.ifname}; leaving ${desired} pending`,
						);
					}
				});
			} catch (error: unknown) {
				logger.error(
					`wifi mode restore failed for ${macAddress}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	} catch (error: unknown) {
		logger.error(
			`wifi mode restore failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** One completed-discovery pass, also useful to explicit reconciliation callers. */
export function reconcileWifiAdapterModes(
	deps: AdapterModeTransitionDeps = defaultAdapterModeDeps,
	readPreferences: Preferences = getPersistedWifiAdapterModes,
): Promise<void> {
	return applyWifiAdapterModes(deps, readPreferences);
}

/** No polling or timers: discovery, capability and streaming edges re-arm pending intent. */
export function startWifiAdapterModeRestore(
	deps: AdapterModeTransitionDeps = defaultAdapterModeDeps,
	source: WifiAdapterModeRestoreSource = wifiAdapterModeRestoreSource,
): () => void {
	let stopped = false;
	let queued = false;
	let flight: Promise<void> | undefined;
	const cycle: RestoreCycle = { edges: new Map(), stopped: () => stopped };
	const request = (): Promise<void> => {
		if (stopped || !source.hasDiscovery()) return Promise.resolve();
		queued = true;
		flight ??= Promise.resolve().then(async () => {
			try {
				while (queued && !stopped) {
					queued = false;
					await applyWifiAdapterModes(
						deps,
						getPersistedWifiAdapterModes,
						cycle,
					);
				}
			} finally {
				flight = undefined;
			}
		});
		return flight;
	};
	// An edge may be published from inside a request; restore is never its work.
	const unsubscribe = source.subscribe(() =>
		withoutWifiRequestBinding(request),
	);
	void request();
	return () => {
		stopped = true;
		queued = false;
		unsubscribe();
		cycle.edges.clear();
	};
}
