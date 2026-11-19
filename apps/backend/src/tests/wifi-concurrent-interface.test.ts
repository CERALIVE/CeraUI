/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";

import {
	concurrentApIfname,
	ensureConcurrentApInterface,
	isSupportedWifiIfname,
	releaseConcurrentApInterface,
	resetConcurrentInterfaceDepsForTest,
	setConcurrentInterfaceDepsForTest,
	wifiInterfaceReaders,
} from "../modules/wifi/wifi-concurrent-interface.ts";

afterEach(() => {
	resetConcurrentInterfaceDepsForTest();
	jest.restoreAllMocks();
});

describe("supported Wi-Fi interfaces", () => {
	test.each(["wireless", "phy80211"])(
		"accepts a non-wl radio with %s",
		(marker) => {
			spyOn(wifiInterfaceReaders, "pathExists").mockImplementation(
				(path) => path === `/sys/class/net/ath0/${marker}`,
			);
			expect(isSupportedWifiIfname("ath0")).toBe(true);
		},
	);

	test("rejects an interface without wireless markers", () => {
		spyOn(wifiInterfaceReaders, "pathExists").mockReturnValue(false);
		expect(isSupportedWifiIfname("eth0")).toBe(false);
	});

	test.each(["clap-wlan0", "clap-ath0"])(
		"excludes %s even with wireless markers",
		(ifname) => {
			const reader = spyOn(wifiInterfaceReaders, "pathExists").mockReturnValue(
				true,
			);
			expect(isSupportedWifiIfname(ifname)).toBe(false);
			expect(reader).not.toHaveBeenCalled();
		},
	);

	test.each(["wlan0", "wlp1s0", "wlx020000000001", "wlwg0"])(
		"keeps %s as a name candidate",
		(ifname) => {
			const reader = spyOn(wifiInterfaceReaders, "pathExists").mockReturnValue(
				false,
			);
			expect(isSupportedWifiIfname(ifname)).toBe(true);
			expect(reader).not.toHaveBeenCalled();
		},
	);
});

describe("concurrent AP virtual interface", () => {
	test("uses a deterministic Linux-safe interface name", () => {
		expect(concurrentApIfname("wlan0")).toBe("clap-wlan0");
		expect(
			concurrentApIfname("very-long-wireless-name").length,
		).toBeLessThanOrEqual(15);
	});

	test("removes a stale interface, recreates it as managed, and waits for NetworkManager", async () => {
		const calls: string[][] = [];
		setConcurrentInterfaceDepsForTest(
			async (_command, args) => {
				calls.push(args);
				if (args.join(" ") === "dev clap-wlan0 info") return "type AP";
				return "";
			},
			async () => true,
		);

		expect(await ensureConcurrentApInterface("wlan0")).toEqual({
			ifname: "clap-wlan0",
			created: true,
			type: "managed",
		});
		expect(calls).toEqual([
			["dev", "clap-wlan0", "info"],
			["dev", "clap-wlan0", "del"],
			["dev", "wlan0", "interface", "add", "clap-wlan0", "type", "managed"],
		]);
	});

	test("removes the virtual interface explicitly", async () => {
		const calls: string[][] = [];
		setConcurrentInterfaceDepsForTest(
			async (_command, args) => {
				calls.push(args);
				return "";
			},
			async () => true,
		);
		await releaseConcurrentApInterface("clap-wlan0");
		expect(calls).toEqual([["dev", "clap-wlan0", "del"]]);
	});
});
