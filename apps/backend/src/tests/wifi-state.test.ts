import { describe, expect, test } from "bun:test";

import type { WifiState } from "../modules/network/state-types.ts";
import {
	getModeForInterface,
	onWifiChange,
	reconcileWifi,
	setWifiState,
	type WifiDiffEntry,
} from "../modules/wifi/state/wifi-state.ts";
import type { WifiNetwork } from "../modules/wifi/wifi.ts";

// ─── fixture builders ────────────────────────────────────────────────────────

const MAC = "dc:a6:32:00:00:01";

function net(ssid: string, active: boolean, signal = 70): WifiNetwork {
	return { active, ssid, signal, security: "WPA2", freq: 2412 };
}

function availableMap(networks: WifiNetwork[]): Map<string, WifiNetwork> {
	return new Map(networks.map((n) => [n.ssid, n]));
}

/** A station-mode WiFi entry (BaseWifiInterface + mode). */
function station(opts: {
	conn?: string | null;
	available?: WifiNetwork[];
	ifname?: string;
}): WifiState[string] {
	return {
		id: 0,
		ifname: opts.ifname ?? "wlan0",
		conn: opts.conn ?? null,
		hw: "Realtek RTL8812AU",
		available: availableMap(opts.available ?? []),
		saved: {},
		mode: "station",
	};
}

/** A hotspot-mode WiFi entry (WifiInterfaceWithHotspot + mode). */
function hotspot(opts: {
	conn?: string | null;
	name?: string;
}): WifiState[string] {
	return {
		id: 0,
		ifname: "wlan0",
		conn: opts.conn ?? "hotspot-uuid",
		hw: "Realtek RTL8812AU",
		available: new Map(),
		saved: {},
		mode: "hotspot",
		hotspot: {
			conn: "hotspot-uuid",
			name: opts.name ?? "CERALIVE_0001",
			password: "secretpw1",
			channel: "auto",
			availableChannels: ["auto"],
			warnings: {},
		},
	};
}

function isEmpty(diff: {
	added: WifiDiffEntry[];
	removed: WifiDiffEntry[];
	changed: WifiDiffEntry[];
}): boolean {
	return (
		diff.added.length === 0 &&
		diff.removed.length === 0 &&
		diff.changed.length === 0
	);
}

// ─── 1. station → hotspot mode transition ────────────────────────────────────

describe("reconcileWifi — mode transition", () => {
	test("station-connected → hotspot-active marks mode=hotspot; callback fires once", () => {
		const prev: WifiState = {
			[MAC]: station({ conn: "home-uuid", available: [net("Home", true)] }),
		};
		const next: WifiState = { [MAC]: hotspot({}) };

		const diff = reconcileWifi(next, prev);
		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(0);
		expect(diff.changed).toHaveLength(1);
		expect(diff.changed[0]?.mac).toBe(MAC);
		expect(diff.changed[0]?.data.mode).toBe("hotspot");

		// Callback fires exactly once for the transition.
		let calls = 0;
		onWifiChange(() => calls++);
		setWifiState(prev); // seed the cache
		calls = 0; // ignore seeding
		setWifiState(next);
		expect(calls).toBe(1);
	});
});

// ─── 2. available-networks delta ─────────────────────────────────────────────

describe("reconcileWifi — available-networks delta", () => {
	test("identical scan lists → empty diff", () => {
		const prev: WifiState = {
			[MAC]: station({ available: [net("A", false), net("B", false)] }),
		};
		// Fresh entry, same SSID set (distinct Map instances, fluctuating signal).
		const next: WifiState = {
			[MAC]: station({
				available: [net("A", false, 55), net("B", false, 80)],
			}),
		};

		expect(isEmpty(reconcileWifi(next, prev))).toBe(true);
	});

	test("adding one SSID → changed entry with the new network available", () => {
		const prev: WifiState = {
			[MAC]: station({ available: [net("A", false)] }),
		};
		const next: WifiState = {
			[MAC]: station({ available: [net("A", false), net("New", false)] }),
		};

		const diff = reconcileWifi(next, prev);
		expect(diff.changed).toHaveLength(1);
		const available = diff.changed[0]?.data.available;
		expect(available?.has("New")).toBe(true);
		// One SSID was added relative to prev.
		const prevSize = prev[MAC]?.available.size ?? 0;
		expect((available?.size ?? 0) - prevSize).toBe(1);
	});
});

