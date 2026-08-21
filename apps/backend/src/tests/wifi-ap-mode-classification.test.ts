/*
  Regression lock for the AP-vs-client classification the Network page renders.

  A radio broadcasting as an access point was reported as a client connection —
  "Connected · <ssid>" with "In Bond" and "Connect" controls — and flipped to
  "Disconnected" moments later. Both symptoms came from ONE cause: hotspot mode
  was derived from `conn`, which the device loop nulls whenever the separately
  polled ifconfig cache has not (yet) seen an address for the radio.
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { getModeForInterface } from "../modules/wifi/state/wifi-state.ts";
import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import {
	isApMode,
	isHotspot,
	type WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import {
	type BaseWifiInterface,
	parseWifiConnectionMode,
	type WifiInterface,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const HOTSPOT_UUID = "hotspot-uuid";
const CLIENT_UUID = "client-uuid";

// `buildEntry` mounts into the process-wide interface registry, and `bun test`
// loads every file into ONE process — so without this the last interface this
// file mounts is inherited by every file that runs after it.
let inheritedRegistry: ReturnType<typeof isolateWifiRegistry> = [];

beforeAll(() => {
	inheritedRegistry = isolateWifiRegistry();
});

afterAll(() => {
	restoreWifiRegistry(inheritedRegistry);
});

function makeIface(
	over: Partial<WifiInterfaceWithHotspot> & {
		hotspotConn?: string | null;
	} = {},
): WifiInterfaceWithHotspot {
	const { hotspotConn = HOTSPOT_UUID, ...rest } = over;
	return {
		id: 0,
		ifname: "wlan0",
		conn: null,
		hw: "Realtek RTL8852BE",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: {
			...(hotspotConn ? { conn: hotspotConn } : {}),
			name: "CERALIVE_test",
			availableChannels: ["auto"],
			warnings: {},
		},
		...rest,
	} as WifiInterfaceWithHotspot;
}

function makeStation(over: Partial<BaseWifiInterface> = {}): WifiInterface {
	return {
		id: 1,
		ifname: "wlan1",
		conn: null,
		hw: "Generic WiFi",
		available: new Map(),
		saved: {},
		savedAll: {},
		...over,
	};
}

describe("parseWifiConnectionMode", () => {
	test("maps nmcli 802-11-wireless.mode onto the classification enum", () => {
		expect(parseWifiConnectionMode("ap")).toBe("ap");
		expect(parseWifiConnectionMode("infrastructure")).toBe("infrastructure");
	});

	test("an unreadable mode is `unknown`, never silently a client", () => {
		expect(parseWifiConnectionMode(undefined)).toBe("unknown");
		expect(parseWifiConnectionMode("")).toBe("unknown");
		expect(parseWifiConnectionMode("adhoc")).toBe("unknown");
	});
});

describe("isHotspot — decoupled from the IP gate", () => {
	test("stays true when the IP-gated `conn` is null but NM still reports the AP active", () => {
		const iface = makeIface({ conn: null, activeConn: HOTSPOT_UUID });
		expect(isHotspot(iface)).toBe(true);
	});

	test("is true on the classic path where `conn` holds the hotspot connection", () => {
		const iface = makeIface({ conn: HOTSPOT_UUID });
		expect(isHotspot(iface)).toBe(true);
	});

	test("is false for a radio associated with somebody else's access point", () => {
		const iface = makeIface({ conn: CLIENT_UUID, activeConn: CLIENT_UUID });
		expect(isHotspot(iface)).toBe(false);
	});

	test("is false when the radio has no hotspot connection at all", () => {
		const iface = makeIface({ hotspotConn: null, activeConn: CLIENT_UUID });
		expect(isHotspot(iface)).toBe(false);
	});
});

describe("isApMode — the classification the operator UI uses", () => {
	test("reports AP mode before the hotspot profile has been adopted", () => {
		// NM says the active connection is 802.11 AP mode; `hotspot.conn` is not
		// discovered yet. Without this the radio rendered as a client connection.
		const iface = makeIface({
			hotspotConn: null,
			activeConn: HOTSPOT_UUID,
			activeMode: "ap",
		});
		expect(isHotspot(iface)).toBe(false);
		expect(isApMode(iface)).toBe(true);
	});

	test("reports client mode for an infrastructure association", () => {
		const iface = makeIface({
			conn: CLIENT_UUID,
			activeConn: CLIENT_UUID,
			activeMode: "infrastructure",
		});
		expect(isApMode(iface)).toBe(false);
	});

	test("never claims AP mode for a radio that cannot be an access point", () => {
		const station = makeStation({
			activeConn: CLIENT_UUID,
			activeMode: "ap",
		});
		expect(isApMode(station)).toBe(false);
	});

	test("an unresolvable NM mode does not flip a client into AP mode", () => {
		const iface = makeIface({
			hotspotConn: null,
			activeConn: CLIENT_UUID,
			activeMode: "unknown",
		});
		expect(isApMode(iface)).toBe(false);
	});
});

describe("cached mode matches the broadcast mode", () => {
	test("getModeForInterface agrees with isApMode for an unadopted AP radio", () => {
		const iface = makeIface({
			hotspotConn: null,
			activeConn: HOTSPOT_UUID,
			activeMode: "ap",
		});
		expect(getModeForInterface(iface)).toBe("hotspot");
	});

	test("getModeForInterface reports station for a client association", () => {
		const iface = makeIface({
			conn: CLIENT_UUID,
			activeConn: CLIENT_UUID,
			activeMode: "infrastructure",
		});
		expect(getModeForInterface(iface)).toBe("station");
	});
});

describe("wifiBuildMsg — an AP radio is never offered client controls", () => {
	test("omits the scan list and saved networks so no Connect target exists", () => {
		const scan = new Map([
			[
				"CERALIVE_test",
				{
					active: true,
					ssid: "CERALIVE_test",
					signal: 90,
					security: "WPA2",
					freq: 2437,
				},
			],
		]);
		const iface = makeIface({
			conn: null,
			activeConn: HOTSPOT_UUID,
			activeMode: "ap",
			available: scan,
			saved: { CERALIVE_test: HOTSPOT_UUID },
		});

		const entry = buildEntry(iface);

		expect(entry?.mode).toBe("hotspot");
		expect(entry?.hotspot).toBeDefined();
		// `available` is what the row's "Connected · <ssid>" line reads: NM lists a
		// radio's OWN access point as in-use, so leaking it renders a hotspot as a
		// client connection.
		expect(entry?.available).toBeUndefined();
		expect(entry?.saved).toEqual({});
		expect(entry?.supports_hotspot).toBeUndefined();
	});

	test("a client association still gets its scan list and Connect affordance", () => {
		const scan = new Map([
			[
				"HomeNet",
				{
					active: true,
					ssid: "HomeNet",
					signal: 70,
					security: "WPA2",
					freq: 5180,
				},
			],
		]);
		const iface = makeIface({
			conn: CLIENT_UUID,
			activeConn: CLIENT_UUID,
			activeMode: "infrastructure",
			available: scan,
			saved: { HomeNet: CLIENT_UUID },
		});

		const entry = buildEntry(iface);

		expect(entry?.mode).toBe("station");
		expect(entry?.hotspot).toBeUndefined();
		expect(entry?.available).toHaveLength(1);
		expect(entry?.supports_hotspot).toBe(true);
	});
});

function buildEntry(iface: WifiInterface) {
	const interfaces = getWifiInterfacesByMacAddress();
	for (const mac of Object.keys(interfaces)) removeWifiInterface(mac);
	addWifiInterface("aa:bb:cc:dd:ee:ff", iface);
	const msg = wifiBuildMsg();
	return msg[iface.id];
}
