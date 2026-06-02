import { beforeEach, describe, expect, test } from "bun:test";

import { MockMonitorEmitter } from "../modules/network/monitor/mock-monitor.ts";
import {
	getNetworkInterfaces,
	handleNetifMonitorEvent,
	netIfBuildMsg,
	processIfconfigOutput,
} from "../modules/network/network-interfaces.ts";
import {
	onNetifChange,
	setNetifState,
} from "../modules/network/state/netif-state.ts";
import type { MonitorEvent } from "../modules/network/state-types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ETH0_UP: MonitorEvent = {
	type: "device-state",
	device: "eth0",
	state: "connected",
};

// Minimal `ifconfig` stanza the existing parser understands (RUNNING flag +
// inet + the `TX packets N  bytes N` shape with its mandatory double space).
function ifconfigEth0(txBytes: number, ip = "192.168.1.50"): string {
	return [
		"eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500",
		`        inet ${ip}  netmask 255.255.255.0  broadcast 192.168.1.255`,
		"        ether aa:bb:cc:dd:ee:ff  txqueuelen 1000  (Ethernet)",
		"        RX packets 200  bytes 20000 (20.0 KB)",
		`        TX packets 100  bytes ${txBytes} (1.0 KB)`,
	].join("\n");
}

let broadcastCount = 0;

// onNetifChange is the SOLE broadcaster (initNetworkInterfaceMonitoring wires
// broadcastNetif onto it), so counting its fires == counting `netif` broadcasts.
function resetState(): void {
	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
}

beforeEach(() => {
	resetState();
	broadcastCount = 0;
	onNetifChange(() => {
		broadcastCount++;
	});
});

describe("netif event migration", () => {
	test("a device-state up event yields one netif broadcast with eth0 enabled", async () => {
		const monitor = new MockMonitorEmitter([{ delayMs: 0, event: ETH0_UP }]);
		monitor.on("monitor-event", handleNetifMonitorEvent);
		monitor.start();
		await sleep(10);
		monitor.stop();

		expect(broadcastCount).toBe(1);
		expect(netIfBuildMsg().eth0?.enabled).toBe(true);
	});

	test("no broadcast when the same up event repeats (state unchanged)", async () => {
		const monitor = new MockMonitorEmitter([
			{ delayMs: 0, event: ETH0_UP },
			{ delayMs: 5, event: ETH0_UP },
		]);
		monitor.on("monitor-event", handleNetifMonitorEvent);
		monitor.start();
		await sleep(20);
		monitor.stop();

		// First event added eth0 (one broadcast); the identical second event
		// produced no diff, so no second broadcast fired.
		expect(broadcastCount).toBe(1);
	});

	test("throughput updates via the retained poll (TX bytes delta)", () => {
		processIfconfigOutput(ifconfigEth0(1000));
		const afterFirst = broadcastCount;
		expect(getNetworkInterfaces().eth0?.txb).toBe(1000);

		processIfconfigOutput(ifconfigEth0(5000));

		expect(netIfBuildMsg().eth0?.tp).toBe(4000);
		expect(getNetworkInterfaces().eth0?.txb).toBe(5000);
		// The poll-driven throughput change broadcast exactly once more.
		expect(broadcastCount).toBe(afterFirst + 1);
	});
});
