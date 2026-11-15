import { logger } from "../../helpers/logger.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import {
	getPersistedWifiAdapterModes,
	isWifiAdapterModeAvailable,
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
import { resolveWifiAdapterOwner } from "./wifi-adapter-owner.ts";
import {
	reconcileWifiAdapterRestoreLocked,
	retryWifiAdapterReconcile,
	type WifiRestoreCycle,
} from "./wifi-adapter-reconciler.ts";
import { withoutWifiRequestBinding } from "./wifi-binding.ts";
import { getWifiCapabilityEvidenceRevision } from "./wifi-capabilities.ts";
import { canHotspot } from "./wifi-hotspot-types.ts";
import { restoreLimitedHotspot } from "./wifi-limited-hotspot-restore.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";

type Preferences = typeof getPersistedWifiAdapterModes;

/** All entrypoints submit apply-only work to the same logical owner. */
async function applyWifiAdapterModes(
	deps: AdapterModeTransitionDeps,
	readPreferences: Preferences,
	cycle?: WifiRestoreCycle,
): Promise<void> {
	try {
		let limitedVisited = false;
		for (const [registryKey, row] of Object.entries(deps.resolveInterfaces())) {
			if (!canHotspot(row)) continue;
			const verified = normalizeMacAddress(registryKey) !== undefined;
			const preferences = readPreferences();
			if (
				!verified &&
				(limitedVisited ||
					!Object.values(preferences).some((mode) => mode !== "station"))
			)
				continue;
			const observedOwner = resolveWifiAdapterOwner(registryKey, row);
			const key = verified
				? observedOwner
				: resolveWifiAdapterModeIntentKey(
						"limited",
						preferences,
						Object.values(deps.resolveInterfaces()).filter(canHotspot).length,
					);
			if (verified && key === undefined) continue;
			const owner = key ?? observedOwner;
			const lock = await withWifiAdapterLock(
				wifiAdapterLockKey(owner),
				async () => {
					if (cycle?.stopped() || deps.resolveInterfaces()[registryKey] !== row)
						return;
					const desired =
						key === undefined ? undefined : readPreferences()[key];
					if (
						row.hotspot.transition &&
						desired !== "station" &&
						desired !== undefined
					)
						return;
					if (!verified) limitedVisited = true;
					const capability = wifiAdapterModeCapability(
						row,
						deps.readCapabilities,
					);
					const signature = JSON.stringify([
						key,
						desired,
						row.ifname,
						row.conn,
						capability.staApComboSupported,
						getWifiCapabilityEvidenceRevision(row.ifname),
						getIsStreaming(),
						...(!verified ? Object.keys(deps.resolveInterfaces()) : []),
					]);
					await reconcileWifiAdapterRestoreLocked(owner, {
						row,
						desired,
						signature,
						...(cycle ? { cycle } : {}),
						isCurrent: () =>
							deps.resolveInterfaces()[registryKey] === row &&
							(key === undefined ? undefined : readPreferences()[key]) ===
								desired,
						activate: async (settle) => {
							if (!verified)
								return restoreLimitedHotspot(
									row,
									deps,
									readPreferences,
									cycle?.stopped,
								);
							if (desired === undefined || desired === "station")
								return undefined;
							if (
								!isWifiAdapterModeAvailable(
									desired,
									wifiAdapterModeOptions(capability),
								)
							) {
								logger.warn(
									`wifi mode restore: activation-failed on ${row.ifname}; leaving ${desired} pending`,
								);
								return undefined;
							}
							if (desired === "hotspot" && row.conn && getIsStreaming()) {
								logger.warn(
									`wifi mode restore: streaming keeps the station link on ${row.ifname}; leaving hotspot pending`,
								);
								return undefined;
							}
							return deps.startHotspot(row.id, (...args) => {
								deps.publishHotspotOutcome(...args);
								if (args[2].success || args[2].error !== "DEVICE_BUSY")
									settle(args[2].success);
							});
						},
					});
				},
			);
			if (!lock.success) retryWifiAdapterReconcile(owner, undefined, "restore");
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

/** All failed attempts reuse the bounded discovery timer. */
export function startWifiAdapterModeRestore(
	deps: AdapterModeTransitionDeps = defaultAdapterModeDeps,
	source: WifiAdapterModeRestoreSource = wifiAdapterModeRestoreSource,
): () => void {
	let stopped = false;
	let queued = false;
	let flight: Promise<void> | undefined;
	const cycle: WifiRestoreCycle = { edges: new Map(), stopped: () => stopped };
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
