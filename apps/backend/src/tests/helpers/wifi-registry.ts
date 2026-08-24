/*
    CeraUI - WiFi interface registry isolation for bun:test

    `wifiInterfacesByMacAddress` (modules/wifi/wifi-connections.ts) is a
    module-level singleton, and `bun test` loads every test file into ONE
    process — so an interface a test seeds is visible to every file that runs
    after it.

    That matters because the canonical lock key resolves an operator-facing
    device id ("0", "1", ...) by scanning the registry for the FIRST entry with
    that numeric `id` (`wifiAdapterLockKeyForDeviceId`,
    modules/wifi/wifi-adapter-lock.ts). Two entries carrying the same id are
    indistinguishable to that scan, so a leftover id-0 interface from an earlier
    file makes `device: "0"` resolve to a MAC the current test never seeded —
    silently steering a per-adapter lock onto the wrong interface.

    Any test that seeds an interface and then asserts on device-id resolution
    must therefore own the whole registry for the duration of the test.
*/

import type { MacAddress } from "../../modules/network/network-manager.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../../modules/wifi/wifi-connections.ts";
import type { WifiInterface } from "../../modules/wifi/wifi-interfaces.ts";

type RegistrySnapshot = ReadonlyArray<readonly [MacAddress, WifiInterface]>;

function clearRegistry(): void {
	for (const mac of Object.keys(getWifiInterfacesByMacAddress())) {
		removeWifiInterface(mac);
	}
}

/**
 * Empty the WiFi interface registry and return a snapshot of what was in it.
 * Pass the snapshot back to {@link restoreWifiRegistry} so the next file sees
 * exactly the registry this one inherited.
 */
export function isolateWifiRegistry(): RegistrySnapshot {
	const snapshot = Object.entries(getWifiInterfacesByMacAddress()) as Array<
		readonly [MacAddress, WifiInterface]
	>;
	clearRegistry();
	return snapshot;
}

/** Drop whatever the test seeded and put the inherited registry back. */
export function restoreWifiRegistry(snapshot: RegistrySnapshot): void {
	clearRegistry();
	for (const [mac, wifiInterface] of snapshot) {
		addWifiInterface(mac, wifiInterface);
	}
}
