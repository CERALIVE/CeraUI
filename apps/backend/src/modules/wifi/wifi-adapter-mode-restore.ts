import { logger } from "../../helpers/logger.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
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
import { getWifiCapabilityEvidenceRevision } from "./wifi-capabilities.ts";
import { canHotspot } from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";

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

/** Apply current intent only. Enumerating keys never grants authority to write it. */
async function applyWifiAdapterModes(
	deps: AdapterModeTransitionDeps,
	readPreferences: Preferences,
	cycle?: RestoreCycle,
): Promise<void> {
	try {
		for (const macAddress of Object.keys(readPreferences())) {
			try {
				await withWifiAdapterLock(wifiAdapterLockKey(macAddress), async () => {
					if (cycle?.stopped()) return;
					const key = resolveWifiAdapterModeIntentKey(macAddress);
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
	const unsubscribe = source.subscribe(request);
	void request();
	return () => {
		stopped = true;
		queued = false;
		unsubscribe();
		cycle.edges.clear();
	};
}
