import assert from "node:assert/strict";
import {
	nmConnGetFields,
	nmDeviceProp,
} from "../../../src/modules/network/network-manager.ts";
import { addWifiInterface } from "../../../src/modules/wifi/wifi-connections.ts";
import {
	wifiDeviceListAdd,
	wifiDeviceListEndUpdate,
	wifiDeviceListStartUpdate,
} from "../../../src/modules/wifi/wifi-device-list.ts";
import type { WifiInterfaceWithHotspot } from "../../../src/modules/wifi/wifi-hotspot-types.ts";
import {
	recordDegradedWifiInterface,
	wifiUpdateDevices,
} from "../../../src/modules/wifi/wifi-interfaces.ts";

/**
 * Seed the radio's resolved row through the operational cache from native state only. hwsim reports
 * no vendor/product, so the fixture invents none (and no identity overrides); discovery then keeps
 * this row instead of requiring vendor/product for a new one. Both native checks pin channel 6.
 * The ID comes from discovery's own allocator, so no later row can reuse it in the public status.
 */
export async function seedObservedRadioRow(target: {
	readonly ifname: string;
	readonly owner: string;
	readonly uuid: string;
	readonly ssid: string;
	readonly password: string;
}): Promise<WifiInterfaceWithHotspot> {
	const observed = await nmDeviceProp(
		target.ifname,
		"GENERAL.STATE,GENERAL.CON-UUID",
	);
	assert(observed?.[0], "Native device state is unreadable");
	const active =
		Number.parseInt(observed[0], 10) === 100 ? observed[1] || null : null;
	const mode = active
		? (await nmConnGetFields(active, ["802-11-wireless.mode"] as const))?.[0]
		: undefined;
	// recordDegradedWifiInterface is the existing export that advances the allocator; the row below replaces its placeholder under the same key.
	const { id } = recordDegradedWifiInterface(
		target.ifname,
		"unavailable",
		target.owner,
	);
	const row: WifiInterfaceWithHotspot = {
		id,
		ifname: target.ifname,
		hw: "",
		conn: active,
		activeConn: active,
		activeMode: mode === "ap" || mode === "infrastructure" ? mode : "unknown",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: {
			conn: target.uuid,
			name: target.ssid,
			password: target.password,
			channel: "ch_6",
			availableChannels: ["ch_6"],
			warnings: {},
		},
	};
	addWifiInterface(target.owner, row);
	return row;
}

/** Feed only this radio's observed MAC/IP, so another unresolved radio cannot end the discovery pass. */
export async function observeSavedProfileRadio(ifname: string): Promise<void> {
	const observed = await nmDeviceProp(ifname, "GENERAL.HWADDR,IP4.ADDRESS");
	assert(observed?.[0], "Native operational address is unreadable");
	wifiDeviceListStartUpdate();
	wifiDeviceListAdd(
		ifname,
		observed[0].toLowerCase(),
		observed[1]?.split("/")[0] || null,
	);
	wifiDeviceListEndUpdate();
	await wifiUpdateDevices();
}
