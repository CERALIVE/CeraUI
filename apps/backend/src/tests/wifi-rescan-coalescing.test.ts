/*
  Regression lock: a repeated `wifi.scan` RPC must not spawn nmcli without bound,
  AND the guard that bounds it must be PER ADAPTER.

  Board-measured on a Rock 5B+ (2026-08-19). With CeraUI's WiFi selector dialog
  CLOSED the device ran ONE nmcli (the `nmcli monitor` supervisor) and held 31
  system-bus names. Within five seconds of OPENING it, 250-330 concurrent
  `nmcli device wifi rescan` processes were live and root's D-Bus
  `max_connections_per_user=256` limit was exhausted — after which EVERY nmcli
  on the box failed `Could not create NMClient object`, including this backend's
  own `nmcli conn down` (WiFi disconnect) and `nmcli conn del` (WiFi forget).
  The operator's report was "forgetting a network or disconnecting from a
  network is not working", and the storm runs exactly while the dialog they use
  to do both is open.

  The client that produced it is fixed separately (see the frontend's
  `WifiSelectorDialog.periodic-scan.test.ts`). This locks the device-side floor:
  whoever sends the RPC, and however fast, one rescan per ADAPTER is in flight
  at a time — and two adapters are two scans, because a scan of one radio says
  nothing about another.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { MacAddress } from "../modules/network/network-manager.ts";
import {
	addWifiInterface,
	getWifiScanStampForDevice,
	resetWifiScanStampsForTest,
	setRescanActionForTest,
	setScanRefreshAction,
	setScanResultReaderForTest,
	wifiCancelScanRefresh,
	wifiRescan,
	wifiScanKeyForDevice,
} from "../modules/wifi/wifi-connections.ts";
import type { WifiInterface } from "../modules/wifi/wifi-interfaces.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

/** Resolves only when told to, so "in flight" is a state the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const RADIO_A: MacAddress = "aa:bb:cc:dd:ee:01";
const RADIO_B: MacAddress = "aa:bb:cc:dd:ee:02";

function seedRadio(macAddress: MacAddress, id: number, ifname: string): void {
	addWifiInterface(macAddress, {
		id,
		ifname,
		conn: null,
		hw: `radio ${id}`,
		available: new Map(),
		saved: {},
		savedAll: {},
	} as WifiInterface);
}

let inheritedRegistry: ReturnType<typeof isolateWifiRegistry>;

beforeEach(() => {
	inheritedRegistry = isolateWifiRegistry();
	resetWifiScanStampsForTest();
	seedRadio(RADIO_A, 0, "wlan0");
	seedRadio(RADIO_B, 1, "wlan1");
	setScanRefreshAction(() => {});
	setScanResultReaderForTest(() => Promise.resolve(true));
});

afterEach(() => {
	wifiCancelScanRefresh();
	restoreWifiRegistry(inheritedRegistry);
	resetWifiScanStampsForTest();
});

describe("wifiRescan coalescing", () => {
	test("concurrent callers for ONE adapter share ONE rescan", async () => {
		// Given: a rescan on adapter 0 that has started and not yet finished.
		const spawns: Array<string | undefined> = [];
		const gate = deferred();
		setRescanActionForTest((device) => {
			spawns.push(device);
			return gate.promise;
		});

		// When: five more callers ask for the SAME adapter while it is in flight.
		const calls = [
			wifiRescan(0),
			wifiRescan(0),
			wifiRescan(0),
			wifiRescan(0),
			wifiRescan(0),
		];

		// Then: exactly one spawn happened, and every caller is served by it.
		expect(spawns).toEqual(["wlan0"]);
		gate.resolve();
		await Promise.all(calls);
		expect(spawns).toEqual(["wlan0"]);
	});

	test("TWO adapters scanning concurrently do NOT coalesce", async () => {
		// Given: adapter 0's rescan in flight.
		const spawns: Array<string | undefined> = [];
		const gate = deferred();
		setRescanActionForTest((device) => {
			spawns.push(device);
			return gate.promise;
		});
		const first = wifiRescan(0);

		// When: adapter 1 asks for its own scan while adapter 0's is unfinished.
		const second = wifiRescan(1);

		// Then: adapter 1 got its OWN nmcli, on its OWN interface — a scan of
		// wlan0 is not an answer about wlan1.
		expect(spawns).toEqual(["wlan0", "wlan1"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(spawns).toEqual(["wlan0", "wlan1"]);
	});

	test("the coalescing key is the adapter's canonical permanent-MAC key", () => {
		// Given/Then: a resolvable device id keys on the SAME identity every WiFi
		// mutation locks on, so a scan and a mutation cannot disagree about which
		// radio they mean.
		expect(wifiScanKeyForDevice(0)).toBe(RADIO_A);
		expect(wifiScanKeyForDevice(1)).toBe(RADIO_B);
		expect(wifiScanKeyForDevice(0)).not.toBe(wifiScanKeyForDevice(1));
	});

	test("a caller AFTER the in-flight run settles gets a fresh rescan", async () => {
		// Given: one completed rescan on adapter 0.
		let spawns = 0;
		setRescanActionForTest(() => {
			spawns++;
			return Promise.resolve();
		});
		await wifiRescan(0);
		expect(spawns).toBe(1);

		// When: a later caller asks again.
		await wifiRescan(0);

		// Then: the guard released — it coalesces, it never suppresses.
		expect(spawns).toBe(2);
	});

	test("a FAILING rescan neither rejects its joiners nor wedges the guard", async () => {
		// Given: a rescan whose underlying command throws.
		let spawns = 0;
		setRescanActionForTest(() => {
			spawns++;
			return Promise.reject(new Error("nmcli exploded"));
		});

		// When: two callers join that failing run and a third asks afterwards.
		const joined = [wifiRescan(0), wifiRescan(0)];
		await Promise.all(joined);
		await wifiRescan(0);

		// Then: nobody saw a rejection (a shared promise that rejects raises one
		// unhandled rejection PER joiner), and the next caller was served.
		expect(spawns).toBe(2);
	});

	test("a device-LESS rescan still coalesces, and scans every radio", async () => {
		// Given: the whole-device refresh path (a monitor restart, a hotspot
		// transaction) which names no adapter.
		const spawns: Array<string | undefined> = [];
		const gate = deferred();
		setRescanActionForTest((device) => {
			spawns.push(device);
			return gate.promise;
		});

		// When: three such callers overlap.
		const calls = [wifiRescan(), wifiRescan(), wifiRescan()];

		// Then: one spawn, and it carries no ifname — it is not scoped to a radio.
		expect(spawns).toEqual([undefined]);
		gate.resolve();
		await Promise.all(calls);
	});
});

describe("wifi scan generations", () => {
	test("a completed scan advances ONLY its own adapter's generation", async () => {
		// Given: two radios, neither of which has completed a scan.
		setRescanActionForTest(() => Promise.resolve());
		expect(getWifiScanStampForDevice(0)).toBeUndefined();
		expect(getWifiScanStampForDevice(1)).toBeUndefined();

		// When: adapter 0 completes a scan.
		await wifiRescan(0);

		// Then: adapter 0 advanced and adapter 1 said nothing — one radio's scan
		// can never confirm another's.
		expect(getWifiScanStampForDevice(0)?.generation).toBe(1);
		expect(getWifiScanStampForDevice(1)).toBeUndefined();
	});

	test("the generation advances on EVERY completed scan, empty results included", async () => {
		// Given: a scan cycle whose read succeeds and finds nothing at all.
		setRescanActionForTest(() => Promise.resolve());
		setScanResultReaderForTest(() => Promise.resolve(true));

		// When: three such empty-but-successful scans run.
		await wifiRescan(0);
		await wifiRescan(0);
		await wifiRescan(0);

		// Then: each one is visible as its own completion, so an honest empty
		// result is distinguishable from a scan that never happened.
		expect(getWifiScanStampForDevice(0)?.generation).toBe(3);
	});

	test("a FAILED read does NOT advance the generation", async () => {
		// Given: one completed scan, then a read that could not answer.
		setRescanActionForTest(() => Promise.resolve());
		await wifiRescan(0);
		expect(getWifiScanStampForDevice(0)?.generation).toBe(1);

		// When: the next cycle's read fails.
		setScanResultReaderForTest(() => Promise.resolve(false));
		await wifiRescan(0);

		// Then: nothing completed, so nothing is claimed — the previous list and
		// the previous generation both stand.
		expect(getWifiScanStampForDevice(0)?.generation).toBe(1);
	});

	test("a device-LESS scan stamps every known radio", async () => {
		// Given: the whole-device refresh path.
		setRescanActionForTest(() => Promise.resolve());

		// When: it completes.
		await wifiRescan();

		// Then: it refreshed both radios, so it says so about both.
		expect(getWifiScanStampForDevice(0)?.generation).toBe(1);
		expect(getWifiScanStampForDevice(1)?.generation).toBe(1);
	});

	test("the stamp carries a timestamp beside the generation", async () => {
		// Given/When: a completed scan.
		setRescanActionForTest(() => Promise.resolve());
		const before = Date.now();
		await wifiRescan(0);

		// Then: the diagnostic stamp is real wall-clock time.
		const stamp = getWifiScanStampForDevice(0);
		expect(stamp?.at).toBeGreaterThanOrEqual(before);
		expect(stamp?.at).toBeLessThanOrEqual(Date.now());
	});
});
