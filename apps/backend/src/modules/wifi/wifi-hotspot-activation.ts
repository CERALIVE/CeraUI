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
import { setNetifDupIpSuppression } from "../network/network-interfaces.ts";
import {
	nmConnect,
	nmConnSetFields,
	nmHotspot,
} from "../network/network-manager.ts";
import { withDeviceLock } from "../network/state/device-lock.ts";
import { getWifiState, setWifiState } from "./state/wifi-state.ts";
import { getWifiInterfaceByMacAddress } from "./wifi-connections.ts";
import {
	registerPendingConfirmation,
	syncWifiStateCache,
} from "./wifi-hotspot-monitor.ts";
import {
	canHotspot,
	type HotspotActivationDeps,
	type HotspotStartResult,
	HOTSPOT_UP_TO,
	isHotspot,
	type WifiHotspotMessage,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import {
	getMacAddressForWifiInterface,
	wifiUpdateDevices,
} from "./wifi-interfaces.ts";
import { broadcastWifiState, wifiUpdateSavedConns } from "./wifi.ts";

/** Production defaults: real NetworkManager + broadcast + dup-IP suppression. */
export const defaultHotspotDeps: HotspotActivationDeps = {
	nmConnect,
	nmConnSetFields,
	nmHotspot,
	wifiUpdateSavedConns,
	broadcastState: broadcastWifiState,
	setDupIpSuppression: setNetifDupIpSuppression,
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
		wifiInterface.hotspot.transition = undefined;
		wifiInterface.conn = priorConn;
		deps.setDupIpSuppression(ifname, false);
		// Restore the cached state so it is NEVER left in hotspot mode on failure.
		setWifiState(priorCache);
		deps.broadcastState();
		return { success: false, error: "activation-failed" };
	};

	if (wifiInterface.hotspot.conn) {
		// Existing hotspot connection: bring it up.
		if (await deps.nmConnect(wifiInterface.hotspot.conn, HOTSPOT_UP_TO)) {
			await deps.nmConnSetFields(wifiInterface.hotspot.conn, {
				"connection.autoconnect": "yes",
				"connection.autoconnect-priority": "999",
			});
		} else {
			return rollback();
		}
	} else {
		// No hotspot connection yet: create one with a generated name/password.
		const ms = macAddress.split(":");
		const name = `CERALIVE_${ms[4]}${ms[5]}`;
		const password = randomBase64(9);

		// Temporary hotspot config to send to the client during activation.
		wifiInterface.hotspot.name = name;
		wifiInterface.hotspot.password = password;
		wifiInterface.hotspot.channel = "auto";
		deps.broadcastState();
		syncWifiStateCache(macAddress, wifiInterface);

		const uuid = await deps.nmHotspot(ifname, name, password, HOTSPOT_UP_TO);
		if (uuid) {
			await deps.nmConnSetFields(uuid, {
				"connection.interface-name": "", // Empty string required; Bun runtime limitation with empty CLI args
				"connection.autoconnect": "yes",
				"connection.autoconnect-priority": "999",
				"802-11-wireless.mac-address": macAddress,
				"802-11-wireless-security.pmf": "disable",
			});
			// The updated settings let the connection be recognised as our hotspot.
			await deps.wifiUpdateSavedConns();
			// Restart the connection with the updated settings (needed to disable pmf).
			if (!(await deps.nmConnect(uuid, HOTSPOT_UP_TO))) {
				return rollback();
			}
		} else {
			return rollback();
		}
	}

	// NM activation issued successfully. The mode flip waits for confirmation —
	// it does NOT block this call (so the UI shows `activating` meanwhile).
	registerPendingConfirmation(macAddress, wifiInterface, deps);
	return { success: true };
}
