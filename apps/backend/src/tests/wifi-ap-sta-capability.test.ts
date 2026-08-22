/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { afterEach, describe, expect, test } from "bun:test";
import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import {
	parseApStaConcurrencySupport,
	resetApStaCapabilityStateForTest,
	setApStaCapabilityRunnerForTest,
	supportsApStaConcurrency,
} from "../modules/wifi/wifi-ap-sta-capability.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";

afterEach(resetApStaCapabilityStateForTest);

describe("AP+STA valid interface combinations", () => {
	test("accepts separate managed and AP limits across wrapped lines", () => {
		expect(
			parseApStaConcurrencySupport(`
valid interface combinations:
 * #{ managed } <= 1, #{ AP } <= 1,
   total <= 2, #channels <= 1, STA/AP BI must match
`),
		).toBe(true);
	});

	test("accepts MT7925 grouped alternatives only when one alternative has AP", () => {
		expect(
			parseApStaConcurrencySupport(`
valid interface combinations:
 * #{ managed, P2P-client } <= 2, #{ P2P-GO } <= 1,
   #{ P2P-device } <= 1, total <= 3, #channels <= 2
 * #{ managed, P2P-client } <= 2, #{ AP } <= 1,
   #{ P2P-device } <= 1, total <= 3, #channels <= 1
`),
		).toBe(true);
	});

	test("rejects a shared group whose limit cannot hold managed plus AP", () => {
		expect(
			parseApStaConcurrencySupport(`
valid interface combinations:
 * #{ managed, AP, monitor } <= 1, total <= 2, #channels <= 1
`),
		).toBe(false);
	});

	test("rejects missing, malformed, and independently insufficient sections", () => {
		const fixtures = [
			"Supported interface modes:\n * managed\n * AP",
			"interface combinations are not supported",
			"valid interface combinations:\n * #{ managed } <= 1, total <= 1, #channels <= 1",
			"valid interface combinations:\n * #{ AP } <= 1, total <= 2, #channels <= 1",
		];
		for (const fixture of fixtures) {
			expect(parseApStaConcurrencySupport(fixture)).toBe(false);
		}
	});

	test("supports newer radio-specific combination headings", () => {
		expect(
			parseApStaConcurrencySupport(`
Supported wiphy radios:
 * Idx 0:
   Radio's valid interface combinations:
   * #{ managed, AP, mesh point } <= 2,
     total <= 2, #channels <= 1,
     radar detect widths: { 20 MHz, 40 MHz }
`),
		).toBe(true);
	});
});

describe("AP+STA capability probe", () => {
	test("maps interface to wiphy and caches the PHY result", async () => {
		const calls: string[][] = [];
		setApStaCapabilityRunnerForTest(async (_command, args) => {
			calls.push(args);
			if (args[0] === "dev") return "Interface wlan0\n\twiphy 2\n";
			return "valid interface combinations:\n * #{ managed } <= 1, #{ AP } <= 1, total <= 2, #channels <= 1";
		});

		expect(await supportsApStaConcurrency("wlan0")).toBe(true);
		expect(await supportsApStaConcurrency("wlan0")).toBe(true);
		expect(calls).toEqual([
			["dev", "wlan0", "info"],
			["phy", "phy2", "info"],
			["dev", "wlan0", "info"],
		]);
	});

	test("fails closed on unparseable interface data and runner errors", async () => {
		setApStaCapabilityRunnerForTest(async () => "Interface wlan0");
		expect(await supportsApStaConcurrency("wlan0")).toBe(false);

		setApStaCapabilityRunnerForTest(async () => {
			throw new Error("iw unavailable");
		});
		expect(await supportsApStaConcurrency("wlan0")).toBe(false);
	});
});

describe("AP+STA capability wire projection", () => {
	test("publishes only a proven capability and keeps concurrent station state", () => {
		const capableMac = "dc:a6:32:00:00:21";
		const legacyMac = "dc:a6:32:00:00:22";
		addWifiInterface(capableMac, {
			id: 21,
			ifname: "wlan21",
			conn: "station-uuid",
			hw: "capable",
			available: new Map(),
			saved: {},
			savedAll: {},
			supportsApStaConcurrency: true,
			concurrentHotspot: {
				ifname: "clap-wlan21",
				activeConn: "hotspot-uuid",
			},
			hotspot: {
				conn: "hotspot-uuid",
				name: "CERALIVE_TEST",
				password: "password1",
				availableChannels: ["auto"],
				warnings: {},
			},
		});
		addWifiInterface(legacyMac, {
			id: 22,
			ifname: "wlan22",
			conn: null,
			hw: "legacy",
			available: new Map(),
			saved: {},
			savedAll: {},
		});

		try {
			const message = wifiBuildMsg();
			expect(message[21]?.supports_ap_sta_concurrency).toBe(true);
			expect(message[21]?.mode).toBe("station");
			expect(message[21]?.conn).toBe("station-uuid");
			expect(message[21]?.hotspot?.name).toBe("CERALIVE_TEST");
			expect(message[22]?.supports_ap_sta_concurrency).toBeUndefined();
		} finally {
			removeWifiInterface(capableMac);
			removeWifiInterface(legacyMac);
		}
	});
});
