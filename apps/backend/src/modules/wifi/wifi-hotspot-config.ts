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

import type { WifiAdapterCapabilities } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { setNetifDupIpSuppression } from "../network/network-interfaces.ts";
import {
	nmConnect,
	nmConnGetFields,
	nmConnSetFields,
	nmDisconnect,
	readNmDeviceActivation,
} from "../network/network-manager.ts";
import {
	readNmProfileInstance,
	sameNmProfileActivation,
} from "../network/network-manager-profile-instance.ts";
import type { MessageSocket } from "../ui/message-socket.ts";
import { buildMsg, getSocketSenderId } from "../ui/websocket-server.ts";
import { rememberHotspotCredentials } from "./hotspot-credentials.ts";
import { broadcastWifiState, wifiUpdateSavedConns } from "./wifi.ts";
import {
	awaitWifiStopHandoff,
	ownsWifiAdapterLock,
	wifiAdapterLockKey,
	withWifiAdapterLock,
	withWifiAdapterLocks,
} from "./wifi-adapter-lock.ts";
import {
	seedWifiPortMode,
	tryRecordWifiStationIntent,
	type WifiAdapterModeRecorder,
	wifiAdapterModeRecorder,
} from "./wifi-adapter-mode-intent.ts";
import { publishAdapterModeOutcome } from "./wifi-adapter-mode-outcome.ts";
import { resolveWifiAdapterOwner } from "./wifi-adapter-owner.ts";
import {
	reconcileWifiAdapterStopLocked,
	wifiStopTarget,
} from "./wifi-adapter-reconciler.ts";
import {
	admitWifiRequest,
	registerWifiRequestLockEntry,
	type WifiBindingRefusal,
} from "./wifi-binding.ts";
import { getWifiCapabilitiesForInterface } from "./wifi-capabilities.ts";
import {
	type DerivedApChannel,
	isChannelOffered,
	isWifiChannelName,
	nmSettingsForChannel,
	type WifiChannel,
} from "./wifi-channels.ts";
import {
	confirmHybridActivation,
	HYBRID_CHANNEL_REFUSAL,
	isQualifiedNmManagedHybrid,
	readHybridStationChannel,
	readHybridTargetIdentity,
	releaseConcurrentApInterface,
} from "./wifi-concurrent-interface.ts";
import {
	getWifiInterfaceByMacAddress,
	wifiRescan,
} from "./wifi-connections.ts";
import { captureWifiFrameIncarnation } from "./wifi-frame-binding.ts";
import {
	type NmActivationReceipt,
	nmDisconnectActivation,
	observeHotspotActivation,
} from "./wifi-hotspot-activity.ts";
import { hotspotOwnershipGuard } from "./wifi-hotspot-discovery.ts";
import {
	beginHotspotTransition,
	syncWifiStateCache,
} from "./wifi-hotspot-monitor.ts";
import {
	type HotspotOutcomePublisher,
	publishHotspotOutcome,
} from "./wifi-hotspot-outcome.ts";
import { runHotspotProfileOperation } from "./wifi-hotspot-profile-operation.ts";
import {
	DEFAULT_HOTSPOT_SECURITY,
	type HotspotSecurityId,
	isSecurityOffered,
	nmSettingsForSecurity,
	offeredHotspotSecurity,
} from "./wifi-hotspot-security.ts";
import {
	canHotspot,
	HOTSPOT_UP_TO,
	isConcurrentHotspot,
	isHotspotActive,
	type WifiHotspotMessage,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import { getMacAddressForWifiInterface } from "./wifi-interfaces.ts";
import {
	bindingForRow,
	soleWifiPortAlias,
	type WifiOperationBinding,
	wifiOperationChanged,
	wifiOperationGuard,
} from "./wifi-operation-binding.ts";
import { wifiAdapterKeyMac } from "./wifi-permanent-mac.ts";
import { literalWifiDevicePath } from "./wifi-radio-read-budget.ts";
import { transitionVirtualBinding } from "./wifi-virtual-binding.ts";

// ─── hotspot config validation constants ──────────────────────────────────────

/** Minimum length for hotspot SSID name. */
const HOTSPOT_NAME_MIN_LENGTH = 1;
/** Maximum length for hotspot SSID name. */
const HOTSPOT_NAME_MAX_LENGTH = 32;
/** Minimum length for hotspot password. */
const HOTSPOT_PASSWORD_MIN_LENGTH = 8;
/** Maximum length for hotspot password. */
const HOTSPOT_PASSWORD_MAX_LENGTH = 64;

// ─── stop ────────────────────────────────────────────────────────────────────

export type HotspotStopResult =
	| { success: true }
	| {
			success: false;
			error:
				| "DEVICE_BUSY"
				| "no-device"
				| "unsupported"
				| "radio-changed"
				| "deactivation-failed";
	  };

export async function wifiHotspotStop(
	msg: NonNullable<WifiHotspotMessage["hotspot"]["stop"]>,
	deps: HotspotStopDeps = defaultHotspotStopDeps,
): Promise<HotspotStopResult> {
	const result = await resolveAndStop(msg, deps);
	deps.publishOutcome?.("stop", msg.device, result);
	return result;
}

async function resolveAndStop(
	msg: NonNullable<WifiHotspotMessage["hotspot"]["stop"]>,
	deps: HotspotStopDeps,
): Promise<HotspotStopResult> {
	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return { success: false, error: "no-device" };

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return { success: false, error: "no-device" };
	if (!canHotspot(wifiInterface))
		return { success: false, error: "unsupported" };
	if (!(await awaitWifiStopHandoff(wifiInterface)))
		return { success: false, error: "DEVICE_BUSY" };
	if (getWifiInterfaceByMacAddress(macAddress) !== wifiInterface)
		return { success: false, error: "DEVICE_BUSY" };
	const { owner, port } = wifiStopTarget(macAddress, wifiInterface);
	const key = wifiAdapterLockKey(macAddress);
	const keys = port ? [key, owner, port] : [key, owner];
	if (keys.some(ownsWifiAdapterLock))
		return { success: false, error: "DEVICE_BUSY" };
	const lock = await withWifiAdapterLocks(
		keys,
		async (): Promise<HotspotStopResult> => {
			const intentKey = wifiAdapterKeyMac(owner) ? owner : undefined;
			const undo = deps.recordIntent
				? tryRecordWifiStationIntent(intentKey, deps.recordIntent, port)
				: undefined;
			let succeeded = false;
			try {
				const result = await stopHotspotForInterfaceLocked(
					macAddress,
					wifiInterface,
					deps,
				);
				succeeded = result.success;
				return result;
			} finally {
				if (!succeeded) undo?.();
			}
		},
	);
	return lock.success ? lock.result : { success: false, error: lock.error };
}

export type HotspotStopDeps = {
	recordIntent?: WifiAdapterModeRecorder;
	nmConnSetFields: typeof nmConnSetFields;
	nmDisconnect: typeof nmDisconnect;
	releaseConcurrentInterface: typeof releaseConcurrentApInterface;
	broadcastState: typeof broadcastWifiState;
	setDupIpSuppression: typeof setNetifDupIpSuppression;
	rescan: typeof wifiRescan;
	/** Same contract and same optionality reason as `HotspotActivationDeps.publishOutcome`. */
	publishOutcome?: HotspotOutcomePublisher;
};

export const defaultHotspotStopDeps: HotspotStopDeps = {
	recordIntent: {
		read: (key) => wifiAdapterModeRecorder.read(key),
		persist: (key, mode, alias) =>
			wifiAdapterModeRecorder.persist(key, mode, alias),
		restore: (key, previous, alias) =>
			wifiAdapterModeRecorder.restore(key, previous, alias),
	},
	nmConnSetFields,
	nmDisconnect,
	releaseConcurrentInterface: releaseConcurrentApInterface,
	broadcastState: broadcastWifiState,
	setDupIpSuppression: setNetifDupIpSuppression,
	rescan: wifiRescan,
	publishOutcome: publishHotspotOutcome,
};

export async function stopHotspotForInterface(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotStopDeps = defaultHotspotStopDeps,
): Promise<HotspotStopResult> {
	const lock = await withWifiAdapterLock(
		{ registryKey: macAddress, modeTarget: wifiInterface },
		() => stopHotspotForInterfaceLocked(macAddress, wifiInterface, deps),
	);
	if (!lock.success) return { success: false, error: "DEVICE_BUSY" };
	return lock.result;
}

/** Internal maintenance delegate; never records intent or reacquires the lock. */
export async function stopHotspotForInterfaceLocked(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotStopDeps,
	operation?: ReturnType<typeof wifiOperationGuard>,
): Promise<HotspotStopResult> {
	return reconcileWifiAdapterStopLocked(
		macAddress,
		wifiInterface,
		deps,
		operation,
	);
}

/** A roam may withdraw SCC legality; only the observed AP UUID is stopped. */
export async function reconcileHybridStationChannel(
	macAddress: string,
	row: WifiInterfaceWithHotspot,
): Promise<void> {
	const uuid = row.concurrentHotspot?.activeConn;
	if (
		!uuid ||
		uuid !== row.hotspot.conn ||
		row.hotspot.transition ||
		!wifiAdapterKeyMac(macAddress) ||
		row.degradedReason === "permanent-mac-unresolved" ||
		!isQualifiedNmManagedHybrid(row.ifname)
	)
		return;
	await withWifiAdapterLock(wifiAdapterLockKey(macAddress), () =>
		admitWifiRequest(
			row,
			async () => {
				const target = row.concurrentHotspot;
				if (
					target?.activeConn !== uuid ||
					row.hotspot.conn !== uuid ||
					row.hotspot.transition
				)
					return;
				const channel = await readHybridStationChannel(row.ifname);
				if (
					channel &&
					(await confirmHybridActivation(
						row.ifname,
						target.ifname,
						uuid,
						channel,
					))
				)
					return;
				if (row.concurrentHotspot !== target || row.hotspot.conn !== uuid)
					return;
				const stopped = await stopHotspotForInterfaceLocked(
					macAddress,
					row,
					defaultHotspotStopDeps,
				);
				if (!stopped.success) return;
				publishAdapterModeOutcome(row.id, {
					success: false,
					error: "activation-failed",
					reason: HYBRID_CHANNEL_REFUSAL,
				});
			},
			() => undefined,
		),
	);
}

// ─── config ──────────────────────────────────────────────────────────────────

/**
 * Effectful surface of the reconfigure path, injected so the whole flow —
 * including the exact nmcli field set a WPA3 selection produces — is drivable
 * without a NetworkManager on the host. Mirrors {@link HotspotActivationDeps}.
 */
export type HotspotConfigDeps = {
	nmConnSetFields: (
		uuid: string,
		fields: Record<string, string>,
		permit?: () => Promise<boolean>,
	) => Promise<unknown>;
	nmConnect: (
		uuid: string,
		timeout?: number,
		onActivated?: (path: string) => void,
		onTimeout?: () => void,
	) => Promise<unknown>;
	wifiUpdateSavedConns: () => Promise<void>;
	broadcastState: () => void;
	rememberCredentials: (
		macAddress: string,
		credentials: {
			ssid: string;
			password: string;
			channel: WifiChannel;
			conn?: string;
		},
		portAlias?: string,
	) => void;
	/** The adapter's own capability read — the sole evidence for a WPA3 offer. */
	getCapabilities: (ifname: string) => WifiAdapterCapabilities | undefined;
	readHybridChannel?: typeof readHybridStationChannel;
	confirmHybridActivation?: typeof confirmHybridActivation;
	nmDisconnect?: typeof nmDisconnect;
	readHybridTargetIdentity?: typeof readHybridTargetIdentity;
};

export const defaultHotspotConfigDeps: HotspotConfigDeps = {
	nmConnSetFields,
	nmConnect,
	wifiUpdateSavedConns,
	broadcastState: broadcastWifiState,
	rememberCredentials: rememberHotspotCredentials,
	getCapabilities: getWifiCapabilitiesForInterface,
	readHybridChannel: readHybridStationChannel,
	confirmHybridActivation,
	nmDisconnect,
	readHybridTargetIdentity,
};

function offeredSecurityFor(
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotConfigDeps,
): HotspotSecurityId[] {
	return offeredHotspotSecurity(deps.getCapabilities(wifiInterface.ifname));
}

function nmConnSetHotspotFields(
	uuid: string,
	name: string,
	password: string,
	channel: string,
	security: HotspotSecurityId,
	derived: readonly DerivedApChannel[],
	offeredSecurity: readonly HotspotSecurityId[],
	write: HotspotConfigDeps["nmConnSetFields"],
	hybridFields?: Record<string, string>,
) {
	// An underived channel has no band/number mapping BY CONSTRUCTION, so an
	// illegal channel can never reach nmcli even if validation were bypassed.
	const nmSettings = hybridFields
		? {
				nmBand: hybridFields["802-11-wireless.band"] ?? "",
				nmChannel: hybridFields["802-11-wireless.channel"] ?? "",
			}
		: nmSettingsForChannel(channel, derived);
	if (!nmSettings) return;
	// Same rule for security: an unoffered mode resolves to no field set at all.
	const securityFields = nmSettingsForSecurity(security, offeredSecurity);
	if (!securityFields) return;

	const settingsToChange = {
		"802-11-wireless.ssid": name,
		"802-11-wireless-security.psk": password,
		"802-11-wireless.band": nmSettings.nmBand,
		"802-11-wireless.channel": nmSettings.nmChannel,
		...securityFields,
	};

	return runHotspotProfileOperation({
		uuid,
		kind: "modify",
		fields: settingsToChange,
		run: (fields) => write(uuid, fields),
	}).then((result) => result.success);
}

function isHotspotConfigComplete(
	i: WifiInterfaceWithHotspot,
): i is WifiInterfaceWithHotspot & {
	hotspot: { conn: string; name: string; password: string; channel: string };
} {
	return (
		i.hotspot.conn !== undefined &&
		i.hotspot.name !== undefined &&
		i.hotspot.password !== undefined &&
		i.hotspot.channel !== undefined
	);
}

export async function wifiHotspotConfig(
	conn: MessageSocket,
	msg: NonNullable<WifiHotspotMessage["hotspot"]["config"]>,
	deps: HotspotConfigDeps = defaultHotspotConfigDeps,
) {
	const binding = captureWifiFrameIncarnation(msg.device, "config");
	const senderId = getSocketSenderId(conn);
	/*
	  These four used to return in silence, which left the dialog's keyed save op
	  pending until its TTL expired — the operator saw a spinner stop with nothing
	  said. `unavailable` is one token for all four because they are one operator
	  fact: this adapter is not currently a reconfigurable hotspot.
	*/
	const refuse = (error = "unavailable", reason?: string) => {
		conn.send(
			buildMsg(
				"wifi",
				{
					hotspot: {
						config: {
							device: msg.device,
							error,
							...(reason === undefined ? {} : { reason }),
							...binding,
						},
					},
				},
				senderId,
			),
		);
	};

	// Find the Wifi interface
	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return refuse();

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return refuse();
	if (
		!wifiAdapterKeyMac(macAddress) ||
		wifiInterface.degradedReason === "permanent-mac-unresolved"
	)
		return refuse("radio-unverified");
	if (!canHotspot(wifiInterface)) return refuse();
	// Make sure the interface is already in hotspot mode
	if (!isHotspotActive(wifiInterface)) return refuse();

	// Make sure all required fields are present and valid
	if (
		msg.name === undefined ||
		typeof msg.name !== "string" ||
		msg.name.length < HOTSPOT_NAME_MIN_LENGTH ||
		msg.name.length > HOTSPOT_NAME_MAX_LENGTH
	) {
		conn.send(
			buildMsg(
				"wifi",
				{
					hotspot: {
						config: { device: msg.device, error: "name", ...binding },
					},
				},
				senderId,
			),
		);
		return;
	}

	if (
		msg.password === undefined ||
		typeof msg.password !== "string" ||
		msg.password.length < HOTSPOT_PASSWORD_MIN_LENGTH ||
		msg.password.length > HOTSPOT_PASSWORD_MAX_LENGTH
	) {
		conn.send(
			buildMsg(
				"wifi",
				{
					hotspot: {
						config: { device: msg.device, error: "password", ...binding },
					},
				},
				senderId,
			),
		);
		return;
	}

	// Hybrid may retain an unchanged hotspot-only preference; fresh SCC proof owns its effective channel.
	if (
		msg.channel === undefined ||
		typeof msg.channel !== "string" ||
		(!isChannelOffered(msg.channel, wifiInterface.hotspot.availableChannels) &&
			!(
				isConcurrentHotspot(wifiInterface) &&
				msg.channel === wifiInterface.hotspot.channel
			))
	) {
		conn.send(
			buildMsg(
				"wifi",
				{
					hotspot: {
						config: { device: msg.device, error: "channel", ...binding },
					},
				},
				senderId,
			),
		);
		return;
	}

	// The offered set is DERIVED from THIS adapter's capability read, so this
	// rejects a mode that is merely well-formed as well as one the radio has
	// never been shown to support. An omitted selection keeps the current one.
	const offeredSecurity = offeredSecurityFor(wifiInterface, deps);
	if (
		msg.security !== undefined &&
		(typeof msg.security !== "string" ||
			!isSecurityOffered(msg.security, offeredSecurity))
	) {
		conn.send(
			buildMsg(
				"wifi",
				{
					hotspot: {
						config: { device: msg.device, error: "security", ...binding },
					},
				},
				senderId,
			),
		);
		return;
	}

	const name = msg.name;
	const password = msg.password;
	const channel = msg.channel;
	const security =
		msg.security ?? wifiInterface.hotspot.security ?? DEFAULT_HOTSPOT_SECURITY;

	// Serialize the reconfigure against every other mutation on this ADAPTER —
	// the RPC layer's `runGuarded` acquires the identical key.
	const entered = registerWifiRequestLockEntry(wifiInterface);
	const pending = withWifiAdapterLock(wifiAdapterLockKey(macAddress), () => {
		const result = admitWifiRequest(
			wifiInterface,
			(admitted) =>
				reconfigureHotspotLocked(
					macAddress,
					wifiInterface,
					name,
					password,
					channel,
					security,
					deps,
					admitted ?? bindingForRow(macAddress, wifiInterface),
				),
			(refusal): ReconfigureResult => refusal,
		);
		entered?.();
		return result;
	});
	const lock = await (entered ? pending.finally(entered) : pending);

	if (!lock.success) {
		conn.send(
			buildMsg(
				"wifi",
				{
					hotspot: {
						config: { device: msg.device, error: "saving", ...binding },
					},
				},
				senderId,
			),
		);
		return;
	}

	const result = lock.result;
	if (typeof result === "object") return refuse(result.error, result.reason);
	if (result === "saving" || result === "activating") {
		conn.send(
			buildMsg(
				"wifi",
				{
					hotspot: {
						config: { device: msg.device, error: result, ...binding },
					},
				},
				senderId,
			),
		);
		return;
	}

	conn.send(
		buildMsg(
			"wifi",
			{
				hotspot: { config: { device: msg.device, success: true, ...binding } },
			},
			senderId,
		),
	);
}

/**
 * Restart one hotspot onto `channel` after a regulatory-domain change, through
 * the SAME path a manual channel change takes — a domain change must not reach
 * the radio by a second, less-tested route.
 */
export async function reconfigureHotspotForRegdomain(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	channel: WifiChannel,
	deps: HotspotConfigDeps = defaultHotspotConfigDeps,
	binding = bindingForRow(macAddress, wifiInterface),
): Promise<boolean> {
	const { name, password } = wifiInterface.hotspot;
	if (!binding || !name || !password) return false;

	// A domain change moves the CHANNEL and nothing else, so the security mode
	// is carried through unexamined rather than re-derived.
	const security = wifiInterface.hotspot.security ?? DEFAULT_HOTSPOT_SECURITY;

	const lock = await withWifiAdapterLock(wifiAdapterLockKey(macAddress), () =>
		admitWifiRequest(
			wifiInterface,
			() =>
				reconfigureHotspotLocked(
					macAddress,
					wifiInterface,
					name,
					password,
					channel,
					security,
					deps,
					binding,
				),
			(refusal): ReconfigureResult => refusal,
		),
	);

	return lock.success && lock.result === "ok";
}

type ReconfigureResult =
	| "ok"
	| "saving"
	| "activating"
	| WifiBindingRefusal
	| {
			readonly success: false;
			readonly error: "activation-failed";
			readonly reason?: typeof HYBRID_CHANNEL_REFUSAL | "deactivation-failed";
	  };

async function reconfigureHotspotLocked(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	name: string,
	password: string,
	channel: string,
	security: HotspotSecurityId,
	deps: HotspotConfigDeps,
	binding?: WifiOperationBinding,
): Promise<ReconfigureResult> {
	const virtual = wifiInterface.concurrentHotspot;
	const operation = wifiOperationGuard(binding, !virtual);
	const admitted = () => operation.check();
	let dispatched = false;
	const interrupted = () =>
		dispatched ? ("activating" as const) : wifiOperationChanged;
	const hotspot = wifiInterface.hotspot;
	const selected = hotspot.conn;
	const owner = resolveWifiAdapterOwner(macAddress, wifiInterface);
	const ownsProfile = hotspotOwnershipGuard(owner, wifiInterface, selected);
	const owned = () => ownsProfile() && (!binding || hotspot.conn === selected);
	if (!owned()) {
		return "saving";
	}
	if (
		virtual &&
		deps.readHybridChannel &&
		!isQualifiedNmManagedHybrid(wifiInterface.ifname)
	)
		return { success: false, error: "activation-failed" };
	const hybridChannel =
		virtual && deps.readHybridChannel
			? await deps.readHybridChannel(wifiInterface.ifname)
			: undefined;
	const targetIdentity =
		virtual && deps.readHybridTargetIdentity
			? await deps.readHybridTargetIdentity(
					wifiInterface.ifname,
					virtual.ifname,
				)
			: undefined;
	const targetCurrent = async () =>
		!virtual ||
		!deps.readHybridTargetIdentity ||
		(targetIdentity !== undefined &&
			(await deps.readHybridTargetIdentity(
				wifiInterface.ifname,
				virtual.ifname,
			)) === targetIdentity);
	const targetMatches = await targetCurrent();
	if (binding && (!(await admitted()) || !operation.current()))
		return wifiOperationChanged;
	if (!targetMatches) return "saving";
	if (virtual && deps.readHybridTargetIdentity)
		operation.bindLeg(targetCurrent);
	const retireTransition = () => {
		if (
			wifiInterface.hotspot === hotspot &&
			hotspot.transition === "activating"
		)
			delete hotspot.transition;
	};
	let activation: { uuid: string; receipt: NmActivationReceipt } | undefined;
	let upAcknowledged = false;
	let upTimedOut = false;
	const activationMatches = async () => {
		if (!activation) return false;
		const { uuid, receipt } = activation;
		const current = await observeHotspotActivation(uuid, receipt.ifname);
		return (
			current?.connected === true &&
			current.path === receipt.path &&
			current.runId === receipt.runId
		);
	};
	const stopRestart = async () => {
		if (activation) {
			const { uuid, receipt } = activation;
			return nmDisconnectActivation(uuid, receipt, {
				nmDisconnect: deps.nmDisconnect ?? nmDisconnect,
			});
		}
		return !upAcknowledged && !upTimedOut;
	};
	const interruptedRestart = async () => {
		try {
			if (!(await stopRestart()))
				logger.warn(
					"Could not verify Down of the interrupted Wi-Fi hotspot restart",
				);
		} finally {
			retireTransition();
		}
		return interrupted();
	};
	const channelRefusal = async (afterUp = false) => {
		const uuid = binding ? selected : wifiInterface.hotspot.conn;
		const stopped = afterUp
			? activation !== undefined && (await stopRestart())
			: owned() && uuid
				? await runHotspotProfileOperation({
						uuid,
						kind: "down",
						run: async () =>
							Boolean(
								virtual &&
									(await nmDisconnectActivation(
										uuid,
										await observeHotspotActivation(uuid, virtual.ifname),
										{ nmDisconnect: deps.nmDisconnect ?? nmDisconnect },
										async () =>
											(await targetCurrent()) &&
											(await operation.permit()) &&
											owned() &&
											wifiInterface.hotspot.conn === uuid &&
											wifiInterface.concurrentHotspot === virtual,
									)),
							),
					}).then((result) => result.success)
				: undefined;
		if (operation.changed) return interrupted();
		if (stopped) {
			if (wifiInterface.concurrentHotspot === virtual)
				transitionVirtualBinding(wifiInterface, { kind: "retire" });
			if (virtual) await releaseConcurrentApInterface(virtual.ifname);
		}
		delete wifiInterface.hotspot.transition;
		deps.broadcastState();
		syncWifiStateCache(macAddress, wifiInterface);
		return {
			success: false,
			error: "activation-failed",
			reason: stopped ? HYBRID_CHANNEL_REFUSAL : "deactivation-failed",
		} as const;
	};
	if (virtual && deps.readHybridChannel && !hybridChannel)
		return channelRefusal();
	const channelCurrent = async () =>
		!hybridChannel ||
		!deps.readHybridChannel ||
		(await deps.readHybridChannel(wifiInterface.ifname))?.identity ===
			hybridChannel.identity;
	const derived = wifiInterface.hotspot.derivedChannels ?? [];
	const offeredSecurity = offeredSecurityFor(wifiInterface, deps);
	// The mode already in force is always restorable, even on an adapter whose
	// capability read has since stopped proving it — a rollback must never be
	// refused by the offering that admitted the value in the first place.
	const previousSecurity =
		wifiInterface.hotspot.security ?? DEFAULT_HOTSPOT_SECURITY;
	const restorableSecurity = offeredSecurity.includes(previousSecurity)
		? offeredSecurity
		: [...offeredSecurity, previousSecurity];
	const write = binding
		? async (uuid: string, fields: Record<string, string>) => {
				if (
					!(await targetCurrent()) ||
					!(await admitted()) ||
					!operation.current() ||
					!owned()
				)
					return false;
				const alreadyDispatched = dispatched;
				dispatched = true;
				return deps.nmConnSetFields(uuid, fields, async () => {
					if ((await operation.permit()) && owned()) return true;
					dispatched = alreadyDispatched;
					return false;
				});
			}
		: deps.nmConnSetFields;
	const previous = {
		name: hotspot.name,
		password: hotspot.password,
		channel: hotspot.channel,
	};

	// Update the NM connection
	const wrote =
		!selected ||
		(await nmConnSetHotspotFields(
			selected,
			name,
			password,
			channel,
			security,
			derived,
			offeredSecurity,
			write,
			hybridChannel?.sameChannelOnly ? hybridChannel.fields : undefined,
		));
	if (binding && (!(await admitted()) || !operation.current()))
		return interrupted();
	if (!wrote) return "saving";

	if (!owned()) {
		return "saving";
	}
	// Restart the connection with the updated config
	beginHotspotTransition(wifiInterface, "activating");
	deps.broadcastState();

	if (isHotspotConfigComplete(wifiInterface)) {
		const restartUuid = wifiInterface.hotspot.conn;
		const readiness: { failure: "channel" | "target" | undefined } = {
			failure: undefined,
		};
		const connectCurrentTarget = async (
			before?: Awaited<ReturnType<typeof readNmProfileInstance>>,
		) => {
			if (!(await channelCurrent())) {
				readiness.failure = "channel";
				return false;
			}
			if (!(await targetCurrent())) {
				readiness.failure = "target";
				return false;
			}
			if (binding && !virtual) {
				const pins = await nmConnGetFields(restartUuid, [
					"802-11-wireless.mac-address",
					"match.path",
					"connection.interface-name",
				]);
				if (
					pins?.[0]?.toLowerCase() !== binding.mac ||
					literalWifiDevicePath(pins?.[1]) !== binding.devicePath ||
					(pins?.[2] !== "" && pins?.[2] !== binding.ifname)
				) {
					readiness.failure = "target";
					return false;
				}
			}
			const instance = binding
				? (before ?? (await readNmProfileInstance(restartUuid)))
				: undefined;
			const runId = instance?.runId;
			const target = virtual?.ifname ?? wifiInterface.ifname;
			const activeConnection = () => readNmDeviceActivation(target);
			const previousActive = runId ? await activeConnection() : undefined;
			if (binding && (!(await admitted()) || !operation.current() || !owned()))
				return false;
			upAcknowledged = Boolean(
				await deps.nmConnect(
					restartUuid,
					HOTSPOT_UP_TO,
					(path) => {
						if (runId)
							activation = {
								uuid: restartUuid,
								receipt: { path, runId, ifname: target },
							};
					},
					() => {
						upTimedOut = true;
					},
				),
			);
			if (upTimedOut && binding) {
				const current = await activeConnection();
				const path = current?.path;
				if (
					runId &&
					previousActive !== undefined &&
					current?.uuid === restartUuid &&
					path &&
					(activation
						? activation.receipt.path === path
						: previousActive.path !== path) &&
					sameNmProfileActivation(
						instance,
						await readNmProfileInstance(restartUuid),
					) &&
					(await targetCurrent()) &&
					(await operation.permit()) &&
					owned()
				) {
					upAcknowledged = current.connected;
				}
			}
			return upAcknowledged;
		};
		const restarted = (
			await runHotspotProfileOperation({
				uuid: restartUuid,
				kind: "up",
				run: connectCurrentTarget,
			})
		).success;
		if (binding && (!(await admitted()) || !operation.current()))
			return interruptedRestart();
		if (readiness.failure === "channel") return channelRefusal();
		if (readiness.failure === "target") {
			delete wifiInterface.hotspot.transition;
			return "saving";
		}
		const confirmRestart = async () => {
			if (!virtual || !hybridChannel || !deps.confirmHybridActivation)
				return true;
			const receipt = activation?.receipt;
			if (
				!receipt ||
				!(await deps.confirmHybridActivation(
					wifiInterface.ifname,
					virtual.ifname,
					restartUuid,
					hybridChannel,
					receipt,
				))
			)
				return false;
			return activationMatches();
		};
		const refusedRestart = async () => {
			if (binding && (!(await admitted()) || !operation.current() || !owned()))
				return interruptedRestart();
			return channelRefusal(true);
		};
		if (restarted && !(await confirmRestart())) return refusedRestart();
		if (!owned()) {
			if (binding && (upAcknowledged || upTimedOut || activation))
				return interruptedRestart();
			retireTransition();
			return "saving";
		}
		if (!restarted) {
			// An acknowledged or receipted Up with unverified readback is not a
			// clean failure and must not be followed by a rollback Up.
			if (upAcknowledged || upTimedOut || activation)
				return interruptedRestart();
			// Failed to bring up the hotspot with the new settings; restore it.
			const restored = await nmConnSetHotspotFields(
				restartUuid,
				previous.name ?? wifiInterface.hotspot.name,
				previous.password ?? wifiInterface.hotspot.password,
				previous.channel ?? wifiInterface.hotspot.channel,
				previousSecurity,
				derived,
				restorableSecurity,
				write,
				hybridChannel?.sameChannelOnly ? hybridChannel.fields : undefined,
			);
			if (binding && (!(await admitted()) || !operation.current()))
				return interruptedRestart();
			if (binding && !restored) {
				retireTransition();
				return "activating";
			}
			if (!owned()) {
				delete wifiInterface.hotspot.transition;
				return "saving";
			}

			const rollbackRestart = await runHotspotProfileOperation({
				uuid: restartUuid,
				kind: "up",
				run: connectCurrentTarget,
			});
			if (binding && (!(await admitted()) || !operation.current()))
				return interruptedRestart();
			if (readiness.failure === "channel") return channelRefusal();
			if (readiness.failure === "target") {
				delete wifiInterface.hotspot.transition;
				return "saving";
			}
			const rollbackMayBeUp = upAcknowledged || upTimedOut || activation;
			if (
				(rollbackRestart.success || rollbackMayBeUp) &&
				!(await confirmRestart())
			)
				return refusedRestart();
			if (!rollbackRestart.success && rollbackMayBeUp)
				return interruptedRestart();
			if (!owned()) {
				if (binding && (upAcknowledged || upTimedOut || activation))
					return interruptedRestart();
				retireTransition();
				return "saving";
			}

			delete wifiInterface.hotspot.transition;
			deps.broadcastState();
			syncWifiStateCache(macAddress, wifiInterface);
			return "activating";
		}
	}

	// Successfully brought up the hotspot with the new settings, reload the conn.
	if (binding) {
		await deps.wifiUpdateSavedConns();
		if (!(await admitted()) || !operation.current())
			return interruptedRestart();
		if (!owned()) {
			return interruptedRestart();
		}
		if (
			virtual &&
			upAcknowledged &&
			(!(await activationMatches()) || !operation.current() || !owned())
		)
			return interruptedRestart();
	}
	delete wifiInterface.hotspot.transition;
	wifiInterface.hotspot.security = security;
	// The operator's chosen credentials are now the adapter's durable identity —
	// a later recreate must restore these, not the originally generated pair.
	if (isWifiChannelName(channel)) {
		const credentials = {
			ssid: name,
			password,
			channel,
			...(wifiInterface.hotspot.conn !== undefined
				? { conn: wifiInterface.hotspot.conn }
				: {}),
		};
		const alias = soleWifiPortAlias(binding);
		deps.rememberCredentials(owner, credentials, alias);
		seedWifiPortMode(owner, alias);
	}
	if (!binding) await deps.wifiUpdateSavedConns();
	if (!owned()) return "saving";
	deps.broadcastState();
	syncWifiStateCache(macAddress, wifiInterface);
	return "ok";
}
