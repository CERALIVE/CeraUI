/*
  Regression lock for the Network page's per-link and TOTAL bandwidth readings.

  `tp` is a raw TX byte delta over an unstated interval, so it can never be
  rendered as a rate. `tx_bps`/`rx_bps` are the measured per-second rates the
  Bonded Links card consumes.
*/

import { describe, expect, test } from "bun:test";

import {
	computeInterfaceRate,
	getNetworkInterfaces,
	netIfBuildMsg,
	processIfconfigOutput,
} from "../modules/network/network-interfaces.ts";

function ifconfigOutput(
	name: string,
	rxBytes: number,
	txBytes: number,
): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		"        inet 192.168.1.50  netmask 255.255.255.0  broadcast 192.168.1.255",
		"        ether aa:bb:cc:dd:ee:01  txqueuelen 1000  (Ethernet)",
		`        RX packets 100  bytes ${rxBytes} (1.0 KiB)`,
		"        RX errors 0  dropped 0  overruns 0  frame 0",
		`        TX packets 100  bytes ${txBytes} (1.0 KiB)`,
		"        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0",
	].join("\n");
}

function resetNetif(): void {
	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
}

describe("computeInterfaceRate", () => {
	test("converts a byte delta over an elapsed window into bits per second", () => {
		// 125_000 bytes in 1 s = 1_000_000 bits/s.
		expect(computeInterfaceRate(125_000, 0, 1000)).toBe(1_000_000);
	});

	test("scales by the ACTUAL elapsed time, not the nominal poll interval", () => {
		expect(computeInterfaceRate(125_000, 0, 5000)).toBe(200_000);
	});

	test("reports 0 with no previous sample rather than the counter total", () => {
		expect(computeInterfaceRate(999_999_999, undefined, 5000)).toBe(0);
	});

	test("reports 0 for a counter reset instead of a negative or wrapped spike", () => {
		expect(computeInterfaceRate(10, 5_000_000, 5000)).toBe(0);
	});

	test("reports 0 when no time has elapsed, never Infinity", () => {
		expect(computeInterfaceRate(5_000, 0, 0)).toBe(0);
		expect(computeInterfaceRate(5_000, 0, -1)).toBe(0);
	});
});

describe("processIfconfigOutput — measured rates on the netif wire", () => {
	test("the first sample establishes a baseline and reports no rate", () => {
		resetNetif();
		processIfconfigOutput(ifconfigOutput("eth0", 1_000, 2_000), undefined, 0);

		const entry = netIfBuildMsg().eth0;
		expect(entry).toBeDefined();
		expect(entry?.tx_bps).toBe(0);
		expect(entry?.rx_bps).toBe(0);
	});

	test("a second sample reports real, non-zero bidirectional rates", () => {
		resetNetif();
		processIfconfigOutput(ifconfigOutput("eth0", 1_000, 2_000), undefined, 0);
		processIfconfigOutput(
			ifconfigOutput("eth0", 1_000 + 250_000, 2_000 + 625_000),
			undefined,
			5_000,
		);

		const entry = netIfBuildMsg().eth0;
		// 625_000 B / 5 s = 125_000 B/s = 1_000_000 bit/s.
		expect(entry?.tx_bps).toBe(1_000_000);
		expect(entry?.rx_bps).toBe(400_000);
	});

	test("rates are reported for an interface carrying traffic while idle", () => {
		// Nothing here depends on a stream being active — the counters are the
		// kernel's, which is why the Bonded Links card can now show live values
		// before Go Live.
		resetNetif();
		processIfconfigOutput(ifconfigOutput("wlan0", 0, 0), undefined, 0);
		processIfconfigOutput(
			ifconfigOutput("wlan0", 50_000, 100_000),
			undefined,
			1_000,
		);

		const entry = netIfBuildMsg().wlan0;
		expect(entry?.tx_bps).toBeGreaterThan(0);
		expect(entry?.rx_bps).toBeGreaterThan(0);
	});

	test("an idle interface reports zero rates rather than a stale value", () => {
		resetNetif();
		processIfconfigOutput(ifconfigOutput("eth0", 0, 0), undefined, 0);
		processIfconfigOutput(
			ifconfigOutput("eth0", 500_000, 500_000),
			undefined,
			1_000,
		);
		processIfconfigOutput(
			ifconfigOutput("eth0", 500_000, 500_000),
			undefined,
			2_000,
		);

		const entry = netIfBuildMsg().eth0;
		expect(entry?.tx_bps).toBe(0);
		expect(entry?.rx_bps).toBe(0);
	});

	test("keeps emitting the legacy `tp` byte delta for existing consumers", () => {
		resetNetif();
		processIfconfigOutput(ifconfigOutput("eth0", 0, 1_000), undefined, 0);
		processIfconfigOutput(ifconfigOutput("eth0", 0, 4_000), undefined, 5_000);

		expect(netIfBuildMsg().eth0?.tp).toBe(3_000);
	});
});
