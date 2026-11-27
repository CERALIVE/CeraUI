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
import {
	type ProfileWriteAdmission,
	profileAdmissionCurrent,
} from "../network/profile-write-permit.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import {
	hotspotCredentialsStore,
	isHotspotPortCredentialCopy,
} from "./hotspot-credentials.ts";
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
import { seedWifiPortMode } from "./wifi-adapter-mode-intent.ts";
import { resolveWifiAdapterOwner } from "./wifi-adapter-owner.ts";
import {
	clearWifiAdapterReconcile,
	reconcileWifiAdapterTeardownLocked,
	registerWifiAdapterLegRelease,
} from "./wifi-adapter-reconcile-retry.ts";
import { reconcileWifiAdapterProfileLocked } from "./wifi-adapter-reconciler.ts";
import {
	hotspotAutoconnectPolicy,
	hotspotDevicePath,
} from "./wifi-autoconnect-policy.ts";
import { admitWifiRequest } from "./wifi-binding.ts";
import { getWifiCapabilitiesForInterface } from "./wifi-capabilities.ts";
import { nmSettingsForChannel } from "./wifi-channels.ts";
import {
	concurrentApIfname,
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
import {
	type NmActivationReceipt,
	nmDisconnectActivation,
	observeHotspotActivation,
} from "./wifi-hotspot-activity.ts";
import { cleanupCreatedHotspotProfile } from "./wifi-hotspot-cleanup.ts";
import {
	findHotspotConnForAdapter,
	getHotspotProfilePin,
	hasCompatibleHotspotProfile,
	hotspotOwnershipGuard,
	hotspotProfileMatchesRadio,
	isObservedForeignHotspot,
	pruneDuplicateHotspotConns,
	rememberHotspotProfilePin,
} from "./wifi-hotspot-discovery.ts";
import {
	beginHotspotTransition,
	matchesHotspotActivation,
	registerPendingConfirmation,
	syncWifiStateCache,
} from "./wifi-hotspot-monitor.ts";
import { publishHotspotOutcome } from "./wifi-hotspot-outcome.ts";
import {
	canWriteSavedHotspotPins,
	type HotspotProfileOperation,
	permitsHotspotProfilePins,
	readHotspotProfilePins,
	runHotspotProfileOperation,
	savedHotspotStartPinGuard,
	writeHotspotProfileFields,
} from "./wifi-hotspot-profile-operation.ts";
import {
	DEFAULT_HOTSPOT_SECURITY,
	hotspotSecurityFields,
} from "./wifi-hotspot-security.ts";
import { retireReplacedHotspotTransition } from "./wifi-hotspot-transition.ts";
import {
	canHotspot,
	type ExistingHotspotConn,
	HOTSPOT_UP_TO,
	type HotspotActivationDeps,
	type HotspotStartPublication,
	type HotspotStartResult,
	hotspotBindingFields,
	isHotspotActive,
	type WifiHotspotMessage,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import { releaseHybridLeg } from "./wifi-hybrid-leg-release.ts";
import {
	type HybridChannelRefusal,
	type HybridRestoreAttempt,
	type HybridTargetRefusal,
	logHybridChannelRefusal,
	logHybridTargetRefusal,
} from "./wifi-hybrid-target-diagnostics.ts";
import { targetRecords } from "./wifi-hybrid-target-record.ts";
import {
	getMacAddressForWifiInterface,
	wifiUpdateDevices,
} from "./wifi-interfaces.ts";
import { holdWifiModeWitness } from "./wifi-mode-witness.ts";
import {
	bindingForRow,
	sampleWifiOperationRadio,
	soleWifiPortAlias,
	verifiedWifiPortKey,
	type WifiOperationBinding,
	wifiLegLifetimeProof,
	wifiOperationChanged,
	wifiOperationGuard,
} from "./wifi-operation-binding.ts";
import {
	normalizeMacAddress,
	wifiAdapterKeyMac,
} from "./wifi-permanent-mac.ts";
import { sameRadioLifetime } from "./wifi-radio-identity.ts";
import type { RadioSample } from "./wifi-radio-read-budget.ts";
import { transitionVirtualBinding } from "./wifi-virtual-binding.ts";

/** Production defaults: real NetworkManager + broadcast + dup-IP suppression. */
export const defaultHotspotDeps: HotspotActivationDeps = {
	recordIntent: {
		read: (key) => wifiAdapterModeRecorder.read(key),
		persist: (...args) => wifiAdapterModeRecorder.persist(...args),
		restore: (...args) => wifiAdapterModeRecorder.restore(...args),
	},
	readCapabilities: getWifiCapabilitiesForInterface,
	nmConnect,
	nmConnSetFields,
	nmApConnAdd,
	nmConnDelete,
	nmDisconnect,
	readProfileInstance: readNmProfileInstance,
	readProfilePins: readHotspotProfilePins,
	wifiUpdateSavedConns,
	broadcastState: broadcastWifiState,
	setDupIpSuppression: setNetifDupIpSuppression,
	credentials: hotspotCredentialsStore,
	findHotspotConn: findHotspotConnForAdapter,
	pruneHotspotConns: async (macAddress, keepUuid) => {
		await pruneDuplicateHotspotConns(macAddress, keepUuid);
	},
	ensureConcurrentInterface: async (
		ifname,
		admitted,
		onRefusal,
		beforeMutation,
	) =>
		(await selectConcurrentApInterface(
			ifname,
			admitted,
			true,
			onRefusal,
			beforeMutation && {
				beforeCreate: beforeMutation,
				beforePolicy: beforeMutation,
			},
		)) ?? HYBRID_CHANNEL_REFUSAL,
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
	portAlias?: string,
): void {
	if (!hotspotOwnershipGuard(macAddress, wifiInterface)(conn, profileMac))
		return;
	const { name, password, channel } = wifiInterface.hotspot;
	if (!name || !password) return;
	const credentials = {
		ssid: name,
		password,
		...(conn !== undefined ? { conn } : {}),
		...(channel !== undefined ? { channel } : {}),
	};
	deps.credentials.remember(macAddress, credentials, portAlias);
}

type ProfileMatches = (
	uuid: string,
	allowRebind?: boolean,
) => ReturnType<typeof hotspotProfileMatchesRadio>;

/** Read-only selection, repeated at allocation and identity resolution. */
async function selectHotspotProfile(
	owner: string,
	hotspot: WifiInterfaceWithHotspot["hotspot"],
	deps: HotspotActivationDeps,
	profileMatches?: ProfileMatches,
): Promise<
	| {
			readonly cached: string | undefined;
			readonly stored: ReturnType<HotspotActivationDeps["credentials"]["get"]>;
			readonly existing?: ExistingHotspotConn;
	  }
	| undefined
> {
	const stored = deps.credentials.get(owner);
	let cached = hotspot.conn;
	if (profileMatches) {
		for (const uuid of new Set([stored?.conn, cached])) {
			if (!uuid) continue;
			if (!hasCompatibleHotspotProfile(owner, uuid, "")) return undefined;
			const matches = await profileMatches(uuid);
			if (matches) continue;
			if (matches === false || (await deps.readProfileInstance(uuid)) !== null)
				return undefined;
			if (cached === uuid) cached = undefined;
		}
	}
	if (cached && !hasSavedHotspotProfile(stored, cached)) cached = undefined;
	if (cached && hotspot.name && hotspot.password) return { cached, stored };
	const existing = await deps.findHotspotConn(owner, stored);
	if (!existing) return { cached, stored };
	const pin = existing.macAddress ?? "";
	if (
		profileMatches &&
		(!hasSavedHotspotProfile(stored, existing.uuid) ||
			!hasCompatibleHotspotProfile(owner, existing.uuid, pin) ||
			(pin !== "" && normalizeMacAddress(pin) !== wifiAdapterKeyMac(owner)) ||
			!(await profileMatches(existing.uuid)))
	)
		return undefined;
	return { cached, stored, existing };
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
	physicalMac: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotActivationDeps,
	operation?: ReturnType<typeof wifiOperationGuard>,
	portAlias?: string,
	profileMatches?: ProfileMatches,
	permitSavedWrite?: (
		uuid: string,
		profileMac?: string,
	) => Promise<ProfileWriteAdmission>,
	permitLiveWrite?: () => Promise<boolean>,
): Promise<HotspotIdentity | undefined> {
	const hotspot = wifiInterface.hotspot;
	const entryConn = hotspot.conn;
	const owned = hotspotOwnershipGuard(macAddress, wifiInterface);
	if (!owned()) return undefined;
	const selection = await selectHotspotProfile(
		macAddress,
		hotspot,
		deps,
		profileMatches,
	);
	if (!selection || !owned()) return undefined;
	if (hotspot.conn !== entryConn) {
		if (
			profileMatches ||
			!hotspot.conn ||
			!hasSavedHotspotProfile(deps.credentials.get(macAddress), hotspot.conn)
		)
			return undefined;
	} else if (hotspot.conn && !selection.cached) {
		if (
			isHotspotActive(wifiInterface) &&
			isObservedForeignHotspot(hotspot, macAddress)
		)
			return undefined;
		if (operation && !(await operation.permit())) return undefined;
		if (!owned() || hotspot.conn !== entryConn) return undefined;
		delete hotspot.conn;
		delete hotspot.name;
		delete hotspot.password;
	}
	const { stored, existing } = selection;
	let profileMac = getHotspotProfilePin(hotspot, hotspot.conn);
	const stillOwned = hotspotOwnershipGuard(
		macAddress,
		wifiInterface,
		stored?.conn,
	);
	if (!stillOwned()) return undefined;
	if (existing && !stillOwned(existing.uuid, existing.macAddress ?? ""))
		return undefined;
	if (
		existing &&
		(!hotspot.conn || !hotspot.name || !hotspot.password) &&
		hasSavedHotspotProfile(deps.credentials.get(macAddress), existing.uuid)
	) {
		if (operation && (!(await operation.check()) || !operation.current()))
			return undefined;
		profileMac = existing.macAddress ?? "";
		const canUse = () =>
			stillOwned() &&
			stillOwned(existing.uuid, profileMac) &&
			hasSavedHotspotProfile(deps.credentials.get(macAddress), existing.uuid);
		if (!canUse()) return undefined;
		const password = await readVerifiedNmWifiSecret(existing.uuid, {
			"802-11-wireless.ssid": existing.ssid,
			"802-11-wireless.mac-address": profileMac,
		});
		if (operation && (!(await operation.check()) || !operation.current()))
			return undefined;
		if (!canUse()) return undefined;
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
		const permitCredentialWrite = async () => {
			const admission = permitSavedWrite
				? await permitSavedWrite(credentialUuid, profileMac)
				: true;
			if (
				!admission ||
				(profileMatches && !(await profileMatches(credentialUuid)))
			)
				return false;
			if (
				permitLiveWrite
					? !(await permitLiveWrite())
					: operation && !(await operation.permit())
			)
				return false;
			return () =>
				(!operation || operation.current()) &&
				profileAdmissionCurrent(admission) &&
				owned(credentialUuid, profileMac) &&
				hasSavedHotspotProfile(
					deps.credentials.get(macAddress),
					credentialUuid,
				);
		};
		const written = await runHotspotProfileOperation({
			uuid: credentialUuid,
			kind: "modify",
			fields: {
				"802-11-wireless.ssid": name,
				"802-11-wireless-security.psk": password,
			},
			run: (fields) =>
				writeHotspotProfileFields(
					deps.nmConnSetFields,
					credentialUuid,
					fields,
					permitCredentialWrite,
				),
		});
		if (!written.success) return undefined;
		if (operation && (!(await operation.check()) || !operation.current()))
			return undefined;
		if (!stillOwned() || !stillOwned(hotspot.conn, profileMac))
			return undefined;
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
		portAlias,
	);
	return {
		...(hotspot.conn !== undefined ? { conn: hotspot.conn } : {}),
		name,
		password,
		...(profileMac !== undefined ? { profileMac } : {}),
	};
}

function hasSavedHotspotProfile(
	saved: ReturnType<HotspotActivationDeps["credentials"]["get"]>,
	uuid: string,
): boolean {
	return saved?.conn === uuid || saved?.previousConns?.includes(uuid) === true;
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
			(binding) =>
				prepareHotspotLocked(macAddress, wifiInterface, msg, deps, binding),
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
	binding = bindingForRow(macAddress, wifiInterface),
): Promise<HotspotPrepareResult> {
	const physicalMac = binding?.mac ?? normalizeMacAddress(macAddress);
	if (
		!physicalMac ||
		wifiInterface.degradedReason === "permanent-mac-unresolved"
	)
		return { success: false, error: "radio-unverified" };
	const owner = resolveWifiAdapterOwner(macAddress, wifiInterface);
	const portAlias = soleWifiPortAlias(binding);
	const hasPortCopy = isHotspotPortCredentialCopy(owner);
	const owned = hotspotOwnershipGuard(owner, wifiInterface);
	const operation = wifiOperationGuard(binding);
	const port =
		binding?.devicePath ?? hotspotDevicePath(physicalMac, wifiInterface.ifname);
	const permitPins = (uuid: string) =>
		permitsHotspotProfilePins(uuid, physicalMac, port, deps.readProfilePins);
	const identity = await resolveHotspotIdentity(
		owner,
		physicalMac,
		wifiInterface,
		deps,
		binding ? operation : undefined,
		portAlias,
		undefined,
		permitPins,
	);
	if (
		operation.changed ||
		(binding && (!(await operation.check()) || !operation.current()))
	)
		return wifiOperationChanged;
	if (!identity || !owned(identity.conn, identity.profileMac)) {
		return { success: false, error: "activation-failed" };
	}
	// No profile, and the store has never recorded one: this adapter has never
	// hosted an AP, so the shown pair is a suggestion rather than a saved setup.
	const firstTime =
		!hasPortCopy && !identity.conn && !deps.credentials.get(owner)?.conn
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
		if (
			chosen &&
			chosen.name === identity.name &&
			chosen.password === identity.password
		)
			rememberIdentity(
				owner,
				wifiInterface,
				deps,
				identity.conn,
				identity.profileMac,
				portAlias,
			);
		seedWifiPortMode(owner, portAlias);
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
				run: (fields) =>
					writeHotspotProfileFields(
						deps.nmConnSetFields,
						credentialUuid,
						fields,
						async () => {
							if (
								!(await permitPins(credentialUuid)) ||
								(binding && !(await operation.permit()))
							)
								return false;
							return () =>
								operation.current() &&
								owned(credentialUuid, identity.profileMac) &&
								hasSavedHotspotProfile(
									deps.credentials.get(owner),
									credentialUuid,
								);
						},
					),
			})
		).success
	) {
		return operation.changed
			? wifiOperationChanged
			: { success: false, error: "activation-failed" };
	}
	if (binding && (!(await operation.check()) || !operation.current()))
		return wifiOperationChanged;
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
		portAlias,
	);
	seedWifiPortMode(owner, portAlias);
	return { success: true, ...chosen, ...firstTime };
}

