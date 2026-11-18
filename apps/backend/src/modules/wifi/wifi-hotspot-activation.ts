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

import type { WifiAdapterMode } from "@ceraui/rpc/schemas";
import { randomBase64 } from "../../helpers/crypto.ts";
import { logger } from "../../helpers/logger.ts";
import { setNetifDupIpSuppression } from "../network/network-interfaces.ts";
import {
	NmApConnAddError,
	nmApConnAdd,
	nmConnDelete,
	nmConnect,
	nmConnGetFields,
	nmConnSetFields,
	nmDeviceProp,
	nmDisconnect,
} from "../network/network-manager.ts";
import {
	type NmProfileInstance,
	readNmProfileInstance,
	sameNmProfileActivation,
} from "../network/network-manager-profile-instance.ts";
import {
	isNmWifiSecretAvailable,
	readVerifiedNmWifiSecret,
} from "../network/network-manager-secret.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { hotspotCredentialsStore } from "./hotspot-credentials.ts";
import { getWifiState, setWifiState } from "./state/wifi-state.ts";
import { broadcastWifiState, wifiUpdateSavedConns } from "./wifi.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import {
	getPersistedWifiAdapterMode,
	observedWifiAdapterMode,
	recordWifiAdapterModeIntent,
	wifiAdapterModeCapability,
	wifiAdapterModeRecorder,
} from "./wifi-adapter-mode.ts";
import { resolveWifiAdapterOwner } from "./wifi-adapter-owner.ts";
import {
	clearWifiAdapterReconcile,
	reconcileWifiAdapterTeardownLocked,
} from "./wifi-adapter-reconcile-retry.ts";
import { reconcileWifiAdapterProfileLocked } from "./wifi-adapter-reconciler.ts";
import {
	hotspotAutoconnectFields,
	hotspotDevicePath,
} from "./wifi-autoconnect-policy.ts";
import { admitWifiRequest } from "./wifi-binding.ts";
import { getWifiCapabilitiesForInterface } from "./wifi-capabilities.ts";
import { nmSettingsForChannel } from "./wifi-channels.ts";
import {
	concurrentHotspotBindingFields,
	confirmHybridActivation,
	HYBRID_CHANNEL_REFUSAL,
	readHybridStationChannel,
	releaseConcurrentApInterface,
	releaseCreatedHybridTarget,
	revalidateConcurrentApInterface,
	selectConcurrentApInterface,
} from "./wifi-concurrent-interface.ts";
import { getWifiInterfaceByMacAddress } from "./wifi-connections.ts";
import { cleanupCreatedHotspotProfile } from "./wifi-hotspot-cleanup.ts";
import {
	canAdoptHotspotProfile,
	findHotspotConnForAdapter,
	getHotspotProfilePin,
	hotspotOwnershipGuard,
	pruneDuplicateHotspotConns,
	rememberHotspotProfilePin,
} from "./wifi-hotspot-discovery.ts";
import {
	beginHotspotTransition,
	registerPendingConfirmation,
	syncWifiStateCache,
} from "./wifi-hotspot-monitor.ts";
import { publishHotspotOutcome } from "./wifi-hotspot-outcome.ts";
import {
	type HotspotProfileOperation,
	runHotspotProfileOperation,
} from "./wifi-hotspot-profile-operation.ts";
import {
	DEFAULT_HOTSPOT_SECURITY,
	hotspotSecurityFields,
} from "./wifi-hotspot-security.ts";
import {
	canHotspot,
	HOTSPOT_UP_TO,
	type HotspotActivationDeps,
	type HotspotStartResult,
	hotspotBindingFields,
	isHotspotActive,
	type WifiHotspotMessage,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import {
	getMacAddressForWifiInterface,
	wifiUpdateDevices,
} from "./wifi-interfaces.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";
import { transitionVirtualBinding } from "./wifi-virtual-binding.ts";

/** Production defaults: real NetworkManager + broadcast + dup-IP suppression. */
export const defaultHotspotDeps: HotspotActivationDeps = {
	recordIntent: {
		read: (key) => wifiAdapterModeRecorder.read(key),
		persist: (key, mode) => wifiAdapterModeRecorder.persist(key, mode),
		restore: (key, previous) => wifiAdapterModeRecorder.restore(key, previous),
	},
	readCapabilities: getWifiCapabilitiesForInterface,
	nmConnect,
	nmConnSetFields,
	nmApConnAdd,
	nmConnDelete,
	nmDisconnect,
	readProfileInstance: readNmProfileInstance,
	wifiUpdateSavedConns,
	broadcastState: broadcastWifiState,
	setDupIpSuppression: setNetifDupIpSuppression,
	credentials: hotspotCredentialsStore,
	findHotspotConn: findHotspotConnForAdapter,
	pruneHotspotConns: async (macAddress, keepUuid) => {
		await pruneDuplicateHotspotConns(macAddress, keepUuid);
	},
	ensureConcurrentInterface: async (ifname, admitted) =>
		(await selectConcurrentApInterface(ifname, admitted, true)) ??
		HYBRID_CHANNEL_REFUSAL,
	readHybridChannel: readHybridStationChannel,
	validateConcurrentInterface: revalidateConcurrentApInterface,
	confirmHybridActivation,
	releaseConcurrentInterface: releaseConcurrentApInterface,
	rollbackConcurrentInterface: releaseCreatedHybridTarget,
	preferConcurrentAp: (macAddress) =>
		getPersistedWifiAdapterMode(macAddress) !== "hotspot",
	publishOutcome: publishHotspotOutcome,
	pollHotspotActive: async (
		iface,
		uuid = iface.hotspot.conn,
		activationIfname = iface.concurrentHotspot?.ifname ?? iface.ifname,
		activation,
	) => {
		await wifiUpdateDevices();
		if (!uuid) return false;
		const fields = activation
			? "GENERAL.STATE,GENERAL.CON-UUID,GENERAL.CON-PATH"
			: "GENERAL.STATE,GENERAL.CON-UUID";
		const before = await nmDeviceProp(activationIfname, fields);
		if (Number.parseInt(before?.[0] ?? "", 10) !== 100 || before?.[1] !== uuid)
			return false;
		if (
			activation &&
			(!activation.activePath ||
				before?.[2] !== activation.activePath ||
				!sameNmProfileActivation(
					activation.profile,
					await readNmProfileInstance(uuid),
				))
		)
			return false;
		const mode = await nmConnGetFields(uuid, ["802-11-wireless.mode"] as const);
		if (mode?.[0] !== "ap") return false;
		const after = await nmDeviceProp(activationIfname, fields);
		return (
			Number.parseInt(after?.[0] ?? "", 10) === 100 &&
			after?.[1] === uuid &&
			(!activation ||
				(after?.[2] === activation.activePath &&
					sameNmProfileActivation(
						activation.profile,
						await readNmProfileInstance(uuid),
					)))
		);
	},
};

// ─── identity (resolved and persisted BEFORE any activation) ─────────────────

/** The credentials the next start of an adapter will broadcast. */
export type HotspotIdentity = {
	conn?: string;
	name: string;
	password: string;
	profileMac?: string;
};

function rememberIdentity(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotActivationDeps,
	conn?: string,
	profileMac?: string,
): void {
	if (!hotspotOwnershipGuard(macAddress, wifiInterface)(conn, profileMac))
		return;
	const { name, password, channel } = wifiInterface.hotspot;
	if (!name || !password) return;
	deps.credentials.remember(macAddress, {
		ssid: name,
		password,
		...(conn !== undefined ? { conn } : {}),
		...(channel !== undefined ? { channel } : {}),
	});
}

/*
  The ONE resolution order, shared by the start and by the pre-activation read
  (#413): live profile -> discovered profile -> persisted identity -> generated.
  Discovery runs BEFORE generation so a restart (which wipes `hotspot.conn`)
  finds the adapter's profile rather than minting an identity no phone knows.
  A generated identity is PERSISTED here, before anything is activated, so the
  credentials an operator was shown are the ones the AP will broadcast.
*/
async function resolveHotspotIdentity(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotActivationDeps,
): Promise<HotspotIdentity | undefined> {
	const physicalMac = normalizeMacAddress(macAddress.split("@")[0]);
	if (!physicalMac) return undefined;
	const stored = deps.credentials.get(macAddress);
	const hotspot = wifiInterface.hotspot;
	let profileMac = getHotspotProfilePin(hotspot, hotspot.conn);
	const owned = hotspotOwnershipGuard(macAddress, wifiInterface, stored?.conn);
	if (!owned()) return undefined;
	if (!hotspot.conn || !hotspot.name || !hotspot.password) {
		const existing = await deps.findHotspotConn(macAddress, stored);
		if (!owned()) return undefined;
		if (existing) {
			if (
				!canAdoptHotspotProfile(
					macAddress,
					existing.uuid,
					existing.macAddress ?? "",
				)
			)
				return undefined;
			profileMac = existing.macAddress ?? "";
			const password = await readVerifiedNmWifiSecret(existing.uuid, {
				"802-11-wireless.ssid": existing.ssid,
				"802-11-wireless.mac-address": profileMac,
			});
			if (!owned() || !owned(existing.uuid, profileMac)) return undefined;
			if (password === undefined && isNmWifiSecretAvailable(existing.password))
				return undefined;
			rememberHotspotProfilePin(hotspot, existing.uuid, profileMac);
			hotspot.conn = existing.uuid;
			hotspot.name = existing.ssid;
			hotspot.password = password ?? "";
			hotspot.channel =
				wifiInterface.concurrentHotspot || existing.macAddress === ""
					? (stored?.channel ?? existing.channel)
					: existing.channel;
		}
	}
	if (hotspot.conn && hotspot.name && hotspot.password) {
		return {
			conn: hotspot.conn,
			name: hotspot.name,
			password: hotspot.password,
			...(profileMac !== undefined ? { profileMac } : {}),
		};
	}
	const ms = physicalMac.split(":");
	const name = stored?.ssid ?? `CERALIVE_${ms[4]}${ms[5]}`;
	const password = stored?.password ?? randomBase64(9);
	// A live profile whose secrets could not be read back is made to match what
	// is about to be shown, so the display can never disagree with the AP.
	if (hotspot.conn) {
		const credentialUuid = hotspot.conn;
		const written = await runHotspotProfileOperation({
			uuid: credentialUuid,
			kind: "modify",
			fields: {
				"802-11-wireless.ssid": name,
				"802-11-wireless-security.psk": password,
			},
			run: (fields) => deps.nmConnSetFields(credentialUuid, fields),
		});
		if (!written.success) return undefined;
		if (!owned() || !owned(hotspot.conn, profileMac)) return undefined;
	}
	hotspot.name = name;
	hotspot.password = password;
	hotspot.channel ??= stored?.channel ?? "auto";
	rememberIdentity(
		macAddress,
		wifiInterface,
		deps,
		hotspot.conn ?? stored?.conn,
		profileMac,
	);
	return {
		...(hotspot.conn !== undefined ? { conn: hotspot.conn } : {}),
		name,
		password,
		...(profileMac !== undefined ? { profileMac } : {}),
	};
}

export type HotspotPrepareResult =
	| { success: true; name: string; password: string; firstTime?: true }
	| {
			success: false;
			error:
				| "DEVICE_BUSY"
				| "no-device"
				| "unsupported"
				| "activation-failed"
				| "radio-unverified"
				| "binding-required"
				| "radio-changed";
			reason?: string;
	  };

/**
 * Resolve - and, when the operator chose their own, store - the credentials the
 * next start will broadcast, WITHOUT activating anything (#413). An adapter whose
 * AP is already up answers with its live credentials and accepts no change here:
 * a live AP is reconfigured through `hotspotConfigure`.
 */
export async function wifiHotspotPrepare(
	msg: { device: number; name?: string; password?: string },
	deps: HotspotActivationDeps = defaultHotspotDeps,
): Promise<HotspotPrepareResult> {
	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return { success: false, error: "no-device" };
	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return { success: false, error: "no-device" };
	if (!canHotspot(wifiInterface))
		return { success: false, error: "unsupported" };
	return prepareHotspotForInterface(macAddress, wifiInterface, msg, deps);
}

/** {@link wifiHotspotPrepare} for a resolved adapter, under its adapter lock. */
export async function prepareHotspotForInterface(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	msg: { name?: string; password?: string },
	deps: HotspotActivationDeps = defaultHotspotDeps,
): Promise<HotspotPrepareResult> {
	const owned = hotspotOwnershipGuard(
		resolveWifiAdapterOwner(macAddress, wifiInterface),
		wifiInterface,
	);
	const lock = await withWifiAdapterLock(wifiAdapterLockKey(macAddress), () =>
		admitWifiRequest(
			wifiInterface,
			() => prepareHotspotLocked(macAddress, wifiInterface, msg, deps),
			(refusal) => refusal,
		),
	);
	if (!lock.success) return { success: false, error: lock.error };
	if (lock.result.success && !owned()) {
		return { success: false, error: "activation-failed" };
	}
	return lock.result;
}

async function prepareHotspotLocked(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	msg: { name?: string; password?: string },
	deps: HotspotActivationDeps,
): Promise<HotspotPrepareResult> {
	if (
		!normalizeMacAddress(macAddress) ||
		wifiInterface.degradedReason === "permanent-mac-unresolved"
	)
		return { success: false, error: "radio-unverified" };
	const owner = resolveWifiAdapterOwner(macAddress, wifiInterface);
	const owned = hotspotOwnershipGuard(owner, wifiInterface);
	const identity = await resolveHotspotIdentity(owner, wifiInterface, deps);
	if (!identity || !owned(identity.conn, identity.profileMac)) {
		return { success: false, error: "activation-failed" };
	}
	// No profile, and the store has never recorded one: this adapter has never
	// hosted an AP, so the shown pair is a suggestion rather than a saved setup.
	const firstTime =
		!identity.conn && !deps.credentials.get(owner)?.conn
			? ({ firstTime: true } as const)
			: {};
	const chosen =
		msg.name !== undefined && msg.password !== undefined
			? { name: msg.name, password: msg.password }
			: undefined;
	if (
		!chosen ||
		isHotspotActive(wifiInterface) ||
		(chosen.name === identity.name && chosen.password === identity.password)
	) {
		return {
			success: true,
			name: identity.name,
			password: identity.password,
			...firstTime,
		};
	}
	// The profile is written FIRST: a store that ran ahead of a refused write
	// would show the operator credentials the AP never broadcasts.
	if (!owned(identity.conn, identity.profileMac)) {
		return { success: false, error: "activation-failed" };
	}
	const credentialUuid = identity.conn;
	if (
		credentialUuid &&
		!(
			await runHotspotProfileOperation({
				uuid: credentialUuid,
				kind: "modify",
				fields: {
					"802-11-wireless.ssid": chosen.name,
					"802-11-wireless-security.psk": chosen.password,
				},
				run: (fields) => deps.nmConnSetFields(credentialUuid, fields),
			})
		).success
	) {
		return { success: false, error: "activation-failed" };
	}
	if (!owned(identity.conn, identity.profileMac)) {
		return { success: false, error: "activation-failed" };
	}
	wifiInterface.hotspot.name = chosen.name;
	wifiInterface.hotspot.password = chosen.password;
	rememberIdentity(
		owner,
		wifiInterface,
		deps,
		identity.conn,
		identity.profileMac,
	);
	return { success: true, ...chosen, ...firstTime };
}

// ─── start (atomic, NM-confirmed, with rollback) ─────────────────────────────

export async function wifiHotspotStart(
	msg: NonNullable<WifiHotspotMessage["hotspot"]["start"]>,
	deps: HotspotActivationDeps = defaultHotspotDeps,
): Promise<HotspotStartResult> {
	const result = await resolveAndStart(msg, deps);
	/*
	  A refusal ends here, so it is published here. A SUCCESS is deliberately not:
	  it means the transaction was admitted, and the terminal frame for it is owed
	  by whichever branch actually resolved the outcome — the already-active
	  short-circuit publishes immediately, a real activation publishes when the
	  bounded NM confirmation settles. Publishing success twice would resolve the
	  operator's op before NetworkManager has answered.
	*/
	if (!result.success) deps.publishOutcome?.("start", msg.device, result);
	return result;
}

async function resolveAndStart(
	msg: NonNullable<WifiHotspotMessage["hotspot"]["start"]>,
	deps: HotspotActivationDeps,
): Promise<HotspotStartResult> {
	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return { success: false, error: "no-device" };

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return { success: false, error: "no-device" };
	if (!canHotspot(wifiInterface))
		return { success: false, error: "unsupported" };

	return startHotspotForInterface(macAddress, wifiInterface, deps);
}

/**
 * Atomic station→hotspot switch for a resolved interface. Serialized per ADAPTER
 * under the canonical permanent-MAC key — the same key the RPC layer's
 * `runGuarded` acquires — so a concurrent request from either layer returns
 * `DEVICE_BUSY` without touching state.
 *
 * It is keyed on the adapter, never on `wifiInterface.ifname`: the AP+STA
 * concurrent path activates on a SECOND, virtual interface belonging to this
 * same radio, so an ifname key would leave the parent's station mutations
 * unguarded for the whole activation.
 */
export async function startHotspotForInterface(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotActivationDeps = defaultHotspotDeps,
): Promise<HotspotStartResult> {
	const lock = await withWifiAdapterLock(wifiAdapterLockKey(macAddress), () =>
		admitWifiRequest(
			wifiInterface,
			async (): Promise<HotspotStartResult> => {
				let undo: (() => void) | undefined;
				let succeeded = false;
				try {
					const result = await startHotspotLocked(
						macAddress,
						wifiInterface,
						deps,
						(target) => {
							if (deps.recordIntent) {
								undo = recordWifiAdapterModeIntent(
									resolveWifiAdapterOwner(macAddress, wifiInterface),
									target,
									deps.recordIntent,
								);
							}
						},
					);
					succeeded = result.success;
					return result;
				} finally {
					if (!succeeded) undo?.();
				}
			},
			(refusal) => refusal,
		),
	);
	if (!lock.success) return { success: false, error: lock.error };
	return lock.result;
}

/**
 * Internal delegate: the caller owns the adapter lock, its intent transaction
 * and request admission, so a mode transition's start never re-admits after it
 * has already changed the radio.
 */
export async function startHotspotLocked(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotActivationDeps,
	recordIntent?: (target: WifiAdapterMode) => void,
): Promise<HotspotStartResult> {
	const owner = resolveWifiAdapterOwner(macAddress, wifiInterface);
	if (!(await reconcileWifiAdapterTeardownLocked(owner)).complete)
		return {
			success: false,
			error: "activation-failed",
			reason: "cleanup-pending",
		};
	if (
		!normalizeMacAddress(macAddress) ||
		wifiInterface.degradedReason === "permanent-mac-unresolved"
	)
		return { success: false, error: "radio-unverified" };
	const ifname = wifiInterface.ifname;
	const owned = hotspotOwnershipGuard(owner, wifiInterface);
	if (!owned()) {
		return { success: false, error: "activation-failed" };
	}
	const stopRejectedHybrid = async (uuid: string): Promise<void> => {
		const virtual = wifiInterface.concurrentHotspot;
		if (!virtual || !owned(uuid)) return;
		const stopped = await runHotspotProfileOperation({
			uuid,
			kind: "down",
			run: async () => owned(uuid) && deps.nmDisconnect(uuid),
		});
		if (!stopped.success) return;
		if (wifiInterface.concurrentHotspot === virtual)
			transitionVirtualBinding(wifiInterface, { kind: "retire" });
		await deps.releaseConcurrentInterface?.(virtual.ifname);
		deps.broadcastState();
		syncWifiStateCache(macAddress, wifiInterface);
	};
	const rawCapability = deps.readCapabilities?.(ifname);
	const concurrency = deps.readCapabilities
		? wifiAdapterModeCapability(wifiInterface, () => rawCapability)
				.staApComboSupported
		: wifiInterface.supportsApStaConcurrency;
	const intent = getPersistedWifiAdapterMode(owner);
	const recordChosenMode = (mode: WifiAdapterMode): void => {
		recordIntent?.(mode);
	};
	const useConcurrentAp =
		concurrency === true && (deps.preferConcurrentAp?.(owner) ?? true);
	const hybridChannel =
		useConcurrentAp && deps.readHybridChannel
			? await deps.readHybridChannel(ifname)
			: undefined;
	if (!owned()) return { success: false, error: "activation-failed" };
	if (useConcurrentAp && deps.readHybridChannel && !hybridChannel) {
		const active = wifiInterface.concurrentHotspot?.activeConn;
		if (active && active === wifiInterface.hotspot.conn && owned(active)) {
			await stopRejectedHybrid(active);
		}
		return {
			success: false,
			error: "activation-failed",
			reason: HYBRID_CHANNEL_REFUSAL,
		};
	}
	if (
		intent === "hybrid" &&
		!useConcurrentAp &&
		observedWifiAdapterMode(wifiInterface) !== "hybrid"
	) {
		logger.warn(
			`wifi hotspot start: activation-failed on ${ifname}; hybrid capability is not proven`,
		);
		return {
			success: false,
			error: "activation-failed",
			...(rawCapability?.staApCombo.supported === true && concurrency !== true
				? { reason: HYBRID_CHANNEL_REFUSAL }
				: {}),
		};
	}
	if (
		wifiInterface.hotspot.conn &&
		(wifiInterface.conn === wifiInterface.hotspot.conn ||
			wifiInterface.activeConn === wifiInterface.hotspot.conn ||
			wifiInterface.concurrentHotspot?.activeConn ===
				wifiInterface.hotspot.conn)
	) {
		const virtual = wifiInterface.concurrentHotspot;
		if (
			virtual &&
			hybridChannel &&
			deps.confirmHybridActivation &&
			!(await deps.confirmHybridActivation(
				ifname,
				virtual.ifname,
				wifiInterface.hotspot.conn,
				hybridChannel,
			))
		) {
			await stopRejectedHybrid(wifiInterface.hotspot.conn);
			return {
				success: false,
				error: "activation-failed",
				reason: HYBRID_CHANNEL_REFUSAL,
			};
		}
		// Already up: nothing is dispatched, so no confirmation will ever settle
		// and this branch owes the terminal frame itself.
		recordChosenMode(observedWifiAdapterMode(wifiInterface));
		deps.publishOutcome?.("start", wifiInterface.id, { success: true });
		return { success: true };
	}
	/*
	  Capability answers whether this radio CAN keep its station leg; the operator's
	  persisted mode answers whether it SHOULD. `hotspot` means an EXCLUSIVE access
	  point, so a capable radio must still take the exclusive path when that is what
	  was asked for. An adapter with no stated preference resolves to concurrency,
	  which is the behaviour every capable radio had before the mode was selectable.
	*/
	if (!useConcurrentAp && wifiInterface.conn && getIsStreaming()) {
		logger.warn(
			`wifi hotspot start: streaming keeps the station link on ${ifname}`,
		);
		return { success: false, error: "DEVICE_BUSY" };
	}
	recordChosenMode(useConcurrentAp ? "hybrid" : "hotspot");
	const allocation = useConcurrentAp
		? await deps.ensureConcurrentInterface?.(ifname, () => owned())
		: undefined;
	const concurrentInterface =
		allocation === HYBRID_CHANNEL_REFUSAL ? undefined : allocation;
	let channelRefused = false;
	let acceptedAllocation = false;
	const hotspot = wifiInterface.hotspot;
	let createdUuid: string | undefined;
	let profileInstance: NmProfileInstance | null | undefined;
	const writeProfile = async (
		operation: HotspotProfileOperation,
	): Promise<boolean> => {
		const result = await runHotspotProfileOperation(operation, {
			instance: profileInstance,
			readProfileInstance: deps.readProfileInstance,
			recordCreation: deps.credentials.recordCreation,
			owner,
			optional: true,
		});
		profileInstance = result.instance;
		return result.success;
	};
	let activePath: string | undefined;
	const activated = (path: string) => {
		activePath = path;
	};
	let activationAttempted = false;
	let failedAdd: NmApConnAddError | undefined;
	let cleanupConfirmed = true;
	let refusal: HotspotStartResult | undefined;
	let rollbackState: (() => HotspotStartResult) | undefined;
	try {
		if (!owned()) {
			return { success: false, error: "activation-failed" };
		}
		if (useConcurrentAp && concurrentInterface === undefined) {
			logger.warn(
				`wifi hotspot start: unreconciled hybrid target on ${ifname}`,
			);
			return {
				success: false,
				error: "activation-failed",
				...(allocation === HYBRID_CHANNEL_REFUSAL
					? { reason: HYBRID_CHANNEL_REFUSAL }
					: {}),
			};
		}
		const activationIfname = concurrentInterface?.ifname ?? ifname;
		const bindingFields: Record<string, string> = concurrentInterface
			? {
					...concurrentHotspotBindingFields(ifname),
					"connection.interface-name": concurrentInterface.ifname,
					"match.path": "",
					"connection.autoconnect": "no",
					"connection.autoconnect-priority": "999",
					...hotspotSecurityFields(
						wifiInterface.hotspot.security ?? DEFAULT_HOTSPOT_SECURITY,
					),
					...hybridChannel?.fields,
				}
			: hotspotBindingFields(
					macAddress,
					wifiInterface.hotspot.security,
					hotspotDevicePath(macAddress, ifname),
				);
		if (concurrentInterface) {
			wifiInterface.supportsApStaConcurrency = true;
			transitionVirtualBinding(wifiInterface, {
				kind: "pending",
				ifname: concurrentInterface.ifname,
			});
		}

		// Snapshot prior state for rollback. getWifiState() returns the live cache
		// reference; syncing below swaps in a NEW object, so this stays the old one.
		const priorCache = getWifiState();
		const priorConn = wifiInterface.conn;

		// Begin the transition: broadcast `activating` immediately (responsive UI),
		// suppress dup-IP warnings for the window, but DO NOT flip mode yet.
		beginHotspotTransition(wifiInterface, "activating");
		if (!concurrentInterface) deps.setDupIpSuppression(ifname, true);
		deps.broadcastState();
		syncWifiStateCache(macAddress, wifiInterface); // still station (isHotspot false)

		rollbackState = (): HotspotStartResult => {
			if (wifiInterface.hotspot !== hotspot)
				return { success: false, error: "activation-failed" };
			delete wifiInterface.hotspot.transition;
			wifiInterface.conn = priorConn;
			if (!concurrentInterface) deps.setDupIpSuppression(ifname, false);
			// Restore the cached state so it is NEVER left in hotspot mode on failure.
			setWifiState(priorCache);
			transitionVirtualBinding(wifiInterface, { kind: "retire" });
			deps.broadcastState();
			return {
				success: false,
				error: "activation-failed",
				...(channelRefused ? { reason: HYBRID_CHANNEL_REFUSAL } : {}),
			};
		};
		const rollback = (): HotspotStartResult => {
			refusal = {
				success: false,
				error: "activation-failed",
				...(channelRefused ? { reason: HYBRID_CHANNEL_REFUSAL } : {}),
			};
			return refusal;
		};

		// The SAME resolution `wifiHotspotPrepare` showed the operator, so the AP
		// broadcasts exactly the credentials they acknowledged.
		const identity = await resolveHotspotIdentity(owner, wifiInterface, deps);
		if (!identity || !owned(identity.conn, identity.profileMac))
			return rollback();
		let conn = identity.conn;
		const exclusiveChannel =
			!concurrentInterface && wifiInterface.hotspot.channel
				? nmSettingsForChannel(
						wifiInterface.hotspot.channel,
						wifiInterface.hotspot.derivedChannels ?? [],
					)
				: undefined;
		// A hybrid profile carries an effective SCC channel, not the saved hotspot-only choice.
		if (
			exclusiveChannel &&
			(identity.profileMac === "" ||
				(!conn && exclusiveChannel.nmChannel !== ""))
		)
			Object.assign(bindingFields, {
				"802-11-wireless.band": exclusiveChannel.nmBand,
				"802-11-wireless.channel": exclusiveChannel.nmChannel,
			});
		// The leg's identity and bindings are rechecked immediately before each profile write.
		const leg = async (): Promise<boolean> => {
			if (
				!concurrentInterface ||
				!deps.validateConcurrentInterface ||
				(await deps.validateConcurrentInterface(concurrentInterface))
			)
				return true;
			channelRefused = true;
			return false;
		};
		const ready = async (): Promise<boolean> => {
			if (!owned(conn, identity.profileMac)) return false;
			if (
				hybridChannel &&
				deps.readHybridChannel &&
				(await deps.readHybridChannel(ifname))?.identity !==
					hybridChannel.identity
			) {
				channelRefused = true;
				return false;
			}
			return leg();
		};
		const confirmed = async (uuid: string): Promise<boolean> => {
			if (
				!concurrentInterface ||
				!hybridChannel ||
				!deps.confirmHybridActivation
			)
				return true;
			if (
				await deps.confirmHybridActivation(
					ifname,
					concurrentInterface.ifname,
					uuid,
					hybridChannel,
				)
			)
				return true;
			channelRefused = true;
			if (owned(uuid, identity.profileMac))
				await writeProfile({
					uuid,
					kind: "down",
					run: async () =>
						owned(uuid, identity.profileMac) && deps.nmDisconnect(uuid),
				});
			return false;
		};

		// Cleanup is best-effort, runs off the critical path, and never fails a start.
		const prune = (keepUuid: string) => {
			void deps
				.pruneHotspotConns(owner, keepUuid)
				.catch((err) => logger.debug(`hotspot profile cleanup failed: ${err}`));
		};

		if (conn) {
			const existingUuid = conn;
			await deps.wifiUpdateSavedConns();
			if (!owned(conn, identity.profileMac)) return rollback();
			profileInstance = await deps.readProfileInstance?.(conn);
			const rebound = await writeProfile({
				uuid: existingUuid,
				kind: "modify",
				fields: bindingFields,
				run: async (fields) =>
					(await leg()) && deps.nmConnSetFields(existingUuid, fields),
			});
			if (!owned(conn, identity.profileMac)) return rollback();
			if (!rebound) return rollback();
			prune(conn);
			if (
				!(await writeProfile({
					uuid: existingUuid,
					kind: "up",
					run: async () => {
						if (!(await ready())) return false;
						return deps.nmConnect(existingUuid, HOTSPOT_UP_TO, activated);
					},
				}))
			) {
				return rollback();
			}
			if (!(await confirmed(conn))) return rollback();
			if (!owned(conn, identity.profileMac)) return rollback();
			await reconcileWifiAdapterProfileLocked(owner, {
				uuid: conn,
				fields: hotspotAutoconnectFields(owner, bindingFields),
				write: (id, fields) =>
					writeProfile({
						uuid: id,
						kind: "modify",
						fields,
						run: (delta) => deps.nmConnSetFields(id, delta),
					}),
			});
			if (!owned(conn, identity.profileMac)) return rollback();
			rememberIdentity(owner, wifiInterface, deps, conn, identity.profileMac);
			rememberHotspotProfilePin(
				wifiInterface.hotspot,
				conn,
				bindingFields["802-11-wireless.mac-address"],
			);
		} else {
			// First hotspot this adapter has ever hosted, or its profile was deleted
			// outside CeraUI: the identity resolved (and already persisted) above.
			deps.broadcastState();
			syncWifiStateCache(macAddress, wifiInterface);

			let uuid: string | undefined;
			let creationRecorded = false;
			if (!(await leg())) return rollback();
			try {
				uuid = await deps.nmApConnAdd(
					activationIfname,
					identity,
					bindingFields,
					(generated, checked) => {
						if (checked) profileInstance = checked;
						if (!deps.credentials.recordCreation) return true;
						creationRecorded = deps.credentials.recordCreation(
							owner,
							generated,
							checked,
						);
						return creationRecorded;
					},
				);
			} catch (error) {
				if (!(error instanceof NmApConnAddError)) throw error;
				createdUuid = error.uuid;
				profileInstance = error.instance;
				failedAdd = error;
				return rollback();
			}
			if (!uuid) return rollback();
			createdUuid = uuid;
			// shortcut: an exact clone before checked add readback needs an authoritative add-object receipt to distinguish it.
			if (!owned(uuid)) return rollback();
			if (
				creationRecorded &&
				(!profileInstance?.file ||
					!deps.credentials.recordCreation?.(owner, uuid, profileInstance))
			)
				return rollback();
			if (creationRecorded) clearWifiAdapterReconcile(owner, "authority");
			await deps.wifiUpdateSavedConns();
			if (!owned(uuid)) return rollback();
			prune(uuid);
			if (
				!(await writeProfile({
					uuid,
					kind: "up",
					run: async () => {
						if (!(await ready())) return false;
						activationAttempted = true;
						return deps.nmConnect(uuid, HOTSPOT_UP_TO, activated);
					},
				}))
			)
				return rollback();
			if (!(await confirmed(uuid))) return rollback();
			if (!owned(uuid)) return rollback();
			if (
				!(await reconcileWifiAdapterProfileLocked(owner, {
					uuid,
					fields: hotspotAutoconnectFields(owner, bindingFields),
					write: (id, fields) =>
						writeProfile({
							uuid: id,
							kind: "modify",
							fields,
							run: (delta) => deps.nmConnSetFields(id, delta),
						}),
				}))
			)
				return rollback();
			if (!owned(uuid)) return rollback();
			conn = uuid;
			wifiInterface.hotspot.conn ??= uuid;
			rememberIdentity(owner, wifiInterface, deps, uuid);
			rememberHotspotProfilePin(
				wifiInterface.hotspot,
				uuid,
				bindingFields["802-11-wireless.mac-address"],
			);
		}

		// NM activation issued successfully. The mode flip waits for confirmation —
		// it does NOT block this call (so the UI shows `activating` meanwhile).
		registerPendingConfirmation(
			{
				macAddress,
				uuid: conn,
				ifname: activationIfname,
				credentialOwner: owner,
				activation: { profile: profileInstance, activePath },
			},
			wifiInterface,
			deps,
		);
		acceptedAllocation = true;
		return { success: true };
	} finally {
		if (!acceptedAllocation && createdUuid) {
			cleanupConfirmed = await cleanupCreatedHotspotProfile(
				owner,
				{
					uuid: createdUuid,
					registryKey: macAddress,
					iface: wifiInterface,
					hotspot,
					activationAttempted,
					instance: profileInstance,
					...(concurrentInterface ? { allocation: concurrentInterface } : {}),
				},
				deps,
				failedAdd,
			);
			if (!cleanupConfirmed && refusal && !refusal.success)
				refusal.reason = "cleanup-pending";
		}
		if (!acceptedAllocation && cleanupConfirmed) {
			try {
				rollbackState?.();
			} catch (rollbackError) {
				logger.warn("Wi-Fi hotspot activation state rollback failed", {
					error:
						rollbackError instanceof Error ? rollbackError.name : "unknown",
				});
			}
		}
		if (!acceptedAllocation && concurrentInterface) {
			await deps.releaseConcurrentInterface?.(concurrentInterface.ifname);
			if (
				!createdUuid &&
				concurrentInterface.created &&
				deps.rollbackConcurrentInterface
			)
				await deps.rollbackConcurrentInterface(concurrentInterface);
		}
	}
}
