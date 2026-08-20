/*
  Regression lock: a repeated `wifi.scan` RPC must not spawn nmcli without bound.

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
  whoever sends the RPC, and however fast, one rescan is in flight at a time.
*/

import { afterEach, describe, expect, test } from "bun:test";

import {
	setRescanActionForTest,
	setScanRefreshAction,
	wifiCancelScanRefresh,
	wifiRescan,
} from "../modules/wifi/wifi-connections.ts";

/** Resolves only when told to, so "in flight" is a state the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

afterEach(() => {
	wifiCancelScanRefresh();
});

describe("wifiRescan coalescing", () => {
	test("concurrent callers share ONE rescan", async () => {
		// Given: a rescan that has started and not yet finished.
		let spawns = 0;
		const gate = deferred();
		setRescanActionForTest(() => {
			spawns++;
			return gate.promise;
		});
		setScanRefreshAction(() => {});

		// When: five more callers ask for a rescan while it is in flight.
		const calls = [
			wifiRescan(),
			wifiRescan(),
			wifiRescan(),
			wifiRescan(),
			wifiRescan(),
		];

		// Then: exactly one spawn happened, and every caller is served by it.
		expect(spawns).toBe(1);
		gate.resolve();
		await Promise.all(calls);
		expect(spawns).toBe(1);
	});

	test("a caller AFTER the in-flight run settles gets a fresh rescan", async () => {
		// Given: one completed rescan.
		let spawns = 0;
		setRescanActionForTest(() => {
			spawns++;
			return Promise.resolve();
		});
		setScanRefreshAction(() => {});
		await wifiRescan();
		expect(spawns).toBe(1);

		// When: a later caller asks again.
		await wifiRescan();

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
		setScanRefreshAction(() => {});

		// When: two callers join that failing run and a third asks afterwards.
		const joined = [wifiRescan(), wifiRescan()];
		await Promise.all(joined);
		await wifiRescan();

		// Then: nobody saw a rejection (a shared promise that rejects raises one
		// unhandled rejection PER joiner), and the next caller was served.
		expect(spawns).toBe(2);
	});
});