// ─── start (atomic, NM-confirmed, with rollback) ─────────────────────────────

type StartRefusal = Extract<HotspotStartResult, { success: false }>;

export async function wifiHotspotStart(
	msg: NonNullable<WifiHotspotMessage["hotspot"]["start"]> & {
		attempt?: string | undefined;
	},
	deps: HotspotActivationDeps = defaultHotspotDeps,
): Promise<HotspotStartResult> {
	const { attempt } = msg;
	const { publishOutcome } = deps;
	if (attempt && publishOutcome)
		deps = {
			...deps,
			publishOutcome: (kind, device, outcome) =>
				publishOutcome(
					kind,
					device,
					outcome,
					kind === "start" ? attempt : undefined,
				),
		};
	const refuse = (result: StartRefusal) => {
		deps.publishOutcome?.("start", msg.device, result);
		return result;
	};
	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return refuse({ success: false, error: "no-device" });

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return refuse({ success: false, error: "no-device" });
	if (!canHotspot(wifiInterface))
		return refuse({ success: false, error: "unsupported" });

	return startHotspotForInterface(macAddress, wifiInterface, deps, refuse);
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
	refuse: (result: StartRefusal) => StartRefusal = (result) => result,
): Promise<HotspotStartResult> {
	const target = { registryKey: macAddress, modeTarget: wifiInterface };
	const lock = await withWifiAdapterLock(target, () =>
		admitWifiRequest(
			wifiInterface,
			async (binding): Promise<HotspotStartResult> => {
				let releaseWitness: (() => void) | undefined;
				const release = () => releaseWitness?.();
				let undo: (() => void) | undefined;
				let succeeded = false;
				try {
					let result: HotspotStartResult;
					try {
						result = await startHotspotLocked(macAddress, wifiInterface, deps, {
							binding: binding ?? bindingForRow(macAddress, wifiInterface),
							recordIntent: (target) => {
								if (deps.recordIntent) {
									undo = recordWifiAdapterModeIntent(
										resolveWifiAdapterOwner(macAddress, wifiInterface),
										target,
										deps.recordIntent,
										verifiedWifiPortKey(
											binding ?? bindingForRow(macAddress, wifiInterface),
										),
									);
								}
							},
							holdWitness: () => {
								releaseWitness = holdWifiModeWitness(wifiInterface);
							},
							publication: {
								// Only the already-up branch or pending monitor owns success.
								publishOutcome: (...args) => {
									try {
										deps.publishOutcome?.(...args);
									} finally {
										release();
									}
								},
								onConfirmationSuperseded: release,
							},
						});
						succeeded = result.success;
					} finally {
						if (!succeeded) undo?.();
					}
					return result.success ? result : refuse(result);
				} finally {
					if (!succeeded) release();
				}
			},
			refuse,
		),
	);
	if (!lock.success) return refuse({ success: false, error: lock.error });
	return lock.result;
}

