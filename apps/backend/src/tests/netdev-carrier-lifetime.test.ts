import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as runner from "../helpers/run.ts";
import {
	netdevLifetimeFence,
	netdevPresence,
	onNetdevRetired,
} from "../modules/network/netdev-lifetime.ts";
import {
	getNetworkInterfaces,
	handleNetifMonitorEvent,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import { resetUsbNetMarkers } from "../modules/network/router-cellular-scan.ts";
import { stopWifiUpdateLoopForTest } from "../modules/wifi/wifi-interfaces.ts";
import {
	firstSightIfconfig,
	firstSightScan,
} from "./helpers/bond-first-sight-fixture.ts";

const IFNAME = "enx0c5b8f279a64";
const UP = firstSightIfconfig(IFNAME, "192.168.8.100");
const DOWN = UP.replace(",RUNNING", "");

afterEach(() => {
	stopWifiUpdateLoopForTest();
	jest.restoreAllMocks();
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
});

for (const change of [
	"none",
	"index",
	"node",
	"unreadable",
	"absent",
] as const) {
	test(`a carrier-down poll preserves only a proven lifetime: ${change}`, async () => {
		const a = fs.statSync(import.meta.dir, { bigint: true });
		const b = fs.statSync(import.meta.path, { bigint: true });
		let node: typeof a | undefined = a;
		const stat = spyOn(fs, "statSync").mockReturnValue(a);
		let index: number | undefined = 7;
		let listed: boolean | undefined = true;
		spyOn(netdevPresence, "inSysfs").mockImplementation(() => listed);
		spyOn(netdevPresence, "ifindex").mockImplementation(() => index);
		await firstSightScan(UP, {
			blocked: [],
			buses: { [IFNAME]: "usb" },
		}).settle();
		let output = UP;
		spyOn(runner, "run").mockImplementation(async (bin) =>
			bin === "ifconfig" ? output : "",
		);
		await updateNetif();
		const current = netdevLifetimeFence(IFNAME);
		expect(current()).toBe(true);
		const retired: string[] = [];
		const stop = onNetdevRetired((name) => retired.push(name));
		try {
			output = DOWN;
			await updateNetif();
			expect(getNetworkInterfaces()[IFNAME]).toBeUndefined();
			expect(current()).toBe(true);
			expect(retired).toEqual([]);

			// The same name and MAC stay in ifconfig. A new holder need not come
			// up or produce a monitor event to invalidate the old evidence.
			if (change === "index") index = 17;
			if (change === "node") node = b;
			if (change === "unreadable" || change === "absent") {
				index = undefined;
				node = undefined;
				listed = change === "absent" ? false : undefined;
			}
			stat.mockReturnValue(node);
			await updateNetif();
			expect(retired).toEqual(change === "none" ? [] : [IFNAME]);
			expect(current()).toBe(change === "none");

			// Returning to the original observed values cannot undo a retirement.
			index = 7;
			listed = true;
			stat.mockReturnValue(a);
			output = UP;
			handleNetifMonitorEvent({
				type: "device-state",
				device: IFNAME,
				state: "connected",
			});
			await updateNetif();
			expect(current()).toBe(change === "none");
		} finally {
			stop();
		}
	});
}
