/*
  Who is joined to the hotspot, read from the AP interface's own station dump.

  The parser is driven against a REAL-shaped `iw dev <ifname> station dump`
  capture, and the cases that matter are the ones a looser parser gets wrong
  while still looking green:

    · `signal avg:` must not overwrite `signal:` — one line below the other, and
      a substring test picks the running average instead of the live reading.
    · the per-chain bracket list (`-47 [-50, -53] dBm`) must not be read as the
      value.
    · `rx bitrate` and `tx bitrate` are one word apart and must stay apart.
    · EMPTY output is a MEASUREMENT (an AP nobody joined), not a failure — while
      non-empty output with no `Station` line is drift and must fail loud.

  The cache half asserts the split `wifi-capabilities.ts` already draws and this
  module inherits: a SPAWN failure is a statement about the read and RETAINS the
  previous roster; a PARSE failure means the shape we knew is gone and DROPS it.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	buildHotspotClients,
	getHotspotClientsForInterface,
	HOTSPOT_CLIENTS_ROW_CAP,
	HOTSPOT_CLIENTS_TTL_MS,
	parseIwStationDump,
	refreshHotspotClients,
	resetHotspotClientsForTest,
	setHotspotClientsDepsForTest,
} from "../modules/wifi/wifi-hotspot-clients.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "wifi");
const TWO_CLIENTS = readFileSync(
	join(FIXTURES, "iw-station-dump-two-clients.txt"),
	"utf8",
);

afterEach(() => {
	resetHotspotClientsForTest();
});

describe("parseIwStationDump — the named, fail-loud parser (S2)", () => {
	test("reads every station's MAC, signal and both bitrates", () => {
		const parsed = parseIwStationDump(TWO_CLIENTS);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		expect(parsed.value).toEqual([
			{
				mac: "8c:85:90:1a:2b:3c",
				signal_dbm: -47,
				tx_bitrate_mbps: 144.4,
				rx_bitrate_mbps: 130,
			},
			{
				mac: "3c:22:fb:0e:91:7d",
				signal_dbm: -71,
				tx_bitrate_mbps: 6,
				rx_bitrate_mbps: 1,
			},
		]);
	});

	// `signal avg:` sits directly under `signal:`; a substring match reports the
	// running average as the live reading, which is wrong and looks plausible.
	test("takes `signal:` and never `signal avg:`", () => {
		const parsed = parseIwStationDump(
			"Station aa:bb:cc:dd:ee:ff (on wlan0)\n" +
				"\tsignal:  \t-42 [-45, -48] dBm\n" +
				"\tsignal avg:\t-88 [-91, -94] dBm\n",
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value[0]?.signal_dbm).toBe(-42);
	});

	test("an AP nobody has joined is a SUCCESS with zero stations", () => {
		for (const empty of ["", "   ", "\n\n"]) {
			const parsed = parseIwStationDump(empty);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.value).toEqual([]);
		}
	});

	test("non-empty output with no `Station` line is DRIFT", () => {
		const parsed = parseIwStationDump("command failed: No such device (-19)\n");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.parser).toBe("parseIwStationDump");
	});

	test("a `Station` header carrying no MAC is DRIFT, never a nameless row", () => {
		const parsed = parseIwStationDump("Station <unknown> (on wlan0)\n");
		expect(parsed.ok).toBe(false);
	});

	test("a station with no negotiated bitrate reports NO rate, never a zero", () => {
		const parsed = parseIwStationDump(
			"Station aa:bb:cc:dd:ee:ff (on wlan0)\n" +
				"\tsignal:  \t-55 dBm\n" +
				"\ttx bitrate:\t0.0 MBit/s\n",
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value[0]).toEqual({
			mac: "aa:bb:cc:dd:ee:ff",
			signal_dbm: -55,
		});
		expect(parsed.value[0]).not.toHaveProperty("tx_bitrate_mbps");
	});

	test("a MAC is lowercased so two reads of one device cannot differ by case", () => {
		const parsed = parseIwStationDump("Station AA:BB:CC:DD:EE:FF (on wlan0)\n");
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.value[0]?.mac).toBe("aa:bb:cc:dd:ee:ff");
	});
});

describe("buildHotspotClients — count is the TOTAL, rows are a window", () => {
	test("an under-cap roster reports its own length", () => {
		const built = buildHotspotClients([{ mac: "aa:bb:cc:dd:ee:01" }]);
		expect(built).toEqual({
			count: 1,
			stations: [{ mac: "aa:bb:cc:dd:ee:01" }],
		});
	});

	test("an over-cap roster caps the ROWS and keeps the true COUNT", () => {
		const many = Array.from(
			{ length: HOTSPOT_CLIENTS_ROW_CAP + 5 },
			(_, i) => ({
				mac: `aa:bb:cc:dd:ee:${i.toString(16).padStart(2, "0")}`,
			}),
		);
		const built = buildHotspotClients(many);
		expect(built.count).toBe(HOTSPOT_CLIENTS_ROW_CAP + 5);
		expect(built.stations).toHaveLength(HOTSPOT_CLIENTS_ROW_CAP);
	});

	test("a MEASURED zero is a reading, published as count 0", () => {
		expect(buildHotspotClients([])).toEqual({ count: 0, stations: [] });
	});
});

describe("the roster cache — read failures and roster lifetime", () => {
	let nowMs = 1_000_000;
	let calls: string[][];

	beforeEach(() => {
		nowMs = 1_000_000;
		calls = [];
	});

	function wire(runIw: (args: string[]) => Promise<string>) {
		setHotspotClientsDepsForTest({
			now: () => nowMs,
			runIw: (args) => {
				calls.push(args);
				return runIw(args);
			},
		});
	}

	test("asks `iw dev <ifname> station dump` for the AP's OWN interface", async () => {
		wire(async () => TWO_CLIENTS);
		await refreshHotspotClients(["wlan0"]);
		expect(calls).toEqual([["dev", "wlan0", "station", "dump"]]);
		expect(getHotspotClientsForInterface("wlan0")?.count).toBe(2);
	});

	test("an interface that was never read publishes NOTHING", () => {
		wire(async () => TWO_CLIENTS);
		expect(getHotspotClientsForInterface("wlan9")).toBeUndefined();
	});

	// A statement about the READ, not about the clients: the roster stands.
	test("a SPAWN failure RETAINS the previous roster", async () => {
		wire(async () => TWO_CLIENTS);
		await refreshHotspotClients(["wlan0"]);
		expect(getHotspotClientsForInterface("wlan0")?.count).toBe(2);

		nowMs += HOTSPOT_CLIENTS_TTL_MS;
		wire(async () => {
			throw new Error("iw: command not found");
		});
		await refreshHotspotClients(["wlan0"], { force: true });
		expect(getHotspotClientsForInterface("wlan0")?.count).toBe(2);
	});

	// The shape we knew how to read is gone, so the claim we published from it
	// can no longer be vouched for.
	test("a PARSE failure DROPS the roster rather than serving a stale claim", async () => {
		wire(async () => TWO_CLIENTS);
		await refreshHotspotClients(["wlan0"]);
		expect(getHotspotClientsForInterface("wlan0")).toBeDefined();

		nowMs += HOTSPOT_CLIENTS_TTL_MS;
		wire(async () => "totally different output shape\n");
		await refreshHotspotClients(["wlan0"], { force: true });
		expect(getHotspotClientsForInterface("wlan0")).toBeUndefined();
	});

	test("an EMPTY dump publishes an authoritative zero, not an absence", async () => {
		wire(async () => "");
		await refreshHotspotClients(["wlan0"]);
		expect(getHotspotClientsForInterface("wlan0")).toEqual({
			count: 0,
			stations: [],
		});
	});

	test("a fresh roster is served without re-reading; a stale one re-reads", async () => {
		wire(async () => TWO_CLIENTS);
		await refreshHotspotClients(["wlan0"]);
		expect(calls).toHaveLength(1);

		await refreshHotspotClients(["wlan0"]);
		expect(calls).toHaveLength(1);

		nowMs += HOTSPOT_CLIENTS_TTL_MS;
		await refreshHotspotClients(["wlan0"]);
		expect(calls).toHaveLength(2);
	});

	test("an interface that stops being an AP stops being described", async () => {
		wire(async () => TWO_CLIENTS);
		await refreshHotspotClients(["wlan0"]);
		expect(getHotspotClientsForInterface("wlan0")).toBeDefined();

		await refreshHotspotClients([]);
		expect(getHotspotClientsForInterface("wlan0")).toBeUndefined();
	});

	test("two AP interfaces are read independently", async () => {
		wire(async (args) =>
			args[1] === "wlan0"
				? TWO_CLIENTS
				: "Station aa:bb:cc:dd:ee:01 (on wlan1)\n",
		);
		await refreshHotspotClients(["wlan0", "wlan1"]);
		expect(getHotspotClientsForInterface("wlan0")?.count).toBe(2);
		expect(getHotspotClientsForInterface("wlan1")?.count).toBe(1);
	});

	test("an ifname that could never be an interface name spawns NOTHING", async () => {
		wire(async () => TWO_CLIENTS);
		await refreshHotspotClients(["wlan0; rm -rf /"]);
		expect(calls).toEqual([]);
		expect(getHotspotClientsForInterface("wlan0; rm -rf /")).toBeUndefined();
	});
});
