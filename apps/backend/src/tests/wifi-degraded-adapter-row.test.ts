import { beforeEach, describe, expect, test } from "bun:test";

import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import { clearWifiInterfacesForTest } from "../modules/wifi/wifi-connections.ts";
import {
	recordDegradedWifiInterface,
	resetWifiInterfaceDiscoveryForTest,
} from "../modules/wifi/wifi-interfaces.ts";

beforeEach(() => {
	clearWifiInterfacesForTest();
	resetWifiInterfaceDiscoveryForTest();
});

describe("degraded WiFi adapter rows", () => {
	for (const reason of [
		"unavailable",
		"operational-mac-missing",
		"permanent-mac-unresolved",
	] as const) {
		test(`keeps a ${reason} adapter visible with its reason`, () => {
			recordDegradedWifiInterface("wlan0", reason);

			expect(wifiBuildMsg()["0"]?.degraded_reason).toBe(reason);
		});
	}
});
