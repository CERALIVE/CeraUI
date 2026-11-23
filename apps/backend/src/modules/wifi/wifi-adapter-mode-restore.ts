import { logger } from "../../helpers/logger.ts";
import { nmConnGetFields } from "../network/network-manager.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import {
	getHotspotCredentials,
	isHotspotPortCredentialCopy,
} from "./hotspot-credentials.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLocks,
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
import { hasDeferredWifiStationIntent } from "./wifi-adapter-reconcile-retry.ts";
import {
	reconcileWifiAdapterRestoreLocked,
	retryWifiAdapterReconcile,
	type WifiRestoreCycle,
} from "./wifi-adapter-reconciler.ts";
import { observedUniqueHotspotAddress } from "./wifi-autoconnect-policy.ts";
import { admitWifiRequest, withoutWifiRequestBinding } from "./wifi-binding.ts";
import {
	getWifiCapabilitiesForInterface,
	getWifiCapabilityEvidenceRevision,
} from "./wifi-capabilities.ts";
import { HYBRID_CHANNEL_REFUSAL } from "./wifi-concurrent-interface.ts";
import { canHotspot } from "./wifi-hotspot-types.ts";
import { restoreLimitedHotspot } from "./wifi-limited-hotspot-restore.ts";
import {
	bindingForRow,
	soleWifiPortAlias,
	verifiedWifiPortKey,
} from "./wifi-operation-binding.ts";
import { wifiAdapterKeyMac } from "./wifi-permanent-mac.ts";
import { wifiRadioIdentity } from "./wifi-radio-identity.ts";

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
			const verified =
				wifiAdapterKeyMac(registryKey) !== undefined &&
				row.degradedReason !== "permanent-mac-unresolved";
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
			const owner = key ?? observedOwner;
			const binding = verified ? bindingForRow(registryKey, row) : undefined;
			const solePort = soleWifiPortAlias(binding);
			const lock = await withWifiAdapterLocks(
				[owner, ...(solePort ? [solePort] : [])].map(wifiAdapterLockKey),
				async () => {
					if (cycle?.stopped() || deps.resolveInterfaces()[registryKey] !== row)
						return;
					const desiredMode = () => {
						const modes = readPreferences();
						const alias = verifiedWifiPortKey(bindingForRow(registryKey, row));
						// A positive Station choice for this physical port cannot fall
						// through to another AP profile just because its twin is gone.
						if (
							alias &&
							getHotspotCredentials(alias)?.conn &&
							(modes[alias] === "station" ||
								hasDeferredWifiStationIntent(alias))
						)
							return "station";
						return key === undefined ? undefined : modes[key];
					};
					const desired = desiredMode();
					// A matching port intent can identify the profile without changing
					// which intent controls the sole adapter.
					const portProfile =
						solePort &&
						desired &&
						desired !== "station" &&
						readPreferences()[solePort] === desired &&
						!isHotspotPortCredentialCopy(solePort)
							? getHotspotCredentials(solePort)?.conn
							: undefined;
					const plainProfile =
						portProfile && getHotspotCredentials(owner)?.conn;
					const plainPin = plainProfile
						? (
								await nmConnGetFields(plainProfile, ["match.path"] as const)
							)?.[0]
						: undefined;
					const restoreProfile =
						plainPin && plainPin !== binding?.devicePath
							? portProfile
							: undefined;
					if (desiredMode() !== desired) return;
					if (!verified) limitedVisited = true;
					const readCapabilities =
						deps.readCapabilities ?? getWifiCapabilitiesForInterface;
					const rawCapability = readCapabilities(row.ifname);
					const capability = wifiAdapterModeCapability(
						row,
						() => rawCapability,
					);
					const signature = JSON.stringify([
						key,
						desired,
						restoreProfile,
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
							desiredMode() === desired,
						activate: (settle, attempt) =>
							admitWifiRequest(
								row,
								async () => {
									if (!verified)
										return restoreLimitedHotspot(
											row,
											deps,
											readPreferences,
											cycle?.stopped,
											attempt,
										);
									if (desired === undefined || desired === "station")
										return undefined;
									if (
										!isWifiAdapterModeAvailable(
											desired,
											wifiAdapterModeOptions(capability),
										)
									) {
										if (
											desired === "hybrid" &&
											rawCapability?.staApCombo.supported === true &&
											capability.staApComboSupported !== true
										) {
											const refusal = {
												success: false,
												error: "activation-failed",
												reason: HYBRID_CHANNEL_REFUSAL,
											} as const;
											deps.publishHotspotOutcome("start", row.id, refusal);
											settle(false);
											return refusal;
										}
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
									const plainNeedsPortPin =
										binding?.mac === owner &&
										(wifiRadioIdentity.hasSeenSameAddressCollision(owner) ||
											!observedUniqueHotspotAddress(
												owner,
												wifiRadioIdentity.state.rows,
											));
									return deps.startHotspot(
										row.id,
										(...args) => {
											deps.publishHotspotOutcome(...args);
											if (args[2].success || args[2].error !== "DEVICE_BUSY")
												settle(args[2].success);
										},
										attempt,
										binding && {
											...binding,
											bootRestore:
												plainNeedsPortPin || restoreProfile
													? "require-port-pin"
													: "verified",
											...(solePort && restoreProfile
												? {
														restoreProfile: {
															owner: solePort,
															uuid: restoreProfile,
														},
													}
												: {}),
										},
									);
								},
								(refusal) => refusal,
							),
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
