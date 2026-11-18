import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as exec from "../../../src/helpers/exec.ts";
import * as nm from "../../../src/modules/network/network-manager.ts";
import { onWifiChange } from "../../../src/modules/wifi/state/wifi-state.ts";
import * as capabilities from "../../../src/modules/wifi/wifi-capabilities.ts";
import {
	wifiDeviceListEndUpdate,
	wifiDeviceListGetInetAddress,
	wifiDeviceListStartUpdate,
} from "../../../src/modules/wifi/wifi-device-list.ts";
import {
	getWifiInterfaceByMacAddress,
	removeWifiInterface,
} from "../../../src/modules/wifi/wifi-connections.ts";
import { wifiHotspotStop } from "../../../src/modules/wifi/wifi-hotspot-config.ts";
import { wifiBuildMsg } from "../../../src/modules/wifi/wifi.ts";
import {
	getMacAddressForWifiInterface,
	getWifiIdToMacAddress,
	recordDegradedWifiInterface,
	resetWifiInterfaceDiscoveryForTest,
	stopWifiUpdateLoopForTest,
	wifiUpdateDevices,
} from "../../../src/modules/wifi/wifi-interfaces.ts";
import { wifiFrameFixture } from "../../../src/tests/helpers/wifi-frame-fixture.ts";
import { nmcliFieldOutput } from "../../../src/tests/helpers/nmcli-field-output.ts";
import {
	resetRegdomainStateForTest,
	setRegdomainRunner,
} from "../../../src/modules/wifi/regdomain.ts";
import { getWifiChannelMap } from "../../../src/modules/wifi/wifi-channels.ts";
import {
	observeSavedProfileRadio,
	seedObservedRadioRow,
} from "./first-ap-radio.ts";

beforeEach(() => {
	resetRegdomainStateForTest();
	setRegdomainRunner(async (_binary, args) =>
		args[0] === "phy"
			? readFileSync(new URL("../../../src/tests/fixtures/wifi/iw-phy-r22-phy1.txt", import.meta.url), "utf8")
			: "global\ncountry 00: DFS-UNSET\n (2402 - 2472 @ 40), (6, 20), (N/A)\n",
	);
});

afterEach(() => resetRegdomainStateForTest());

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

for (const seeded of [false, true]) {
	test(`native discovery ${seeded ? "keeps a natively seeded row" : "publishes no row"} when hwsim reports no vendor/product`, async () => {
		const fixture = await wifiFrameFixture(true);
		jest.useRealTimers();
		const owner = "dc:a6:32:aa:bb:c0";
		try {
			resetWifiInterfaceDiscoveryForTest();
			// Start as hwsim does: no row until the check seeds one.
			removeWifiInterface(owner);
			onWifiChange(() => {});
			spyOn(exec, "execFileP").mockImplementation(async () => {
				throw new Error("Unexpected OS call in isolated native harness test");
			});
			spyOn(nm, "nmDevices").mockResolvedValue([
				"wlan0:wifi:connected:test-ap",
			]);
			spyOn(nm, "nmDeviceProp").mockImplementation(async (_ifname, fields) =>
				fields === "GENERAL.STATE,GENERAL.CON-UUID"
					? ["100", "uplink-uuid"]
					: fields === "WIFI-PROPERTIES.2GHZ,WIFI-PROPERTIES.5GHZ"
						? ["yes", "yes"]
					: fields === "GENERAL.HWADDR,IP4.ADDRESS"
						? ["DC:A6:32:AA:BB:C0", "192.0.2.10/24"]
						: ["", "", "yes", "yes", "yes"],
			);
			spyOn(nm, "nmScanResults").mockResolvedValue([]);
			spyOn(nm, "nmConnsGet").mockResolvedValue([]);
			spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
			spyOn(capabilities, "refreshWifiCapabilities").mockResolvedValue(
				undefined,
			);
			wifiDeviceListStartUpdate();
			wifiDeviceListEndUpdate();

			const row = seeded
				? await seedObservedRadioRow({
						ifname: "wlan0",
						owner,
						uuid: "ap-uuid",
						ssid: "CeraTest",
						password: "synthetic",
					})
				: undefined;
			await observeSavedProfileRadio("wlan0");

			expect(getWifiInterfaceByMacAddress(owner)).toBe(row);
			if (row) expect(getMacAddressForWifiInterface(row.id)).toBe(owner);
		} finally {
			removeWifiInterface(owner);
			stopWifiUpdateLoopForTest();
			wifiDeviceListStartUpdate();
			wifiDeviceListEndUpdate();
			await fixture.restore();
			mock.restore();
		}
	});
}

