import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";

import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import {
	refreshHotspotClients,
	resetHotspotClientsForTest,
	setHotspotClientsDepsForTest,
} from "../modules/wifi/wifi-hotspot-clients.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const HOTSPOT_UUID = "hotspot-uuid";
const UPSTREAM_UUID = "upstream-uuid";
const CLIENT_MAC = "aa:bb:cc:dd:ee:01";
const UPSTREAM_MAC = "aa:bb:cc:dd:ee:02";

let inheritedRegistry: ReturnType<typeof isolateWifiRegistry> = [];

beforeAll(() => {
	inheritedRegistry = isolateWifiRegistry();
});

afterAll(() => {
	restoreWifiRegistry(inheritedRegistry);
});

afterEach(() => {
	resetHotspotClientsForTest();
	for (const mac of Object.keys(getWifiInterfacesByMacAddress())) {
		removeWifiInterface(mac);
	}
});

function makeInterface(
	overrides: Partial<WifiInterfaceWithHotspot> = {},
): WifiInterfaceWithHotspot {
	return {
		id: 0,
		ifname: "wlan0",
		conn: HOTSPOT_UUID,
		activeConn: HOTSPOT_UUID,
		activeMode: "ap",
		hw: "Wi-Fi adapter",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: {
			conn: HOTSPOT_UUID,
			name: "CERALIVE_test",
			availableChannels: ["auto"],
			warnings: {},
		},
		...overrides,
	};
}

function wireStationDump(): string[][] {
	const calls: string[][] = [];
	setHotspotClientsDepsForTest({
		runIw: async (args) => {
			calls.push(args);
			return args[1] === "clap-wlan0"
				? `Station ${CLIENT_MAC} (on clap-wlan0)\n`
				: `Station ${UPSTREAM_MAC} (on wlan0)\n`;
		},
	});
	return calls;
}

function seedInterface(wifiInterface: WifiInterfaceWithHotspot) {
	addWifiInterface("aa:bb:cc:dd:ee:ff", wifiInterface);
	return wifiBuildMsg()[wifiInterface.id];
}

describe("wifiBuildMsg hotspot client interface", () => {
	test("reads Hybrid clients from the concurrent access-point netdev", async () => {
		const calls = wireStationDump();
		await refreshHotspotClients(["clap-wlan0"]);

		const entry = seedInterface(
			makeInterface({
				conn: UPSTREAM_UUID,
				activeConn: UPSTREAM_UUID,
				activeMode: "infrastructure",
				supportsApStaConcurrency: true,
				concurrentHotspot: {
					ifname: "clap-wlan0",
					activeConn: HOTSPOT_UUID,
				},
			}),
		);

		expect(entry?.hotspot?.clients).toEqual({
			count: 1,
			stations: [{ mac: CLIENT_MAC }],
		});
		expect(calls).toEqual([["dev", "clap-wlan0", "station", "dump"]]);
	});

	test("continues to read exclusive AP clients from its own interface", async () => {
		const calls = wireStationDump();
		await refreshHotspotClients(["wlan0"]);

		const entry = seedInterface(makeInterface());

		expect(entry?.hotspot?.clients).toEqual({
			count: 1,
			stations: [{ mac: UPSTREAM_MAC }],
		});
		expect(calls).toEqual([["dev", "wlan0", "station", "dump"]]);
	});

	test("does not read or publish a concurrent hotspot while activating", () => {
		const calls = wireStationDump();
		const entry = seedInterface(
			makeInterface({
				conn: UPSTREAM_UUID,
				activeConn: UPSTREAM_UUID,
				activeMode: "infrastructure",
				supportsApStaConcurrency: true,
				concurrentHotspot: {
					ifname: "clap-wlan0",
					activeConn: null,
				},
			}),
		);

		expect(entry?.hotspot).toBeUndefined();
		expect(calls).toEqual([]);
	});
});
