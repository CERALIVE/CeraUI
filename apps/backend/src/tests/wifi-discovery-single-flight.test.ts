import {
	afterEach,
	beforeEach,
	expect,
	jest,
	mock,
	spyOn,
	test,
} from "bun:test";
import { logger } from "../helpers/logger.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import * as wifi from "../modules/wifi/wifi.ts";
import {
	addWifiInterface,
	handleWifiMonitorEvent,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	scheduleWifiUpdate,
	stopWifiUpdateLoopForTest,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

let inheritedRegistry: ReturnType<typeof isolateWifiRegistry>;

beforeEach(() => {
	inheritedRegistry = isolateWifiRegistry();
	spyOn(radioIdentityReaders, "readText").mockResolvedValue(undefined);
	spyOn(radioIdentityReaders, "realpath").mockResolvedValue(undefined);
	spyOn(radioIdentityReaders, "readPath").mockResolvedValue(undefined);
});

afterEach(() => {
	stopWifiUpdateLoopForTest();
	wifiCancelScanRefresh();
	onWifiChange(() => {});
	setWifiState({});
	jest.useRealTimers();
	mock.restore();
	restoreWifiRegistry(inheritedRegistry);
});

test("arrivals in successive runs wait for at most the active and one queued run", async () => {
	const entered = Array.from({ length: 3 }, () =>
		Promise.withResolvers<void>(),
	);
	const gates = Array.from({ length: 3 }, () =>
		Promise.withResolvers<string[]>(),
	);
	let runs = 0;
	let active = 0;
	let maxActive = 0;
	spyOn(nm, "nmDevices").mockImplementation(async () => {
		const run = runs++;
		active++;
		maxActive = Math.max(maxActive, active);
		entered[run]?.resolve();
		const result = await gates[run]?.promise;
		active--;
		return result;
	});
	const first = wifiUpdateDevices();
	await entered[0]?.promise;
	const second = wifiUpdateDevices();
	const secondJoiners = Array.from({ length: 20 }, () => wifiUpdateDevices());
	expect(runs).toBe(1);
	for (const joined of secondJoiners) expect(joined).toBe(second);
	gates[0]?.resolve([]);
	await entered[1]?.promise;
	expect(await first).toBe(false);

	const third = wifiUpdateDevices();
	const thirdJoiner = wifiUpdateDevices();
	expect(thirdJoiner).toBe(third);
	expect(third).not.toBe(second);
	gates[1]?.resolve([]);
	await entered[2]?.promise;
	expect(await second).toBe(false);
	await Promise.all(secondJoiners);
	expect(runs).toBe(3);
	expect(maxActive).toBe(1);
	gates[2]?.resolve([]);
	expect(await third).toBe(false);
	await thirdJoiner;
});

test("a rejected run releases its queued successor and the guard", async () => {
	const gate = Promise.withResolvers<string[]>();
	const failure = new Error("discovery I/O rejected");
	let runs = 0;
	spyOn(nm, "nmDevices").mockImplementation(() => {
		runs++;
		return runs === 1 ? gate.promise : Promise.resolve([]);
	});
	const first = wifiUpdateDevices();
	const firstError = first.catch((error: unknown) => error);
	const second = wifiUpdateDevices();
	gate.reject(failure);
	expect(await firstError).toBe(failure);
	expect(await second).toBe(false);
	expect(await wifiUpdateDevices()).toBe(false);
	expect(runs).toBe(3);
});

test("the production hotspot confirmation poll queues a fresh run without a discovery cycle", async () => {
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<string[]>();
	let runs = 0;
	spyOn(nm, "nmDevices").mockImplementation(() => {
		if (++runs === 1) {
			entered.resolve();
			return gate.promise;
		}
		return Promise.resolve([]);
	});
	const iface: WifiInterfaceWithHotspot = {
		id: 0,
		ifname: "wlan0",
		conn: "ap-uuid",
		hw: "radio",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: {
			conn: "ap-uuid",
			availableChannels: ["auto"],
			warnings: {},
		},
	};
	const discovery = wifiUpdateDevices();
	await entered.promise;
	const confirmation = defaultHotspotDeps.pollHotspotActive?.(iface);
	expect(runs).toBe(1);
	gate.resolve([]);
	await discovery;
	expect(await confirmation).toBe(true);
	expect(runs).toBe(2);
});

test("timer-triggered discovery logs its rejection and later timers still run", async () => {
	jest.useFakeTimers();
	const logged = Promise.withResolvers<void>();
	const error = new Error("timer discovery failure");
	const errors: unknown[] = [];
	spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args[1]);
		logged.resolve();
		return logger;
	});
	const nmDevices = spyOn(nm, "nmDevices")
		.mockRejectedValueOnce(error)
		.mockResolvedValue([]);
	scheduleWifiUpdate(3000);
	jest.advanceTimersByTime(3000);
	await logged.promise;
	expect(errors).toEqual([{ error }]);
	expect(await wifiUpdateDevices()).toBe(false);
	expect(nmDevices).toHaveBeenCalledTimes(2);
});

test("discovery awaits its real saved-connection callee without reentry", async () => {
	spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:unavailable:"]);
	const profiles = spyOn(nm, "nmConnsGet").mockResolvedValue([""]);
	spyOn(wifi, "broadcastWifiState").mockImplementation(() => {});
	await wifiUpdateDevices();
	expect(profiles).toHaveBeenCalledTimes(1);
});

test("monitor unavailable projects both internal edges without changing disconnected status", async () => {
	const mac = "58:02:05:e1:79:1c";
	const phy = "/sys/devices/radio/phy0";
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) =>
		path.endsWith("/ifindex") ? "3" : path.endsWith("/index") ? "0" : mac,
	);
	spyOn(radioIdentityReaders, "realpath").mockResolvedValue(phy);
	await wifiRadioIdentity.discover([{ ifname: "wlan0" }]);
	const iface = {
		id: 0,
		ifname: "wlan0",
		conn: null,
		hw: "radio",
		available: new Map(),
		saved: {},
		savedAll: {},
	};
	addWifiInterface(mac, iface);
	setWifiState({ [mac]: { ...iface, mode: "station" } });
	let broadcasts = 0;
	onWifiChange(() => broadcasts++);
	const before = JSON.stringify(wifi.wifiBuildMsg());
	const healthy = wifiRadioIdentity.state.rows.get("wlan0")?.incarnation;
	handleWifiMonitorEvent({
		type: "device-state",
		device: "wlan0",
		state: "unavailable",
	});
	const degraded = wifiRadioIdentity.state;
	expect(degraded.changed).toEqual(["wlan0"]);
	expect(degraded.rows.get("wlan0")?.incarnation).not.toBe(healthy);
	handleWifiMonitorEvent({
		type: "device-state",
		device: "wlan0",
		state: "unavailable",
	});
	expect(wifiRadioIdentity.state).toBe(degraded);
	await wifiRadioIdentity.discover([{ ifname: "wlan0" }]);
	expect(wifiRadioIdentity.state.changed).toEqual(["wlan0"]);
	expect(
		wifiRadioIdentity.state.rows.get("wlan0")?.degradedReason,
	).toBeUndefined();
	expect(JSON.stringify(wifi.wifiBuildMsg())).toBe(before);
	expect(broadcasts).toBe(0);
});
