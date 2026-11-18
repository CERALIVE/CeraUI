import assert from "node:assert/strict";
import { basename } from "node:path";
import {
	nmConnGetFields,
	nmDeviceProp,
} from "../../../src/modules/network/network-manager.ts";
import { addWifiInterface } from "../../../src/modules/wifi/wifi-connections.ts";
import {
	refreshDerivedApChannels,
	refreshHotspotChannels,
} from "../../../src/modules/wifi/regdomain.ts";
import { radioIdentityReaders } from "../../../src/modules/wifi/wifi-radio-identity.ts";
import type { AutoWifiChannel } from "../../../src/modules/wifi/wifi-channels.ts";
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
	const phyPath = await radioIdentityReaders.realpath(
		`/sys/class/net/${target.ifname}/phy80211`,
	);
	assert(phyPath, "Native radio phy is unreadable");
	const phy = basename(phyPath);
	const derived = await refreshDerivedApChannels(phy);
	assert(
		derived.some((channel) => channel.channel === 6 && channel.freqMhz === 2437),
		"Native radio does not offer the scenario's channel 6",
	);
	const bands = await nmDeviceProp(
		target.ifname,
		"WIFI-PROPERTIES.2GHZ,WIFI-PROPERTIES.5GHZ",
	);
	const bandCapability: AutoWifiChannel[] = ["auto"];
	assert(bands?.length === 2 && bands.every((value) => value === "yes" || value === "no"), "Native radio bands are unreadable");
	if (bands[0] === "yes") bandCapability.push("auto_24");
	if (bands[1] === "yes") bandCapability.push("auto_50");
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
			availableChannels: [...bandCapability],
			warnings: {},
		},
	};
	refreshHotspotChannels(row.hotspot, derived);
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