type HotspotStartContext = {
	readonly recordIntent?: (target: WifiAdapterMode) => void;
	readonly restoreAttempt?: HybridRestoreAttempt | undefined;
	readonly binding?: WifiOperationBinding | undefined;
	readonly publication?: HotspotStartPublication;
	readonly holdWitness?: (() => void) | undefined;
};

/**
 * Internal delegate: the caller owns the adapter lock, its intent transaction
 * and request admission, so a mode transition's start never re-admits after it
 * has already changed the radio.
 */
export async function startHotspotLocked(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotActivationDeps,
	{
		recordIntent,
		restoreAttempt,
		binding,
		publication = deps,
		holdWitness,
	}: HotspotStartContext = {},
): Promise<HotspotStartResult> {
	const operation = wifiOperationGuard(binding);
	if (binding && (!(await operation.check()) || !operation.current()))
		return wifiOperationChanged;
	const intentOwner = resolveWifiAdapterOwner(macAddress, wifiInterface);
	const restoreProfile = binding?.bootRestore && binding.restoreProfile;
	const owner = restoreProfile?.owner ?? intentOwner;
	if (
		!(await reconcileWifiAdapterTeardownLocked(intentOwner)).complete ||
		(owner !== intentOwner &&
			!(await reconcileWifiAdapterTeardownLocked(owner)).complete)
	)
		return {
			success: false,
			error: "activation-failed",
			reason: "cleanup-pending",
		};
	const physicalMac = binding?.mac ?? normalizeMacAddress(macAddress);
	if (
		!physicalMac ||
		wifiInterface.degradedReason === "permanent-mac-unresolved"
	)
		return { success: false, error: "radio-unverified" };
	const ifname = wifiInterface.ifname;
	const portAlias =
		owner === macAddress ? soleWifiPortAlias(binding) : undefined;
	// The roster may still carry the plain record's cached credentials.
	if (binding?.bootRestore && owner !== macAddress) {
		const saved = deps.credentials.get(owner)?.conn;
		if (wifiInterface.hotspot.conn !== saved) {
			const hotspot = { ...wifiInterface.hotspot };
			delete hotspot.conn;
			delete hotspot.name;
			delete hotspot.password;
			delete hotspot.channel;
			delete hotspot.security;
			delete hotspot.transition;
			wifiInterface.hotspot = hotspot;
			retireReplacedHotspotTransition(wifiInterface);
		}
	}
	const owned = hotspotOwnershipGuard(owner, wifiInterface);
	if (!owned()) {
		return { success: false, error: "activation-failed" };
	}
	const stopRejectedHybrid = async (uuid: string): Promise<boolean> => {
		const virtual = wifiInterface.concurrentHotspot;
		if (!virtual || !owned(uuid)) return false;
		const stopped = await runHotspotProfileOperation({
			uuid,
			kind: "down",
			run: async () =>
				nmDisconnectActivation(
					uuid,
					await observeHotspotActivation(uuid, virtual.ifname),
					deps,
					async () =>
						(await operation.permit()) &&
						owned(uuid) &&
						wifiInterface.concurrentHotspot === virtual,
				),
		});
		if (!stopped.success) return false;
		if (wifiInterface.concurrentHotspot === virtual)
			transitionVirtualBinding(wifiInterface, { kind: "retire" });
		await deps.releaseConcurrentInterface(virtual.ifname);
		deps.broadcastState();
		syncWifiStateCache(macAddress, wifiInterface);
		return true;
	};
	const rawCapability = deps.readCapabilities?.(ifname);
	const concurrency = deps.readCapabilities
		? wifiAdapterModeCapability(wifiInterface, () => rawCapability)
				.staApComboSupported
		: wifiInterface.supportsApStaConcurrency;
	const intent = getPersistedWifiAdapterMode(intentOwner);
	const recordChosenMode = (mode: WifiAdapterMode): void => {
		recordIntent?.(mode);
	};
	const useConcurrentAp =
		concurrency === true && (deps.preferConcurrentAp?.(intentOwner) ?? true);
	const profileMatches: ProfileMatches | undefined = binding?.bootRestore
		? (uuid, allowRebind = true) =>
				restoreProfile && restoreProfile.uuid !== uuid
					? Promise.resolve(false)
					: hotspotProfileMatchesRadio(
							uuid,
							ifname,
							physicalMac,
							binding.devicePath,
							binding.bootRestore === "require-port-pin",
							useConcurrentAp
								? {
										ifname: concurrentApIfname(ifname),
										savedUuid:
											allowRebind && deps.credentials.get(owner)?.conn === uuid,
									}
								: undefined,
						)
		: undefined;
	const diagnosticPath = restoreAttempt ? "activation" : "operator-start";
	let channelRefusal: HybridChannelRefusal | undefined;
	const hybridChannel =
		useConcurrentAp && deps.readHybridChannel
			? await deps.readHybridChannel(ifname, (refusal) => {
					channelRefusal = refusal;
				})
			: undefined;
	if (binding && (!(await operation.check()) || !operation.current()))
		return wifiOperationChanged;
	if (!owned()) return { success: false, error: "activation-failed" };
	if (useConcurrentAp && deps.readHybridChannel && !hybridChannel) {
		const active = wifiInterface.concurrentHotspot?.activeConn;
		const stopped =
			!active ||
			(active === wifiInterface.hotspot.conn &&
				owned(active) &&
				(await stopRejectedHybrid(active)));
		if (operation.changed) return wifiOperationChanged;
		logHybridChannelRefusal(
			`wifi hotspot start: hybrid-channel-not-permitted on ${ifname}`,
			ifname,
			diagnosticPath,
			restoreAttempt,
			channelRefusal,
		);
		return {
			success: false,
			error: "activation-failed",
			reason: stopped ? HYBRID_CHANNEL_REFUSAL : "deactivation-failed",
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
			const stopped = await stopRejectedHybrid(wifiInterface.hotspot.conn);
			if (operation.changed) return wifiOperationChanged;
			return {
				success: false,
				error: "activation-failed",
				reason: stopped ? HYBRID_CHANNEL_REFUSAL : "deactivation-failed",
			};
		}
		// Already up: nothing is dispatched, so no confirmation will ever settle
		// and this branch owes the terminal frame itself.
		if (binding && (!(await operation.check()) || !operation.current()))
			return wifiOperationChanged;
		recordChosenMode(observedWifiAdapterMode(wifiInterface));
		publication.publishOutcome?.("start", wifiInterface.id, { success: true });
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
	const stationCurrent = async () =>
		!hybridChannel ||
		(await deps.readHybridChannel?.(ifname))?.identity ===
			hybridChannel.identity;
	const restoreProfileAllowsAllocation = async () => {
		if (!profileMatches) return true;
		const selection = await selectHotspotProfile(
			owner,
			wifiInterface.hotspot,
			deps,
			profileMatches,
		);
		return Boolean(
			selection &&
				(selection.cached ||
					selection.existing ||
					binding?.bootRestore !== "require-port-pin"),
		);
	};
	const permitHybridMutation = async () =>
		(await restoreProfileAllowsAllocation()) &&
		(await operation.permit()) &&
		(await stationCurrent()) &&
		operation.current() &&
		owned();
	if (useConcurrentAp && profileMatches && !(await permitHybridMutation()))
		return operation.changed
			? wifiOperationChanged
			: { success: false, error: "activation-failed" };
	let targetRefusal: HybridTargetRefusal | undefined;
	const allocation = useConcurrentAp
		? await deps.ensureConcurrentInterface?.(
				ifname,
				() => operation.current() && owned(),
				(refusal) => {
					targetRefusal = refusal;
				},
				profileMatches ? permitHybridMutation : undefined,
			)
		: undefined;
	const concurrentInterface =
		allocation === HYBRID_CHANNEL_REFUSAL ? undefined : allocation;
	const activationIfname = concurrentInterface?.ifname ?? ifname;
	let channelRefused = false;
	let channelDownFailed = false;
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
	let activeReceipt: NmActivationReceipt | undefined;
	const connect = (
		uuid: string,
		before: NmProfileInstance | null | undefined,
		requestedIfname?: string,
	) => {
		const runId = before?.runId;
		const accept = (path: string) => {
			activePath = path;
			if (runId) activeReceipt = { path, runId, ifname: activationIfname };
		};
		const dispatchIfname = binding?.bootRestore
			? activationIfname
			: requestedIfname;
		return dispatchIfname
			? deps.nmConnect(uuid, HOTSPOT_UP_TO, accept, undefined, dispatchIfname)
			: deps.nmConnect(uuid, HOTSPOT_UP_TO, accept);
	};
	let activationAttempted = false;
	let failedAdd: NmApConnAddError | undefined;
	let cleanupConfirmed = true;
	let refusal: HotspotStartResult | undefined;
	let rollbackState: (() => HotspotStartResult) | undefined;
	let targetRadio: RadioSample | undefined;
	let transition: ReturnType<typeof beginHotspotTransition> | undefined;
	using _publicationScope = {
		[Symbol.dispose]() {
			// Unfinished cleanup keeps its existing recovery authority, not a UI lock.
			if (!acceptedAllocation) transition?.finish();
		},
	};
	try {
		if (binding && concurrentInterface) {
			const allocated = targetRecords.get(concurrentInterface)?.target;
			targetRadio = await sampleWifiOperationRadio(concurrentInterface.ifname);
			if (
				(allocated && !sameRadioLifetime(allocated, targetRadio?.lifetime)) ||
				(targetRadio &&
					targetRadio.lifetime.phyPath !== binding.lifetime.phyPath) ||
				!(await operation.permit())
			)
				return wifiOperationChanged;
			if (targetRadio)
				operation.bindLeg(
					wifiLegLifetimeProof(
						concurrentInterface.ifname,
						targetRadio.lifetime,
					),
				);
		}
		if (binding && (!(await operation.check()) || !operation.current()))
			return wifiOperationChanged;
		const stillOwned = owned();
		const noTarget = useConcurrentAp && concurrentInterface === undefined;
		if (noTarget && (stillOwned || targetRefusal)) {
			logHybridTargetRefusal(
				`wifi hotspot start: unreconciled hybrid target on ${ifname}`,
				ifname,
				diagnosticPath,
				hybridChannel ? true : null,
				restoreAttempt,
				targetRefusal,
			);
		}
		if (!stillOwned) {
			return { success: false, error: "activation-failed" };
		}
		if (noTarget) {
			return {
				success: false,
				error: "activation-failed",
				...(allocation === HYBRID_CHANNEL_REFUSAL
					? { reason: HYBRID_CHANNEL_REFUSAL }
					: {}),
			};
		}
		const provenActivationIfname =
			binding && (!concurrentInterface || targetRadio)
				? activationIfname
				: undefined;
		const bindingFields: Record<string, string> = concurrentInterface
			? {
					...concurrentHotspotBindingFields(ifname),
					"connection.interface-name": concurrentInterface.ifname,
					...(binding?.bootRestore ? {} : { "match.path": "" }),
					"connection.autoconnect": "no",
					"connection.autoconnect-priority": "999",
					...hotspotSecurityFields(
						wifiInterface.hotspot.security ?? DEFAULT_HOTSPOT_SECURITY,
					),
					...hybridChannel?.fields,
				}
			: hotspotBindingFields(
					physicalMac,
					wifiInterface.hotspot.security,
					binding ? binding.devicePath : hotspotDevicePath(physicalMac, ifname),
				);
		if (concurrentInterface) {
			wifiInterface.supportsApStaConcurrency = true;
			transitionVirtualBinding(wifiInterface, {
				kind: "pending",
				ifname: concurrentInterface.ifname,
			});
		}
		const virtualClaim = wifiInterface.concurrentHotspot;

		// Snapshot prior state for rollback. getWifiState() returns the live cache
		// reference; syncing below swaps in a NEW object, so this stays the old one.
		const priorCache = getWifiState()[macAddress];

		// Begin the transition: broadcast `activating` immediately (responsive UI),
		// suppress dup-IP warnings for the window, but DO NOT flip mode yet.
		// Admission/cleanup can replace the profile before the ownership guard.
		holdWitness?.();
		const claim = beginHotspotTransition(wifiInterface, "activating");
		transition = claim;
		if (!concurrentInterface) deps.setDupIpSuppression(ifname, true);
		deps.broadcastState();
		syncWifiStateCache(macAddress, wifiInterface); // still station (isHotspot false)
		let projected = getWifiState()[macAddress];

		rollbackState = (): HotspotStartResult => {
			if (
				wifiInterface.hotspot !== hotspot ||
				(binding && getWifiInterfaceByMacAddress(binding.key) !== wifiInterface)
			)
				return { success: false, error: "activation-failed" };
			claim.clear();
			if (!concurrentInterface) deps.setDupIpSuppression(ifname, false);
			const current = getWifiState();
			if (current[macAddress] === projected) {
				const next = { ...current };
				if (priorCache) next[macAddress] = priorCache;
				else delete next[macAddress];
				setWifiState(next);
			}
			if (wifiInterface.concurrentHotspot === virtualClaim)
				transitionVirtualBinding(wifiInterface, { kind: "retire" });
			deps.broadcastState();
			claim.finish(false);
			return {
				success: false,
				error: "activation-failed",
				...(channelRefused ? { reason: HYBRID_CHANNEL_REFUSAL } : {}),
			};
		};
		const rollback = (): HotspotStartResult => {
			refusal = {
				success: false,
				error: operation.changed ? "radio-changed" : "activation-failed",
				...(channelDownFailed
					? { reason: "deactivation-failed" as const }
					: !operation.changed && channelRefused
						? { reason: HYBRID_CHANNEL_REFUSAL }
						: {}),
			};
			return refusal;
		};

		// The leg's bindings are rechecked before each write; its identity is part of every permit.
		const leg = async (): Promise<boolean> => {
			if (
				!concurrentInterface ||
				!deps.validateConcurrentInterface ||
				(await deps.validateConcurrentInterface(concurrentInterface))
			)
				return true;
			if (binding && targetRadio) operation.refuse();
			channelRefused = true;
			return false;
		};
		// Pins and selectors can await I/O; sample live state after those reads.
		const permitLiveWrite = async () => {
			if (binding && !(await operation.permit())) return false;
			if (!(await stationCurrent())) {
				channelRefused = true;
				return false;
			}
			return operation.current();
		};
		const permitBindingWrite = async () => (await leg()) && permitLiveWrite();

		// The SAME resolution `wifiHotspotPrepare` showed the operator, so the AP
		// broadcasts exactly the credentials they acknowledged.
		const port = binding?.devicePath ?? hotspotDevicePath(physicalMac, ifname);
		const admitSavedPins = savedHotspotStartPinGuard(
			owner,
			physicalMac,
			port,
			deps.readProfilePins,
			binding,
		);
		const identity = await resolveHotspotIdentity(
			owner,
			physicalMac,
			wifiInterface,
			deps,
			binding ? operation : undefined,
			portAlias,
			profileMatches,
			async (uuid, observedMac) =>
				canWriteSavedHotspotPins(await admitSavedPins(uuid, observedMac)),
			permitBindingWrite,
		);
		if (!identity || !owned(identity.conn, identity.profileMac))
			return rollback();
		if (!identity.conn && binding?.bootRestore === "require-port-pin")
			return rollback();
		let conn = identity.conn;
		// Boot may repair an eligible leg name, but never repins a saved physical port.
		if (binding?.bootRestore && conn) {
			delete bindingFields["match.path"];
			for (const field of Object.keys(bindingFields))
				if (field.startsWith("802-11-wireless-security."))
					delete bindingFields[field];
		}
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
		const ready = async (): Promise<boolean> => {
			if (!owned(conn, identity.profileMac)) return false;
			if (!binding?.bootRestore && !(await stationCurrent())) {
				channelRefused = true;
				return false;
			}
			return leg();
		};
		const permitBootDispatch = async () => {
			if (!binding?.bootRestore) return operation.permit();
			if (!(await operation.permit())) return false;
			if (!(await stationCurrent())) {
				channelRefused = true;
				return false;
			}
			return operation.current() && owned(conn, identity.profileMac);
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
			if (binding && !(await operation.permit())) return false;
			channelRefused = true;
			channelDownFailed =
				!owned(uuid, identity.profileMac) ||
				!(await writeProfile({
					uuid,
					kind: "down",
					run: async () =>
						owned(uuid, identity.profileMac) &&
						nmDisconnectActivation(uuid, activeReceipt, deps),
				}));
			return false;
		};

		// Cleanup is best-effort, runs off the critical path, and never fails a start.
		const prune = (keepUuid: string) => {
			if (binding?.bootRestore) return;
			void deps
				.pruneHotspotConns(owner, keepUuid)
				.catch(() => logger.debug("hotspot profile cleanup failed"));
		};

		const applyAutoconnect = async (
			uuid: string,
			permit: () => Promise<ProfileWriteAdmission>,
		): Promise<boolean> => {
			const policy = await hotspotAutoconnectPolicy(owner, bindingFields);
			if (!policy) return true;
			return reconcileWifiAdapterProfileLocked(owner, {
				uuid,
				fields: policy.fields,
				write: async (id, fields) => {
					let skipped = false;
					const written = await writeProfile({
						uuid: id,
						kind: "modify",
						fields,
						run: (delta) =>
							writeHotspotProfileFields(
								deps.nmConnSetFields,
								id,
								delta,
								async () => {
									const admission = await permit();
									return () => {
										if (!profileAdmissionCurrent(admission)) return false;
										skipped = policy.current?.() === false;
										return !skipped;
									};
								},
							),
					});
					return written || skipped;
				},
			});
		};

		if (conn) {
			const existingUuid = conn;
			const match = profileMatches && (await profileMatches(existingUuid));
			if (profileMatches && !match) return rollback();
			const staleMatch = match ? match.staleMatch : undefined;
			if (staleMatch) bindingFields["match.interface-name"] = activationIfname;
			const stillOwned = () =>
				owned(existingUuid, identity.profileMac) &&
				hasSavedHotspotProfile(deps.credentials.get(owner), existingUuid);
			const readSavedPins = () =>
				admitSavedPins(existingUuid, identity.profileMac);
			const permission = await readSavedPins();
			if (permission.kind === "refuse" || !stillOwned()) return rollback();
			const activateOnly = permission.kind === "activate-only";
			const keepPolicy =
				permission.kind === "keep-policy" && !concurrentInterface;
			if (activateOnly && concurrentInterface) return rollback();
			const permitExistingWrite = async (
				stage: "binding" | "discovery" | "policy",
			) => {
				const admission = canWriteSavedHotspotPins(await readSavedPins());
				if (!admission) return false;
				if (stage === "binding" && profileMatches) {
					const current = await profileMatches(existingUuid);
					if (!current || current.staleMatch !== staleMatch) return false;
				}
				// After Up the leg is no longer idle; check its bound lifetime instead.
				const checkLive =
					stage === "policy" ? permitLiveWrite : permitBindingWrite;
				if (!(await checkLive())) return false;
				return () =>
					operation.current() &&
					stillOwned() &&
					profileAdmissionCurrent(admission);
			};
			// Boot already follows discovery; it must not run a second saved-profile sweep.
			if (!activateOnly && !binding?.bootRestore) {
				await deps.wifiUpdateSavedConns(undefined, undefined, (uuid) =>
					uuid === existingUuid
						? permitExistingWrite("discovery")
						: Promise.resolve(false),
				);
				if (binding && !(await operation.permit())) return rollback();
				if (!owned(conn, identity.profileMac)) return rollback();
			}
			profileInstance = await deps.readProfileInstance(conn);
			if (!activateOnly) {
				// Matching pins need no roster-dependent autoconnect policy change.
				const {
					"connection.autoconnect": _autoconnect,
					...withoutAutoconnect
				} = bindingFields;
				const rebound = await writeProfile({
					uuid: existingUuid,
					kind: "modify",
					fields: keepPolicy ? withoutAutoconnect : bindingFields,
					run: (fields) =>
						writeHotspotProfileFields(
							deps.nmConnSetFields,
							existingUuid,
							fields,
							() => permitExistingWrite("binding"),
						),
				});
				if (!owned(conn, identity.profileMac) || !rebound) return rollback();
			}
			if (binding && !(await operation.permit())) return rollback();
			if (!activateOnly) prune(conn);
			const changedAfterUp = async () => {
				const result = rollback();
				if (
					!result.success &&
					(!(await matchesHotspotActivation(
						existingUuid,
						activationIfname,
						{
							profile: profileInstance,
							activePath,
							activeRunId: activeReceipt?.runId,
						},
						deps,
					)) ||
						!(await nmDisconnectActivation(existingUuid, activeReceipt, deps)))
				)
					result.reason = "deactivation-failed";
				return result;
			};
			const up = await writeProfile({
				uuid: existingUuid,
				kind: "up",
				run: async (before) => {
					if (!(await ready())) return false;
					if (profileMatches && !(await profileMatches(existingUuid, false)))
						return false;
					if (activateOnly) {
						const allowed = await readSavedPins();
						if (
							allowed.kind !== "activate-only" ||
							!(await permitBindingWrite()) ||
							!allowed.current?.()
						)
							return false;
					} else if (binding && !(await permitBootDispatch())) return false;
					return (
						stillOwned() &&
						connect(existingUuid, before, provenActivationIfname)
					);
				},
			});
			if (binding && (up || activePath) && !(await operation.permit()))
				return await changedAfterUp();
			if (!up) return rollback();
			if (!(await confirmed(conn)))
				return operation.changed ? await changedAfterUp() : rollback();
			if (!owned(conn, identity.profileMac)) return rollback();
			if (!activateOnly && !keepPolicy)
				await applyAutoconnect(conn, () => permitExistingWrite("policy"));
			if (binding && !(await operation.permit())) return await changedAfterUp();
			if (!owned(conn, identity.profileMac)) return rollback();
			rememberIdentity(
				owner,
				wifiInterface,
				deps,
				conn,
				identity.profileMac,
				portAlias,
			);
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
			projected = getWifiState()[macAddress];

			let uuid: string | undefined;
			let creationRecorded = false;
			if (!(await leg())) return rollback();
			if (binding && !(await operation.permit())) return rollback();
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
					binding ? permitBootDispatch : undefined,
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
			await deps.wifiUpdateSavedConns(undefined, undefined, async () => false);
			if (binding && !(await operation.permit())) return rollback();
			if (!owned(uuid)) return rollback();
			prune(uuid);
			if (
				!(await writeProfile({
					uuid,
					kind: "up",
					run: async (before) => {
						if (!(await ready())) return false;
						if (binding && !(await permitBootDispatch())) return false;
						activationAttempted = true;
						return connect(uuid, before, provenActivationIfname);
					},
				}))
			)
				return rollback();
			if (!(await confirmed(uuid))) return rollback();
			if (binding && !(await operation.permit())) return rollback();
			if (!owned(uuid)) return rollback();
			if (
				!(await applyAutoconnect(uuid, async () => {
					const admission = canWriteSavedHotspotPins(
						await admitSavedPins(uuid),
					);
					if (!admission || !(await permitLiveWrite())) return false;
					return () =>
						operation.current() &&
						owned(uuid) &&
						profileAdmissionCurrent(admission);
				}))
			)
				return rollback();
			if (binding && !(await operation.permit())) return rollback();
			if (!owned(uuid)) return rollback();
			conn = uuid;
			wifiInterface.hotspot.conn ??= uuid;
			rememberIdentity(owner, wifiInterface, deps, uuid, undefined, portAlias);
			rememberHotspotProfilePin(
				wifiInterface.hotspot,
				uuid,
				bindingFields["802-11-wireless.mac-address"],
			);
		}

		seedWifiPortMode(owner, portAlias);
		// NM activation issued successfully. The mode flip waits for confirmation —
		// it does NOT block this call (so the UI shows `activating` meanwhile).
		registerPendingConfirmation(
			{
				macAddress,
				uuid: conn,
				ifname: activationIfname,
				credentialOwner: owner,
				activation: {
					profile: profileInstance,
					activePath,
					activeRunId: activeReceipt?.runId,
				},
				binding,
				radioProof: operation.observe,
				transition: claim,
				...(concurrentInterface ? { allocation: concurrentInterface } : {}),
			},
			wifiInterface,
			deps,
			publication,
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
					activation: activeReceipt,
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
			const release = () =>
				releaseHybridLeg(concurrentInterface, deps, {
					receipt: Boolean(binding),
					deleteCreated: !createdUuid,
				});
			if (!(await release()) && binding && !concurrentInterface.created)
				registerWifiAdapterLegRelease(owner, release);
		}
	}
}
