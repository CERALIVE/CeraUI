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

import { setNetifDupIpSuppression } from "../network/network-interfaces.ts";
import {
	nmConnect,
	nmConnSetFields,
	nmDisconnect,
} from "../network/network-manager.ts";
import type { MessageSocket } from "../ui/message-socket.ts";
import { buildMsg, getSocketSenderId } from "../ui/websocket-server.ts";
import { rememberHotspotCredentials } from "./hotspot-credentials.ts";
import { broadcastWifiState, wifiUpdateSavedConns } from "./wifi.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import { getWifiCapabilitiesForInterface } from "./wifi-capabilities.ts";
import {
	type DerivedApChannel,
	isChannelOffered,
	isWifiChannelName,
	nmSettingsForChannel,
	type WifiChannel,
} from "./wifi-channels.ts";
import { releaseConcurrentApInterface } from "./wifi-concurrent-interface.ts";
import {
	getWifiInterfaceByMacAddress,
	wifiRescan,
} from "./wifi-connections.ts";
import { settlePending, syncWifiStateCache } from "./wifi-hotspot-monitor.ts";
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
	isHotspotActive,
	type WifiHotspotMessage,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import { getMacAddressForWifiInterface } from "./wifi-interfaces.ts";

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

export async function wifiHotspotStop(
	msg: NonNullable<WifiHotspotMessage["hotspot"]["stop"]>,
) {
	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return;

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return;
	if (!canHotspot(wifiInterface)) return;
	if (!isHotspotActive(wifiInterface)) return; // not in hotspot mode, nothing to do
	if (!wifiInterface.hotspot.conn) return;

	await stopHotspotForInterface(macAddress, wifiInterface);
}

export type HotspotStopDeps = {
	nmConnSetFields: typeof nmConnSetFields;
	nmDisconnect: typeof nmDisconnect;
	releaseConcurrentInterface: typeof releaseConcurrentApInterface;
	broadcastState: typeof broadcastWifiState;
	setDupIpSuppression: typeof setNetifDupIpSuppression;
	rescan: typeof wifiRescan;
};

const defaultHotspotStopDeps: HotspotStopDeps = {
	nmConnSetFields,
	nmDisconnect,
	releaseConcurrentInterface: releaseConcurrentApInterface,
	broadcastState: broadcastWifiState,
	setDupIpSuppression: setNetifDupIpSuppression,
	rescan: wifiRescan,
};

export async function stopHotspotForInterface(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotStopDeps = defaultHotspotStopDeps,
): Promise<void> {
	settlePending(wifiInterface.ifname, false);
	await withWifiAdapterLock(wifiAdapterLockKey(macAddress), () =>
		stopHotspotLocked(macAddress, wifiInterface, deps),
	);
}

async function stopHotspotLocked(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotStopDeps,
): Promise<void> {
	const conn = wifiInterface.hotspot.conn;
	if (!conn) return;

	wifiInterface.hotspot.transition = "deactivating";
	deps.broadcastState();
	syncWifiStateCache(macAddress, wifiInterface);

	await deps.nmConnSetFields(conn, { "connection.autoconnect": "no" });

	if (await deps.nmDisconnect(conn)) {
		if (wifiInterface.concurrentHotspot) {
			const virtualIfname = wifiInterface.concurrentHotspot.ifname;
			delete wifiInterface.concurrentHotspot;
			await deps.releaseConcurrentInterface(virtualIfname);
		} else {
			wifiInterface.conn = null;
			wifiInterface.available.clear();
		}
	}

	delete wifiInterface.hotspot.transition;
	if (wifiInterface.supportsApStaConcurrency !== true) {
		deps.setDupIpSuppression(wifiInterface.ifname, false);
	}
	deps.broadcastState();
	syncWifiStateCache(macAddress, wifiInterface);
	void deps.rescan();
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
	) => Promise<unknown>;
	nmConnect: (uuid: string, timeout?: number) => Promise<unknown>;
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
	) => void;
	/** The adapter's own capability read — the sole evidence for a WPA3 offer. */
	getCapabilities: (ifname: string) => WifiAdapterCapabilities | undefined;
};

