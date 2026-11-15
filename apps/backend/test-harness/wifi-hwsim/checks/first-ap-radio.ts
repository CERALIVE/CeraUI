import assert from "node:assert/strict";
import { nmDeviceProp } from "../../../src/modules/network/network-manager.ts";
import {
	wifiDeviceListAdd,
	wifiDeviceListEndUpdate,
	wifiDeviceListStartUpdate,
} from "../../../src/modules/wifi/wifi-device-list.ts";
import { wifiUpdateDevices } from "../../../src/modules/wifi/wifi-interfaces.ts";

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
