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
import * as runner from "../helpers/run.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import {
	resetWifiCapabilitiesForTest,
	setWifiCapabilityDepsForTest,
} from "../modules/wifi/wifi-capabilities.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import * as devices from "../modules/wifi/wifi-device-list.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	resetWifiConnectionModeCache,
	resetWifiInterfaceDiscoveryForTest,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	resetWifiPermanentMacCache,
	setPermanentMacReaderForTest,
} from "../modules/wifi/wifi-permanent-mac.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import * as compat from "../rpc/compat.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const mac = "58:02:05:e1:79:1c";
const present = ["wlan0:wifi:disconnected:"];
const listings = Array.from({ length: 101 }, () =>
	Promise.withResolvers<string[]>(),
);
const starts: number[] = [];
const work: Promise<unknown>[] = [];
let registry: ReturnType<typeof isolateWifiRegistry>;

function discover() {
	const call = wifiUpdateDevices();
	work.push(call);
	return call;
}

function listing(index: number) {
	const gate = listings[index];
	if (!gate) throw new Error(`Missing listing ${index}`);
	return gate;
}

beforeEach(async () => {
	jest.useFakeTimers();
	jest.setSystemTime(0);
	registry = isolateWifiRegistry();
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	await wifiRadioIdentity.discover([]);
	starts.length = 0;
	work.length = 0;
	for (let n = 0; n < listings.length; n++)
		listings[n] = Promise.withResolvers<string[]>();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiConnectionModeCache();
	resetWifiPermanentMacCache();
	wifiCancelScanRefresh();
	onWifiChange(() => undefined);
	setWifiState({});
	setPermanentMacReaderForTest(async () => mac);
	spyOn(devices, "wifiDeviceListGetMacAddress").mockReturnValue(mac);
	spyOn(devices, "wifiDeviceListGetInetAddress").mockReturnValue(
		"192.168.50.1",
	);
	spyOn(nm, "nmDevices").mockImplementation(() => {
		const gate = listing(starts.length);
		starts.push(Date.now());
		return gate.promise;
	});
	spyOn(nm, "nmDeviceProp").mockResolvedValue([
		"Test",
		"Radio",
		"no",
		"yes",
		"yes",
	]);
	spyOn(nm, "nmConnGetFields").mockResolvedValue(["ap"]);
	spyOn(nm, "nmConnsGet").mockResolvedValue([""]);
	spyOn(nm, "nmScanResults").mockResolvedValue([""]);
	spyOn(runner, "run").mockRejectedValue(new Error("Unfaked command"));
	spyOn(compat, "broadcastMsg").mockImplementation(() => undefined);
	for (const level of ["debug", "info", "warn", "error"] as const)
		spyOn(logger, level).mockImplementation(() => logger);
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) =>
		path.endsWith("/ifindex") ? "3" : path.endsWith("/index") ? "0" : mac,
	);
	spyOn(radioIdentityReaders, "realpath").mockResolvedValue(
		"/sys/devices/radio/phy0",
	);
	resetWifiCapabilitiesForTest();
	setWifiCapabilityDepsForTest({
		runIw: async () => "",
		readPhyName: async () => undefined,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => new Map(),
		now: () => Date.now(),
	});
});

afterEach(async () => {
	for (const gate of listings) gate.resolve([]);
	await Promise.allSettled(work);
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	resetWifiInterfaceDiscoveryForTest();
	resetWifiConnectionModeCache();
	wifiCancelScanRefresh();
	resetWifiCapabilitiesForTest();
	setPermanentMacReaderForTest(null);
	resetWifiPermanentMacCache();
	onWifiChange(() => undefined);
	setWifiState({});
	mock.restore();
	restoreWifiRegistry(registry);
	jest.useRealTimers();
});

test("(1) three overlapping discoveries publish the sequential registry with at most two reads", async () => {
	const calls = [discover(), discover(), discover()];
	for (const gate of listings) gate.resolve([...present]);
	await Promise.all(calls);
	expect(starts.length).toBeLessThanOrEqual(2);
	const overlapping = structuredClone(getWifiInterfacesByMacAddress());
	wifiRadioObservation.stop();
	restoreWifiRegistry([]);
	resetWifiInterfaceDiscoveryForTest();
	resetWifiPermanentMacCache();
	await discover();
	expect(getWifiInterfacesByMacAddress()).toEqual(overlapping);
	expect(Object.keys(overlapping)).toEqual([mac]);
});

test("(2) a mid-run caller waits for a read started after its call", async () => {
	const first = discover();
	jest.advanceTimersByTime(1);
	const calledAt = Date.now();
	let delivered = false;
	const queued = discover().then(() => {
		delivered = true;
	});
	listing(0).resolve([...present]);
	await first;
	expect(delivered).toBe(false);
	expect(starts).toEqual([0, calledAt]);
	listing(1).resolve([]);
	await queued;
	expect(delivered).toBe(true);
	expect(getWifiInterfacesByMacAddress()).toEqual({});
});

test("(3) rejection belongs to its run and queued callers recover together", async () => {
	const error = new Error("First discovery failed");
	const queuedError = new Error("Queued discovery failed");
	const first = discover().catch((caught: unknown) => caught);
	const queued = [discover(), discover()].map((call) =>
		call.catch((caught: unknown) => caught),
	);
	listing(0).reject(error);
	expect(await first).toBe(error);
	listing(1).reject(queuedError);
	for (const gate of listings.slice(2)) gate.resolve([...present]);
	const outcomes = await Promise.all(queued);
	expect(outcomes[0]).toBe(queuedError);
	expect(outcomes[1]).toBe(queuedError);
	// A settled rejected flight must not poison a later independent discovery.
	expect(await discover()).toBe(true);
	expect(Object.keys(getWifiInterfacesByMacAddress())).toEqual([mac]);
});

test("(4) the production activation confirmation waits for the queued discovery", async () => {
	const iface: WifiInterfaceWithHotspot = {
		id: 0,
		ifname: "wlan0",
		conn: null,
		hw: "Radio",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: { conn: "ap", availableChannels: ["auto"], warnings: {} },
	};
	addWifiInterface(mac, iface);
	const first = discover();
	const queued = discover();
	const confirmation = defaultHotspotDeps.pollHotspotActive?.(iface);
	if (!confirmation) throw new Error("Missing production confirmation poll");
	work.push(confirmation);
	expect(starts).toEqual([0]);
	listing(0).resolve([...present]);
	await first;
	expect(iface.activeConn).toBeNull();
	listing(1).resolve(["wlan0:wifi:connected:ap"]);
	await queued;
	expect(await confirmation).toBe(true);
	expect(iface.activeConn).toBe("ap");
	expect(starts).toEqual([0, 0]);
});

test("(5) one hundred callers finish with at most two reads and no pending timer", async () => {
	const calls = Array.from({ length: 100 }, () => discover());
	for (const gate of listings) gate.resolve([]);
	expect(await Promise.all(calls)).toEqual(Array(100).fill(false));
	expect(starts.length).toBeLessThanOrEqual(2);
	jest.advanceTimersByTime(0);
	await wifiRadioObservation.settled;
	expect(jest.getTimerCount()).toBe(0);
	expect(getWifiInterfacesByMacAddress()).toEqual({});
});