export const defaultHotspotConfigDeps: HotspotConfigDeps = {
	nmConnSetFields,
	nmConnect,
	wifiUpdateSavedConns,
	broadcastState: broadcastWifiState,
	rememberCredentials: rememberHotspotCredentials,
	getCapabilities: getWifiCapabilitiesForInterface,
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
	deps: HotspotConfigDeps,
) {
	// An underived channel has no band/number mapping BY CONSTRUCTION, so an
	// illegal channel can never reach nmcli even if validation were bypassed.
	const nmSettings = nmSettingsForChannel(channel, derived);
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

	return deps.nmConnSetFields(uuid, settingsToChange);
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
	// Find the Wifi interface
	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return;

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return;
	if (!canHotspot(wifiInterface)) return;
	if (!isHotspotActive(wifiInterface)) return; // Make sure the interface is already in hotspot mode

	const senderId = getSocketSenderId(conn);

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
				{ hotspot: { config: { device: msg.device, error: "name" } } },
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
				{ hotspot: { config: { device: msg.device, error: "password" } } },
				senderId,
			),
		);
		return;
	}

	// The offered set is DERIVED from the live regulatory domain, so this rejects
	// a channel that is merely well-formed as well as one that is illegal here.
	if (
		msg.channel === undefined ||
		typeof msg.channel !== "string" ||
		!isChannelOffered(msg.channel, wifiInterface.hotspot.availableChannels)
	) {
		conn.send(
			buildMsg(
				"wifi",
				{ hotspot: { config: { device: msg.device, error: "channel" } } },
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
				{ hotspot: { config: { device: msg.device, error: "security" } } },
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
	const lock = await withWifiAdapterLock(wifiAdapterLockKey(macAddress), () =>
		reconfigureHotspotLocked(
			macAddress,
			wifiInterface,
			name,
			password,
			channel,
			security,
			deps,
		),
	);

	if (!lock.success) {
		conn.send(
			buildMsg(
				"wifi",
				{ hotspot: { config: { device: msg.device, error: "saving" } } },
				senderId,
			),
		);
		return;
	}

	const result = lock.result;
	if (result === "saving" || result === "activating") {
		conn.send(
			buildMsg(
				"wifi",
				{ hotspot: { config: { device: msg.device, error: result } } },
				senderId,
			),
		);
		return;
	}

	conn.send(
		buildMsg(
			"wifi",
			{ hotspot: { config: { device: msg.device, success: true } } },
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
): Promise<boolean> {
	const { name, password } = wifiInterface.hotspot;
	if (!name || !password) return false;

	// A domain change moves the CHANNEL and nothing else, so the security mode
	// is carried through unexamined rather than re-derived.
	const security = wifiInterface.hotspot.security ?? DEFAULT_HOTSPOT_SECURITY;

	const lock = await withWifiAdapterLock(wifiAdapterLockKey(macAddress), () =>
		reconfigureHotspotLocked(
			macAddress,
			wifiInterface,
			name,
			password,
			channel,
			security,
			deps,
		),
	);

	return lock.success && lock.result === "ok";
}

type ReconfigureResult = "ok" | "saving" | "activating";

async function reconfigureHotspotLocked(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	name: string,
	password: string,
	channel: string,
	security: HotspotSecurityId,
	deps: HotspotConfigDeps,
): Promise<ReconfigureResult> {
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

	// Update the NM connection
	if (
		wifiInterface.hotspot.conn &&
		!(await nmConnSetHotspotFields(
			wifiInterface.hotspot.conn,
			name,
			password,
			channel,
			security,
			derived,
			offeredSecurity,
			deps,
		))
	) {
		return "saving";
	}

	// Restart the connection with the updated config
	wifiInterface.hotspot.transition = "activating";
	deps.broadcastState();

	if (
		isHotspotConfigComplete(wifiInterface) &&
		!(await deps.nmConnect(wifiInterface.hotspot.conn, HOTSPOT_UP_TO))
	) {
		// Failed to bring up the hotspot with the new settings; restore it.
		await nmConnSetHotspotFields(
			wifiInterface.hotspot.conn,
			wifiInterface.hotspot.name,
			wifiInterface.hotspot.password,
			wifiInterface.hotspot.channel,
			previousSecurity,
			derived,
			restorableSecurity,
			deps,
		);

		await deps.nmConnect(wifiInterface.hotspot.conn, HOTSPOT_UP_TO);

		delete wifiInterface.hotspot.transition;
		deps.broadcastState();
		syncWifiStateCache(macAddress, wifiInterface);
		return "activating";
	}

	// Successfully brought up the hotspot with the new settings, reload the conn.
	delete wifiInterface.hotspot.transition;
	wifiInterface.hotspot.security = security;
	// The operator's chosen credentials are now the adapter's durable identity —
	// a later recreate must restore these, not the originally generated pair.
	if (isWifiChannelName(channel)) {
		deps.rememberCredentials(macAddress, {
			ssid: name,
			password,
			channel,
			...(wifiInterface.hotspot.conn !== undefined
				? { conn: wifiInterface.hotspot.conn }
				: {}),
		});
	}
	await deps.wifiUpdateSavedConns();
	deps.broadcastState();
	syncWifiStateCache(macAddress, wifiInterface);
	return "ok";
}
