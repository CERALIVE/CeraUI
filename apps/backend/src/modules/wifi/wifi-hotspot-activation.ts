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

import { randomBase64 } from "../../helpers/crypto.ts";
import { logger } from "../../helpers/logger.ts";
import { setNetifDupIpSuppression } from "../network/network-interfaces.ts";
import {
	nmConnect,
	nmConnSetFields,
	nmHotspot,
} from "../network/network-manager.ts";
import { withDeviceLock } from "../network/state/device-lock.ts";
import { hotspotCredentialsStore } from "./hotspot-credentials.ts";
import { getWifiState, setWifiState } from "./state/wifi-state.ts";
import { broadcastWifiState, wifiUpdateSavedConns } from "./wifi.ts";
import { getWifiInterfaceByMacAddress } from "./wifi-connections.ts";
import {
	findHotspotConnForAdapter,
	pruneDuplicateHotspotConns,
} from "./wifi-hotspot-discovery.ts";
import {
	registerPendingConfirmation,
	syncWifiStateCache,
} from "./wifi-hotspot-monitor.ts";
import {
	canHotspot,
	HOTSPOT_AUTOCONNECT_FIELDS,
	HOTSPOT_UP_TO,
	type HotspotActivationDeps,
	type HotspotStartResult,
	hotspotBindingFields,
	isHotspot,
	type WifiHotspotMessage,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import {
	getMacAddressForWifiInterface,
	wifiUpdateDevices,
} from "./wifi-interfaces.ts";

/** Production defaults: real NetworkManager + broadcast + dup-IP suppression. */
export const defaultHotspotDeps: HotspotActivationDeps = {
	nmConnect,
	nmConnSetFields,
	nmHotspot,
	wifiUpdateSavedConns,
	broadcastState: broadcastWifiState,
	setDupIpSuppression: setNetifDupIpSuppression,
	credentials: hotspotCredentialsStore,
	findHotspotConn: findHotspotConnForAdapter,
	pruneHotspotConns: async (macAddress, keepUuid) => {
		await pruneDuplicateHotspotConns(macAddress, keepUuid);
	},
	pollHotspotActive: async (iface) => {
		// Re-poll authoritative NM device state, then check whether the active
		// connection now matches our hotspot connection.
		await wifiUpdateDevices();
		return isHotspot(iface);
	},
};

// ─── start (atomic, NM-confirmed, with rollback) ─────────────────────────────

export async function wifiHotspotStart(
	msg: NonNullable<WifiHotspotMessage["hotspot"]["start"]>,
	deps: HotspotActivationDeps = defaultHotspotDeps,
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
 * Atomic station→hotspot switch for a resolved interface. Serialized per device
 * via {@link withDeviceLock}; a concurrent request on the same device returns
 * `DEVICE_BUSY` without touching state.
 */
export async function startHotspotForInterface(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotActivationDeps = defaultHotspotDeps,
): Promise<HotspotStartResult> {
	const lock = await withDeviceLock(wifiInterface.ifname, () =>
		startHotspotLocked(macAddress, wifiInterface, deps),
	);
	if (!lock.success) return { success: false, error: lock.error };
	return lock.result;
}

async function startHotspotLocked(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotActivationDeps,
): Promise<HotspotStartResult> {
	const ifname = wifiInterface.ifname;

	// Already in hotspot mode for this exact connection — nothing to do.
	if (
		wifiInterface.hotspot.conn &&
		wifiInterface.hotspot.conn === wifiInterface.conn
	) {
		return { success: true };
	}

	// Snapshot prior state for rollback. getWifiState() returns the live cache
	// reference; syncing below swaps in a NEW object, so this stays the old one.
	const priorCache = getWifiState();
	const priorConn = wifiInterface.conn;

	// Begin the transition: broadcast `activating` immediately (responsive UI),
	// suppress dup-IP warnings for the window, but DO NOT flip mode yet.
	wifiInterface.hotspot.transition = "activating";
	deps.setDupIpSuppression(ifname, true);
	deps.broadcastState();
	syncWifiStateCache(macAddress, wifiInterface); // still station (isHotspot false)

	const rollback = (): HotspotStartResult => {
		delete wifiInterface.hotspot.transition;
		wifiInterface.conn = priorConn;
		deps.setDupIpSuppression(ifname, false);
		// Restore the cached state so it is NEVER left in hotspot mode on failure.
		setWifiState(priorCache);
		deps.broadcastState();
		return { success: false, error: "activation-failed" };
	};

	const stored = deps.credentials.get(macAddress);

	const remember = (conn?: string) => {
		const { name, password, channel } = wifiInterface.hotspot;
		if (!name || !password) return;
		deps.credentials.remember(macAddress, {
			ssid: name,
			password,
			...(conn !== undefined ? { conn } : {}),
			...(channel !== undefined ? { channel } : {}),
		});
	};

	/*
	  Discovery runs BEFORE generation, and it is what makes the SSID/password
	  stable: an adapter that has ever hosted a hotspot already owns a profile, so
	  a restart (which wipes `hotspot.conn`) must find it rather than mint a
	  second identity the operator's phone has never been told about.
	*/
	let conn = wifiInterface.hotspot.conn;
	if (!conn) {
		const existing = await deps.findHotspotConn(macAddress, stored);
		if (existing) {
			conn = existing.uuid;
			wifiInterface.hotspot.conn = existing.uuid;
			wifiInterface.hotspot.name = existing.ssid;
			wifiInterface.hotspot.password = existing.password;
			wifiInterface.hotspot.channel = existing.channel;
		}
	}

	// Cleanup is best-effort, runs off the critical path, and never fails a start.
	const prune = (keepUuid: string) => {
		void deps
			.pruneHotspotConns(macAddress, keepUuid)
			.catch((err) => logger.debug(`hotspot profile cleanup failed: ${err}`));
	};

	if (conn) {
		await deps.nmConnSetFields(
			conn,
			hotspotBindingFields(macAddress, wifiInterface.hotspot.security),
		);
		prune(conn);
		if (!(await deps.nmConnect(conn, HOTSPOT_UP_TO))) {
			return rollback();
		}
		await deps.nmConnSetFields(conn, HOTSPOT_AUTOCONNECT_FIELDS);
		remember(conn);
	} else {
		// First hotspot this adapter has ever hosted, or its profile was deleted
		// outside CeraUI — reuse the persisted identity when there is one.
		const ms = macAddress.split(":");
		const name = stored?.ssid ?? `CERALIVE_${ms[4]}${ms[5]}`;
		const password = stored?.password ?? randomBase64(9);

		wifiInterface.hotspot.name = name;
		wifiInterface.hotspot.password = password;
		wifiInterface.hotspot.channel = stored?.channel ?? "auto";
		// Persist before activating: a start that dies mid-flight must not strand
		// credentials the UI has already shown the operator.
		remember(stored?.conn);
		deps.broadcastState();
		syncWifiStateCache(macAddress, wifiInterface);

		const uuid = await deps.nmHotspot(ifname, name, password, HOTSPOT_UP_TO);
		if (!uuid) {
			return rollback();
		}

		await deps.nmConnSetFields(
			uuid,
			hotspotBindingFields(macAddress, wifiInterface.hotspot.security),
		);
		// The updated settings let the connection be recognised as our hotspot.
		await deps.wifiUpdateSavedConns();
		prune(uuid);
		// Restart the connection with the updated settings (needed to disable pmf).
		if (!(await deps.nmConnect(uuid, HOTSPOT_UP_TO))) {
			return rollback();
		}
		await deps.nmConnSetFields(uuid, HOTSPOT_AUTOCONNECT_FIELDS);
		conn = uuid;
		wifiInterface.hotspot.conn ??= uuid;
		remember(uuid);
	}

	// NM activation issued successfully. The mode flip waits for confirmation —
	// it does NOT block this call (so the UI shows `activating` meanwhile).
	registerPendingConfirmation(macAddress, wifiInterface, deps);
	return { success: true };
}