// ─── 3. connection up/down (ssid change) ─────────────────────────────────────

describe("reconcileWifi — connection up/down", () => {
	test("active SSID change → changed", () => {
		const prev: WifiState = {
			[MAC]: station({
				conn: "a-uuid",
				available: [net("A", true), net("B", false)],
			}),
		};
		const next: WifiState = {
			[MAC]: station({
				conn: "b-uuid",
				available: [net("A", false), net("B", true)],
			}),
		};

		const diff = reconcileWifi(next, prev);
		expect(diff.changed).toHaveLength(1);
		expect(diff.changed[0]?.mac).toBe(MAC);
	});

	test("disconnect (conn → null) → changed", () => {
		const prev: WifiState = {
			[MAC]: station({ conn: "a-uuid", available: [net("A", true)] }),
		};
		const next: WifiState = {
			[MAC]: station({ conn: null, available: [net("A", false)] }),
		};

		expect(reconcileWifi(next, prev).changed).toHaveLength(1);
	});
});

// ─── 4. empty / error fixture ────────────────────────────────────────────────

describe("reconcileWifi — empty fixtures", () => {
	test("no interfaces in either snapshot → empty diff", () => {
		expect(isEmpty(reconcileWifi({}, {}))).toBe(true);
	});

	test("interface removed → removed entry", () => {
		const prev: WifiState = { [MAC]: station({}) };
		const diff = reconcileWifi({}, prev);
		expect(diff.removed).toHaveLength(1);
		expect(diff.removed[0]?.mac).toBe(MAC);
		expect(diff.added).toHaveLength(0);
		expect(diff.changed).toHaveLength(0);
	});

	test("interface added → added entry", () => {
		const next: WifiState = { [MAC]: station({}) };
		const diff = reconcileWifi(next, {});
		expect(diff.added).toHaveLength(1);
		expect(diff.added[0]?.mac).toBe(MAC);
	});
});

// ─── 5. no spurious change ───────────────────────────────────────────────────

describe("reconcileWifi — no spurious change", () => {
	test("identical prev+next → empty diff, callback NOT fired", () => {
		const prev: WifiState = {
			[MAC]: station({ conn: "home-uuid", available: [net("Home", true)] }),
		};
		const next: WifiState = {
			[MAC]: station({ conn: "home-uuid", available: [net("Home", true)] }),
		};

		expect(isEmpty(reconcileWifi(next, prev))).toBe(true);

		let calls = 0;
		onWifiChange(() => calls++);
		setWifiState(prev); // seed
		calls = 0; // ignore seeding
		setWifiState(next); // identical content → no fire
		expect(calls).toBe(0);
	});
});

// ─── getModeForInterface helper ──────────────────────────────────────────────

describe("getModeForInterface", () => {
	test("interface without hotspot → station", () => {
		const iface = {
			id: 0,
			ifname: "wlan0",
			conn: null,
			hw: "hw",
			available: new Map(),
			saved: {},
		};
		expect(getModeForInterface(iface)).toBe("station");
	});

	test("hotspot interface with active hotspot conn → hotspot", () => {
		const iface = {
			id: 0,
			ifname: "wlan0",
			conn: "hotspot-uuid",
			hw: "hw",
			available: new Map(),
			saved: {},
			hotspot: {
				conn: "hotspot-uuid",
				name: "CERALIVE_0001",
				password: "secretpw1",
				channel: "auto" as const,
				availableChannels: ["auto" as const],
				warnings: {},
			},
		};
		expect(getModeForInterface(iface)).toBe("hotspot");
	});
});
