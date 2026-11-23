import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as time from "../helpers/time.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import { wifiAdapterModeRestoreSource } from "../modules/wifi/wifi-adapter-mode-events.ts";
import {
	type AdapterModeTransitionDeps,
	defaultAdapterModeDeps,
	startWifiAdapterModeRestore,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import {
	getWifiInterfacesByMacAddress,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import { startHotspotLocked } from "../modules/wifi/wifi-hotspot-activation.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import * as compat from "../rpc/compat.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

import { advancePolicy as advance } from "./helpers/wifi-reconcile-fixture.ts";

const f = autoconnectFixture();
const OTHER = "dc:a6:32:aa:bb:cc";
const profile = () => {
	const value = f.profiles.get(PROFILE);
	if (!value) throw new Error("Missing fixture profile");
	return value;
};
afterEach(() => {
	resetBootReadiness();
	jest.useRealTimers();
});

test.each([false, true])(
	"round3 R6 late MAC resolution quiesces before rekey and restores, rejected=%s",
	async (rejectOnResolution) => {
		jest.useFakeTimers();
		jest.setSystemTime(10_000);
		spyOn(time, "getms").mockImplementation(() => Date.now());
		f.persistMode(MAC, "hotspot");
		const publishLocal = compat.broadcastMsgLocal;
		spyOn(compat, "broadcastMsgLocal").mockImplementation((...args) => {
			f.publications.push(profile()["connection.autoconnect"] ?? "");
			return publishLocal(...args);
		});
		f.witnesses.set("wlan0", {
			ifindex: 3,
			phy: "/sys/devices/policy/phy0",
			path: PORT,
		});
		f.witnesses.set("wlan1", {
			ifindex: 5,
			phy: "/sys/devices/policy/phy1",
			path: "usb-other-port",
		});
		f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
		let discovered = false;
		const deps: AdapterModeTransitionDeps = {
			...defaultAdapterModeDeps,
			readCapabilities: () => ({ staApCombo: { supported: false } }),
			startHotspot: async (device, publishOutcome) => {
				const found = Object.entries(getWifiInterfacesByMacAddress()).find(
					([, row]) => row.id === device,
				);
				if (!found || !canHotspot(found[1]))
					return { success: false, error: "no-device" };
				const [key, row] = found;
				const result = await startHotspotLocked(key, row, {
					...f.deps,
					publishOutcome,
				});
				settlePending(row.ifname, true);
				return result;
			},
		};
		const stopRestore = startWifiAdapterModeRestore(deps, {
			hasDiscovery: () => discovered,
			subscribe: (listener) =>
				wifiAdapterModeRestoreSource.subscribe(async () => {
					discovered = true;
					await listener();
				}),
		});
		const beforePolicy: string[][] = [];
		const write = nm.nmConnSetFields;
		let rejected = false;
		spyOn(nm, "nmConnSetFields").mockImplementation((uuid, fields) => {
			if (
				fields["connection.autoconnect"] === "no" &&
				Object.keys(fields).length === 1
			) {
				beforePolicy.push(Object.keys(getWifiInterfacesByMacAddress()));
				if (rejected) return Promise.resolve(false);
			}
			return write(uuid, fields);
		});
		try {
			await f.discover();
			await advance(0);
			const limitedKeys = Object.keys(getWifiInterfacesByMacAddress());
			expect(limitedKeys).toEqual(["limited:3:0", "limited:5:0"]);
			expect(profile()["connection.autoconnect"]).toBe("yes");
			expect(f.activations).toEqual([]);
			wifiCancelScanRefresh();
			f.publications.length = 0;
			f.witnesses.set("wlan0", {
				ifindex: 3,
				phy: "/sys/devices/policy/phy0",
				path: PORT,
				mac: MAC,
			});
			f.witnesses.set("wlan1", {
				ifindex: 5,
				phy: "/sys/devices/policy/phy1",
				path: "usb-other-port",
				mac: OTHER,
			});
			rejected = rejectOnResolution;

			await advance(250);
			if (rejectOnResolution) {
				expect(Object.keys(getWifiInterfacesByMacAddress())).toEqual(
					limitedKeys,
				);
				expect(f.publications).toEqual([]);
				expect(getBootReadiness().degraded).toBe(true);
				rejected = false;
				await advance(3000);
			}

			expect(beforePolicy[0]).toEqual(limitedKeys);
			expect(Object.keys(getWifiInterfacesByMacAddress())).toEqual([
				MAC,
				OTHER,
			]);
			expect(f.activations).toEqual([PROFILE]);
			expect(f.publications[0]).toBe("no");
			expect(getBootReadiness().degraded).toBe(false);
		} finally {
			stopRestore();
			wifiCancelScanRefresh();
		}
	},
);

test("round3 R6 persistently limited radios exhaust exactly three identity retries", async () => {
	jest.useFakeTimers();
	f.witnesses.set("wlan0", {
		ifindex: 3,
		phy: "/sys/devices/policy/phy0",
		path: PORT,
	});
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		path: "usb-other-port",
	});
	f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
	await f.discover();
	wifiCancelScanRefresh();

	for (const delay of [250, 1000, 4000]) await advance(delay);
	await advance(300_000);

	expect(f.reads.filter((path) => path.endsWith("/macaddress"))).toHaveLength(
		8,
	);
	expect(jest.getTimerCount()).toBe(0);
	expect(profile()["connection.autoconnect"]).toBe("yes");
});
