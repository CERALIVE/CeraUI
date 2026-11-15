import { expect, jest, mock, spyOn, test } from "bun:test";
import * as exec from "../../../src/helpers/exec.ts";
import * as nm from "../../../src/modules/network/network-manager.ts";
import { onWifiChange } from "../../../src/modules/wifi/state/wifi-state.ts";
import * as capabilities from "../../../src/modules/wifi/wifi-capabilities.ts";
import {
	wifiDeviceListEndUpdate,
	wifiDeviceListGetInetAddress,
	wifiDeviceListStartUpdate,
} from "../../../src/modules/wifi/wifi-device-list.ts";
import { wifiHotspotStop } from "../../../src/modules/wifi/wifi-hotspot-config.ts";
import {
	getMacAddressForWifiInterface,
	resetWifiInterfaceDiscoveryForTest,
	stopWifiUpdateLoopForTest,
	wifiUpdateDevices,
} from "../../../src/modules/wifi/wifi-interfaces.ts";
import { wifiFrameFixture } from "../../../src/tests/helpers/wifi-frame-fixture.ts";
import { observeSavedProfileRadio } from "./first-ap-radio.ts";

for (const populated of [false, true]) {
	test(`native discovery ${populated ? "keeps the ID with observed MAC/IP" : "refuses Stop with an empty operational cache"}`, async () => {
		const fixture = await wifiFrameFixture(true);
		jest.useRealTimers();
		const down = spyOn(nm, "nmDisconnect").mockResolvedValue(true);
		try {
			resetWifiInterfaceDiscoveryForTest();
			onWifiChange(() => {});
			spyOn(exec, "execFileP").mockImplementation(async () => {
				throw new Error("Unexpected OS call in isolated native harness test");
			});
			spyOn(nm, "nmDevices").mockResolvedValue([
				"wlan0:wifi:connected:test-ap",
			]);
			spyOn(nm, "nmDeviceProp").mockResolvedValue([
				"DC:A6:32:AA:BB:C0",
				"192.0.2.10/24",
			]);
			spyOn(nm, "nmScanResults").mockResolvedValue([]);
			spyOn(nm, "nmConnsGet").mockResolvedValue([]);
			spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
			spyOn(capabilities, "refreshWifiCapabilities").mockResolvedValue(
				undefined,
			);
			wifiDeviceListStartUpdate();
			wifiDeviceListEndUpdate();

			if (populated) await observeSavedProfileRadio("wlan0");
			else await wifiUpdateDevices();

			if (populated) {
				expect(getMacAddressForWifiInterface(0)).toBe("dc:a6:32:aa:bb:c0");
				expect(wifiDeviceListGetInetAddress("wlan0")).toBe("192.0.2.10");
			} else {
				expect(getMacAddressForWifiInterface(0)).toBeUndefined();
				expect(await wifiHotspotStop({ device: 0 })).toEqual({
					success: false,
					error: "no-device",
				});
				expect(down).not.toHaveBeenCalled();
			}
		} finally {
			stopWifiUpdateLoopForTest();
			wifiDeviceListStartUpdate();
			wifiDeviceListEndUpdate();
			await fixture.restore();
			mock.restore();
		}
	});
}
