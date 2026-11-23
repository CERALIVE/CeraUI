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

  The sole radio keeps the bare normalized MAC. Proven twins use MAC@port.
  Limited rows can retain an observed profile owner for a safe Stop.
  These keys share the process-wide `withDeviceLock` registry without a prefix.
*/

import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../../helpers/logger.ts";
import type { MacAddress } from "../network/network-manager.ts";
import {
	type DeviceLockResult,
	withDeviceLock,
} from "../network/state/device-lock.ts";
import {
	resolveWifiAdapterOwner,
	retainWifiAdapterOwners,
} from "./wifi-adapter-owner.ts";
import { withoutWifiRequestBinding } from "./wifi-binding.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import {
	isWifiModeTargetPending,
	type WifiInterface,
	wifiUpdateDevices,
} from "./wifi-interfaces.ts";

/** Opaque-by-convention lock key. Never build one by hand. */
export type WifiAdapterLockKey = string;
type WifiLockOwner = {
	readonly key: string;
	live: boolean;
	readonly parent: WifiLockOwner | undefined;
};
const lockOwner = new AsyncLocalStorage<WifiLockOwner>();

/** Awaited normalization may run inline only for the transaction holding this key. */
export function ownsWifiAdapterLock(key: WifiAdapterLockKey): boolean {
	for (let owner = lockOwner.getStore(); owner; owner = owner.parent)
		if (owner.live && owner.key === key) return true;
	return false;
}

/**
 * Resolve the registry key to its lock owner, including limited Stop aliases.
 * Port suffixes keep their case.
 */
export function wifiAdapterLockKey(macAddress: MacAddress): WifiAdapterLockKey {
	return resolveWifiAdapterOwner(
		macAddress,
		getWifiInterfacesByMacAddress()[macAddress],
	);
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

/** Stop/Station can join a handoff without taking a lock discovery still needs. */
export async function awaitWifiStopHandoff(
	row: WifiInterface,
): Promise<boolean> {
	if (!isWifiModeTargetPending(row)) return true;
	const expired = Promise.withResolvers<void>();
	const timeout = setTimeout(() => expired.resolve(), 2000);
	try {
		await Promise.race([
			withoutWifiRequestBinding(wifiUpdateDevices),
			expired.promise,
		]);
	} catch (error: unknown) {
		logger.warn(
			`Wi-Fi handoff refresh failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timeout);
	}
	return !isWifiModeTargetPending(row);
}

/**
 * Run `fn` while holding the canonical per-adapter lock. A thin, deliberately
 * transparent wrapper over {@link withDeviceLock} — the point is that every
 * WiFi caller reaches that primitive through ONE key derivation, not that this
 * adds behaviour.
 */
export function withWifiAdapterLock<T>(
	target:
		| WifiAdapterLockKey
		| { registryKey: MacAddress; modeTarget: WifiInterface },
	fn: () => Promise<T>,
): Promise<DeviceLockResult<T>> {
	if (
		typeof target !== "string" &&
		isWifiModeTargetPending(target.modeTarget)
	) {
		// One fresh pass (or a coalesced trailing pass) per busy mode request.
		void withoutWifiRequestBinding(wifiUpdateDevices).catch(
			(error: unknown) => {
				logger.warn(
					`Wi-Fi handoff refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			},
		);
		return Promise.resolve({ success: false, error: "DEVICE_BUSY" });
	}
	const key =
		typeof target === "string"
			? target
			: wifiAdapterLockKey(target.registryKey);
	return withDeviceLock(key, async () => {
		const owner: WifiLockOwner = {
			key,
			live: true,
			parent: lockOwner.getStore(),
		};
		const release = retainWifiAdapterOwners(
			key,
			getWifiInterfacesByMacAddress(),
		);
		try {
			return await lockOwner.run(owner, fn);
		} finally {
			owner.live = false;
			release();
		}
	});
}

/** The owner is held; retain current row aliases through binding and NM actions. */
export function withWifiAdapterPolicyLocks<T>(
	heldKey: WifiAdapterLockKey,
	targets: ReadonlySet<WifiInterface>,
	fn: () => Promise<T>,
): Promise<DeviceLockResult<T>> {
	const aliases = Object.entries(getWifiInterfacesByMacAddress())
		.filter(([, row]) => targets.has(row))
		.map(([key]) => wifiAdapterLockKey(key))
		.filter((key) => key !== heldKey);
	return withWifiAdapterLocks(aliases, fn);
}

/** Take the entire set before a discovery transfer can change either row. */
export function withWifiAdapterLocks<T>(
	keys: Iterable<WifiAdapterLockKey>,
	fn: () => Promise<T>,
): Promise<DeviceLockResult<T>> {
	const aliases = [...new Set(keys)]
		.filter((key) => !ownsWifiAdapterLock(key))
		.sort();
	const acquire = async (index: number): Promise<DeviceLockResult<T>> => {
		const key = aliases[index];
		if (key === undefined) return { success: true, result: await fn() };
		const locked = await withWifiAdapterLock(key, () => acquire(index + 1));
		return locked.success ? locked.result : locked;
	};
	return acquire(0);
}
