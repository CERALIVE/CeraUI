import { afterEach, expect, test } from "bun:test";
import { processIfconfigOutput } from "../modules/network/network-interfaces.ts";
import { wifiCancelScanRefresh } from "../modules/wifi/wifi-connections.ts";
import { wifiDeviceListGetMacAddress } from "../modules/wifi/wifi-device-list.ts";
import { resetWifiInterfaceDiscoveryForTest } from "../modules/wifi/wifi-interfaces.ts";

afterEach(() => {
	processIfconfigOutput("");
	resetWifiInterfaceDiscoveryForTest();
	wifiCancelScanRefresh();
});

test("disconnected predictable Wi-Fi names remain discoverable for station joins", () => {
	for (const name of ["wlan0", "wlx020000000001", "wlp2s0"]) {
		processIfconfigOutput(
			`${name}: flags=4099<UP,BROADCAST,MULTICAST>  mtu 1500\n        ether 02:00:00:00:00:01  txqueuelen 1000  (Ethernet)\n`,
		);
		expect(wifiDeviceListGetMacAddress(name)).toBe("02:00:00:00:00:01");
	}
	processIfconfigOutput(
		"eth9: flags=4099<UP,BROADCAST,MULTICAST>  mtu 1500\n        ether 02:00:00:00:00:02\n",
	);
	expect(wifiDeviceListGetMacAddress("eth9")).toBeUndefined();
	expect(wifiDeviceListGetMacAddress("wlp2s0")).toBeUndefined();
});
