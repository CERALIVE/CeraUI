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

/*
  THE canonical per-adapter WiFi lock key, and the ONLY module allowed to derive
  one. Every mutating WiFi path — the oRPC procedures in `rpc/procedures/
  wifi.procedure.ts` AND the hotspot start/stop/reconfigure transactions under
  `modules/wifi/` — imports from here, so the two layers cannot serialize against
  different keys for the same radio.

  WHY THIS EXISTS. The two layers used to derive their own, and they disagreed:
  the RPC layer keyed on the adapter's registry MAC while
  `startHotspotForInterface` / `stopHotspotForInterface` / `wifiHotspotConfig`
  keyed on `wifiInterface.ifname`. Those are two DIFFERENT strings for one radio,
  so `withDeviceLock` handed both callers the lock at once and the guard that
  exists to serialize an NM activation against a station mutation serialized
  nothing at all. `wifiConnectNewProcedure` compounded it by taking no lock in
  the first place.

  WHY THE PERMANENT MAC. It is the SAME value `wifiInterfacesByMacAddress` is
  keyed on (`wifi-interfaces.ts` resolves it through `resolveWifiPermanentMac`),
  so a lock key and a registry lookup can never name different adapters. An
  ifname cannot carry that guarantee: NetworkManager renames adapters (this
  fleet's duplicate-MAC dongles rename against each other on replug), and the
  AP+STA concurrent path deliberately activates a hotspot on a SECOND, virtual
  `clap-<parent>` interface that belongs to the same physical radio — locking on
  the ifname there would leave the parent's station mutations completely
  unguarded.

  It is deliberately the BARE normalized MAC and carries no prefix: it shares the
  process-wide `withDeviceLock` registry, and prefixing would silently stop
  matching a key an existing caller (or test) already holds.
*/

import type { MacAddress } from "../network/network-manager.ts";
import {
	type DeviceLockResult,
	withDeviceLock,
} from "../network/state/device-lock.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";

/** Opaque-by-convention lock key. Never build one by hand. */
export type WifiAdapterLockKey = string;

/**
 * Derive the canonical lock key for an adapter from its permanent hardware
 * address — the registry key produced by {@link resolveWifiPermanentMac}.
 *
 * A well-formed address normalizes to the canonical lowercase colon form; a
 * caller holding something else keeps its own string (lowercased) rather than
 * silently resolving to `undefined`, because refusing to produce a key would
 * turn a serialized mutation into an unguarded one.
 */
export function wifiAdapterLockKey(macAddress: MacAddress): WifiAdapterLockKey {
	return normalizeMacAddress(macAddress) ?? macAddress.trim().toLowerCase();
}

/**
 * Resolve the canonical key from the numeric device id the wire carries
 * (`"0"`, `"1"`, …). `undefined` when no adapter answers to that id — there is
 * then no radio to serialize against.
 */
export function wifiAdapterLockKeyForDeviceId(
	device: string | number,
): WifiAdapterLockKey | undefined {
	const id = typeof device === "number" ? device : Number.parseInt(device, 10);
	if (Number.isNaN(id)) return undefined;
	const interfaces = getWifiInterfacesByMacAddress();
	for (const mac in interfaces) {
		if (interfaces[mac]?.id === id) return wifiAdapterLockKey(mac);
	}
	return undefined;
}

/**
 * Resolve the canonical key from a saved or active connection UUID, so
 * connect/disconnect/forget lock the same adapter a hotspot toggle would.
 */
export function wifiAdapterLockKeyForConnectionUuid(
	uuid: string,
): WifiAdapterLockKey | undefined {
	const interfaces = getWifiInterfacesByMacAddress();
	for (const mac in interfaces) {
		const wifiInterface = interfaces[mac];
		if (!wifiInterface) continue;
		if (wifiInterface.conn === uuid) return wifiAdapterLockKey(mac);
		for (const ssid in wifiInterface.saved) {
			if (wifiInterface.saved[ssid] === uuid) return wifiAdapterLockKey(mac);
		}
	}
	return undefined;
}

/**
 * Run `fn` while holding the canonical per-adapter lock. A thin, deliberately
 * transparent wrapper over {@link withDeviceLock} — the point is that every
 * WiFi caller reaches that primitive through ONE key derivation, not that this
 * adds behaviour.
 */
export function withWifiAdapterLock<T>(
	key: WifiAdapterLockKey,
	fn: () => Promise<T>,
): Promise<DeviceLockResult<T>> {
	return withDeviceLock(key, fn);
}
