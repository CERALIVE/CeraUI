import { beforeEach, describe, expect, test } from "bun:test";

import {
	getWifiState,
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { startHotspotForInterface } from "../modules/wifi/wifi-hotspot-activation.ts";
import { handleWifiMonitorEvent } from "../modules/wifi/wifi-hotspot-monitor.ts";
import {
	type HotspotActivationDeps,
	isHotspot,
	type WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";

/** Resolve-later promise + resolver, for holding fn pending in concurrency tests. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function makeHotspotIface(opts: {
	ifname: string;
	conn?: string | null;
	hotspotConn?: string;
}): WifiInterfaceWithHotspot {
	return {
		id: 0,
		ifname: opts.ifname,
		conn: opts.conn ?? null,
		hw: "Realtek RTL8812AU",
		available: new Map(),
		saved: {},
		hotspot: {
			...(opts.hotspotConn ? { conn: opts.hotspotConn } : {}),
			availableChannels: ["auto"],
			warnings: {},
		},
	};
}

function makeDeps(over: Partial<HotspotActivationDeps>): HotspotActivationDeps {
	return {
		nmConnect: async () => true,
		nmConnSetFields: async () => true,
		nmHotspot: async () => "hotspot-uuid",
		wifiUpdateSavedConns: async () => {},
		broadcastState: () => {},
		setDupIpSuppression: () => {},
		...over,
	};
}

beforeEach(() => {
	// Reset the shared wifiState cache + neutralize the change callback.
	setWifiState({});
	onWifiChange(() => {});
});

// ─── 1. failed start rolls back to station ───────────────────────────────────

describe("wifiHotspotStart — rollback on failure", () => {
	test("failed nmHotspot rolls back: returns failure and cache stays station", async () => {
		const mac = "dc:a6:32:00:00:01";
		const iface = makeHotspotIface({ ifname: "wlan0" });

		// Seed the cache with the prior station entry.
		setWifiState({ [mac]: { ...iface, mode: "station" } });

		const dupCalls: Array<[string, boolean]> = [];
		const deps = makeDeps({
			nmHotspot: async () => undefined, // activation fails
			setDupIpSuppression: (ifname, on) => dupCalls.push([ifname, on]),
		});

		const result = await startHotspotForInterface(mac, iface, deps);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBe("activation-failed");
		}

		// Cache must NOT be left in hotspot mode.
		expect(getWifiState()[mac]?.mode).toBe("station");
		// Interface rolled back: transition cleared, prior conn restored.
		expect(iface.hotspot.transition).toBeUndefined();
		expect(iface.conn).toBeNull();
		expect(isHotspot(iface)).toBe(false);
		// dup-IP suppression was raised then released across the window.
		expect(dupCalls).toContainEqual(["wlan0", true]);
		expect(dupCalls).toContainEqual(["wlan0", false]);
	});
});

// ─── 2. mode flips only after NM confirmation (no force timer) ────────────────

describe("wifiHotspotStart — NM-confirmed mode flip", () => {
	test("broadcasts activating; flips to hotspot only when monitor confirms", async () => {
		const mac = "dc:a6:32:11:22:33";
		const iface = makeHotspotIface({ ifname: "wlan1" });

		let broadcasts = 0;
		const deps = makeDeps({
			nmHotspot: async () => "hotspot-uuid",
			// Simulate handleHotspotConn binding the created connection.
			wifiUpdateSavedConns: async () => {
				iface.hotspot.conn = "hotspot-uuid";
			},
			nmConnect: async () => true,
			broadcastState: () => {
				broadcasts++;
			},
		});

		const result = await startHotspotForInterface(mac, iface, deps);
		expect(result.success).toBe(true);

		// During activation: transition broadcast, but mode NOT yet hotspot.
		expect(broadcasts).toBeGreaterThan(0);
		expect(iface.hotspot.transition).toBe("activating");
		expect(getWifiState()[mac]?.mode).toBe("station");
		expect(isHotspot(iface)).toBe(false);

		// Feed the NM monitor confirmation event for the hotspot connection.
		const connName = iface.hotspot.name ?? "";
		handleWifiMonitorEvent({
			type: "connection-state",
			connection: connName,
			state: "activated",
		});

		// Now — and only now — the mode flips to hotspot.
		expect(iface.hotspot.transition).toBeUndefined();
		expect(iface.conn).toBe("hotspot-uuid");
		expect(isHotspot(iface)).toBe(true);
		expect(getWifiState()[mac]?.mode).toBe("hotspot");
	});

	test("no confirmation event within the window → mode does NOT flip (no force timer)", async () => {
		const mac = "dc:a6:32:44:55:66";
		const iface = makeHotspotIface({ ifname: "wlan2" });

		// Fast-forward all backoff timers so the full confirmation window elapses
		// instantly — this stands in for "advance time 12s".
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void) => {
			fn();
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof globalThis.setTimeout;

		try {
			const deps = makeDeps({
				nmHotspot: async () => "hotspot-uuid",
				wifiUpdateSavedConns: async () => {
					iface.hotspot.conn = "hotspot-uuid";
				},
				nmConnect: async () => true,
				// Backstop poll never confirms — and no monitor event is fed.
				pollHotspotActive: async () => false,
			});

			const result = await startHotspotForInterface(mac, iface, deps);
			expect(result.success).toBe(true);

			// Let the (now-instant) backstop retry chain settle.
			await Promise.resolve();
			await Promise.resolve();
			await new Promise((r) => realSetTimeout(r, 0));

			// Without a positive confirmation the mode NEVER flips to hotspot.
			expect(getWifiState()[mac]?.mode).toBe("station");
			expect(isHotspot(iface)).toBe(false);
			expect(iface.conn).toBeNull();
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
	});
});

// ─── 3. device lock prevents concurrent ops (T13 integration) ────────────────

describe("wifiHotspotStart — device lock", () => {
	test("a concurrent start on the same device returns DEVICE_BUSY", async () => {
		const mac = "dc:a6:32:77:88:99";
		const iface = makeHotspotIface({ ifname: "wlan3" });

		// First op holds the lock while nmHotspot stays pending.
		const gate = deferred<string | undefined>();
		const firstDeps = makeDeps({
			nmHotspot: () => gate.promise,
		});
		const first = startHotspotForInterface(mac, iface, firstDeps);

		// Second op on the SAME device while the first is in-flight.
		const second = await startHotspotForInterface(mac, iface, makeDeps({}));
		expect(second.success).toBe(false);
		if (!second.success) {
			expect(second.error).toBe("DEVICE_BUSY");
		}

		// Release the first op (fail activation) so the lock is freed.
		gate.resolve(undefined);
		const firstResult = await first;
		expect(firstResult.success).toBe(false);

		// Lock released: a later op on the same device acquires freely.
		const third = await startHotspotForInterface(
			mac,
			makeHotspotIface({
				ifname: "wlan3",
				hotspotConn: "hs-uuid",
				conn: "hs-uuid",
			}),
			makeDeps({}),
		);
		expect(third.success).toBe(true);
	});
});