test("a seeded row keeps its public hotspot when discovery records another adapter", async () => {
	const fixture = await wifiFrameFixture(true);
	jest.useRealTimers();
	const owner = "dc:a6:32:aa:bb:c0";
	try {
		resetWifiInterfaceDiscoveryForTest();
		// Start as hwsim does: no rows and no IDs until the check seeds one.
		removeWifiInterface(owner);
		const ids = getWifiIdToMacAddress();
		for (const key of Object.keys(ids)) delete ids[Number(key)];
		spyOn(nm, "nmDeviceProp").mockImplementation(async (_ifname, fields) =>
			fields === "WIFI-PROPERTIES.2GHZ,WIFI-PROPERTIES.5GHZ"
				? ["yes", "yes"]
				: ["100", "test-ap"],
		);
		spyOn(nm, "nmConnGetFields").mockResolvedValue(["ap"]);

		const row = await seedObservedRadioRow({
			ifname: "wlan0",
			owner,
			uuid: "test-ap",
			ssid: "CeraTest",
			password: "synthetic",
		});
		// Discovery's own registration for an adapter it cannot classify.
		const degraded = recordDegradedWifiInterface(
			"wlan1",
			"operational-mac-missing",
		);

		expect(wifiBuildMsg()[row.id]?.hotspot?.name).toBe("CeraTest");
		expect(degraded.id).not.toBe(row.id);
	} finally {
		removeWifiInterface(owner);
		removeWifiInterface("degraded:wlan1");
		stopWifiUpdateLoopForTest();
		wifiDeviceListStartUpdate();
		wifiDeviceListEndUpdate();
		await fixture.restore();
		mock.restore();
	}
});

test("native row observation keeps the active AP UUID and channel label through real indexed NM decoding", async () => {
	const fixture = await wifiFrameFixture(true);
	jest.useRealTimers();
	const owner = "dc:a6:32:aa:bb:c0";
	try {
		resetWifiInterfaceDiscoveryForTest();
		spyOn(exec, "execFileP").mockImplementation(async (_binary, args = []) => ({
			stdout: args.includes("GENERAL.HWADDR,IP4.ADDRESS")
				? `GENERAL.HWADDR:${owner.toUpperCase()}\nIP4.ADDRESS[1]:10.42.0.1/24\n`
				: nmcliFieldOutput([...args], (field) => {
						if (field === "GENERAL.HWADDR") return owner.toUpperCase();
						if (field === "GENERAL.STATE") return "100 (connected)";
						if (field === "GENERAL.CON-UUID") return "test-ap";
						if (field === "802-11-wireless.mode") return "ap";
						if (field.startsWith("WIFI-PROPERTIES.")) return "yes";
						return "";
					}),
			stderr: "",
		}));
		spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:connected:test-ap"]);
		spyOn(nm, "nmScanResults").mockResolvedValue([]);
		spyOn(nm, "nmConnsGet").mockResolvedValue([]);
		spyOn(capabilities, "refreshWifiCapabilities").mockResolvedValue(undefined);
		const row = await seedObservedRadioRow({
			ifname: "wlan0", owner, uuid: "test-ap", ssid: "CeraTest", password: "synthetic",
		});
		await observeSavedProfileRadio("wlan0");
		expect(wifiDeviceListGetInetAddress("wlan0")).toBe("10.42.0.1");
		expect(row.conn).toBe("test-ap");
		expect(getWifiChannelMap(row.hotspot.availableChannels, row.hotspot.derivedChannels).ch_6).toEqual({
			name: "Channel 6 (2.4 GHz)",
		});
	} finally {
		stopWifiUpdateLoopForTest();
		wifiDeviceListStartUpdate();
		wifiDeviceListEndUpdate();
		await fixture.restore();
		mock.restore();
	}
});
