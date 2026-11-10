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
import * as wifi from "../modules/wifi/wifi.ts";
import {
	refreshWifiCapabilities,
	refreshWifiLinkTelemetry,
	resetWifiCapabilitiesForTest,
	setWifiCapabilityDepsForTest,
} from "../modules/wifi/wifi-capabilities.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	handleWifiMonitorEvent,
	wifiCancelScanRefresh,
	wifiStateInit,
} from "../modules/wifi/wifi-connections.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import { resetHotspotClientsForTest } from "../modules/wifi/wifi-hotspot-clients.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	getWifiIdToMacAddress,
	resetWifiInterfaceDiscoveryForTest,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	getWifiRadioShadowFailures,
	radioIdentityReaders,
	WifiRadioIdentityProducer,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import {
	RADIO_SHADOW_TIMEOUT_MS,
	WifiRadioObservation,
	wifiRadioObservation,
} from "../modules/wifi/wifi-radio-observation.ts";
import * as compat from "../rpc/compat.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

let inheritedRegistry: ReturnType<typeof isolateWifiRegistry>;
const releases: Array<() => void> = [];
const observers: WifiRadioObservation[] = [];
const legacyCalls: Array<Promise<unknown>> = [];
const logs: Array<{ level: string; args: unknown[] }> = [];
const broadcasts: unknown[] = [];
const commands: string[] = [];

function startLegacy() {
	const call = wifiUpdateDevices();
	legacyCalls.push(call);
	return call;
}

function resetLegacy() {
	onWifiChange(() => undefined);
	resetWifiInterfaceDiscoveryForTest();
	wifiCancelScanRefresh();
	// The registry helper preserves entries inherited from other tests.
	restoreWifiRegistry([]);
	setWifiState({});
	resetWifiCapabilitiesForTest();
	setWifiCapabilityDepsForTest({
		runIw: async (args) =>
			args[0] === "reg"
				? "country 00: DFS-UNSET\n"
				: args[0] === "dev"
					? "Not connected.\n"
					: "",
		readPhyName: async () => undefined,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => new Map(),
		now: () => 0,
	});
	wifiStateInit({
		on: () => undefined,
		off: () => undefined,
		start: () => undefined,
		stop: () => undefined,
	});
	logs.length = 0;
	broadcasts.length = 0;
}

async function legacyReceipt() {
	const result = await startLegacy();
	await refreshWifiCapabilities(["wlan0"]);
	return {
		result,
		wifi: wifi.wifiBuildMsg(),
		ids: { ...getWifiIdToMacAddress() },
		keys: Object.keys(getWifiInterfacesByMacAddress()),
		broadcasts: structuredClone(broadcasts),
		logs: structuredClone(logs),
	};
}

beforeEach(async () => {
	jest.useFakeTimers();
	jest.setSystemTime(0);
	inheritedRegistry = isolateWifiRegistry();
	releases.length = 0;
	observers.length = 0;
	legacyCalls.length = 0;
	commands.length = 0;
	spyOn(radioIdentityReaders, "readText").mockResolvedValue(undefined);
	spyOn(radioIdentityReaders, "realpath").mockResolvedValue(undefined);
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	await wifiRadioIdentity.discover([]);
	spyOn(runner, "run").mockImplementation(async (bin, args) => {
		commands.push(`${bin} ${args.join(" ")}`);
		throw new Error("Unfaked scheduling command");
	});
	spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:unavailable:"]);
	spyOn(nm, "nmConnsGet").mockResolvedValue([""]);
	spyOn(nm, "nmScanResults").mockResolvedValue([""]);
	spyOn(compat, "broadcastMsg").mockImplementation((type, payload) => {
		if (type === "status") broadcasts.push(structuredClone(payload));
	});
	for (const level of ["error", "warn", "info", "debug"] as const) {
		spyOn(logger, level).mockImplementation((...args: unknown[]) => {
			logs.push({ level, args: structuredClone(args) });
			return logger;
		});
	}
	resetLegacy();
});

afterEach(async () => {
	wifiRadioObservation.stop();
	for (const observer of observers) observer.stop();
	for (const release of releases) release();
	await Promise.allSettled(legacyCalls);
	await refreshWifiCapabilities(["wlan0"]);
	await refreshWifiLinkTelemetry([]);
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	await Promise.all(observers.map((observer) => observer.settled));
	resetWifiInterfaceDiscoveryForTest();
	wifiCancelScanRefresh();
	resetHotspotClientsForTest();
	resetWifiCapabilitiesForTest();
	onWifiChange(() => undefined);
	setWifiState({});
	const observedCommands = [...commands];
	mock.restore();
	restoreWifiRegistry(inheritedRegistry);
	jest.useRealTimers();
	expect(observedCommands).toEqual([]);
});

test.each(["hang", "slow", "throw"] as const)(
	"a %s sysfs reader cannot delay or change legacy results, broadcasts or logs",
	async (mode) => {
		const disabled = spyOn(wifiRadioObservation, "enqueue").mockImplementation(
			() => undefined,
		);
		const expected = await legacyReceipt();
		disabled.mockRestore();
		resetLegacy();
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<string | undefined>();
		releases.push(() => gate.resolve("3"));
		const read = spyOn(radioIdentityReaders, "readText").mockImplementation(
			async () => {
				entered.resolve();
				if (mode === "throw") throw new Error("shadow reader rejected");
				return gate.promise;
			},
		);
		const failures = getWifiRadioShadowFailures();
		const receipt = legacyReceipt();
		const first = await Promise.race([
			receipt.then(() => "legacy"),
			entered.promise.then(() => "shadow"),
		]);
		expect(first).toBe("legacy");
		const actual = await receipt;
		expect(actual).toEqual(expected);
		expect(read).toHaveBeenCalledTimes(0);
		jest.advanceTimersByTime(0);
		await entered.promise;
		if (mode === "slow") {
			jest.advanceTimersByTime(RADIO_SHADOW_TIMEOUT_MS / 2);
			gate.resolve("3");
			await wifiRadioObservation.settled;
		} else if (mode === "throw") {
			await wifiRadioObservation.settled;
		} else {
			jest.advanceTimersByTime(RADIO_SHADOW_TIMEOUT_MS);
		}
		expect(broadcasts).toEqual(expected.broadcasts);
		expect(logs).toEqual(expected.logs);
		expect(getWifiRadioShadowFailures() - failures).toBe(
			mode === "slow" ? 0 : 1,
		);
		if (mode === "hang") {
			const another = startLegacy();
			expect(await another).toBe(true);
			jest.advanceTimersByTime(0);
			expect(read).toHaveBeenCalledTimes(1);
			wifiRadioObservation.stop();
			gate.resolve("3");
			await wifiRadioObservation.settled;
			expect(read).toHaveBeenCalledTimes(1);
		}
	},
);

test.each(["captureObservation", "enqueue"] as const)(
	"a synchronous %s failure is isolated at discovery's integration boundary",
	async (method) => {
		const disabled = spyOn(wifiRadioObservation, "enqueue").mockImplementation(
			() => undefined,
		);
		const expected = await legacyReceipt();
		disabled.mockRestore();
		resetLegacy();
		const failures = getWifiRadioShadowFailures();
		if (method === "captureObservation")
			spyOn(wifiRadioIdentity, method).mockImplementation(() => {
				throw new Error("capture failed");
			});
		else
			spyOn(wifiRadioObservation, method).mockImplementation(() => {
				throw new Error("enqueue failed");
			});
		expect(await legacyReceipt()).toEqual(expected);
		expect(getWifiRadioShadowFailures() - failures).toBe(1);
	},
);

test("a monitor shadow exception cannot prevent legacy disconnect and broadcast", () => {
	const mac = "58:02:05:e1:79:1c";
	const iface = {
		id: 0,
		ifname: "wlan0",
		conn: "active",
		hw: "radio",
		available: new Map(),
		saved: {},
		savedAll: {},
	};
	addWifiInterface(mac, iface);
	setWifiState({ [mac]: { ...iface, mode: "station" } });
	broadcasts.length = 0;
	logs.length = 0;
	const failures = getWifiRadioShadowFailures();
	let broadcastsAtShadow = 0;
	spyOn(wifiRadioIdentity, "markUnavailable").mockImplementation(() => {
		broadcastsAtShadow = broadcasts.length;
		throw new Error("monitor shadow failed");
	});
	expect(() =>
		handleWifiMonitorEvent({
			type: "device-state",
			device: "wlan0",
			state: "unavailable",
		}),
	).not.toThrow();
	expect(iface.conn).toBeNull();
	expect(broadcastsAtShadow).toBe(1);
	expect(broadcasts).toHaveLength(1);
	expect(logs).toEqual([]);
	expect(getWifiRadioShadowFailures() - failures).toBe(1);
});

test("shadow observations have one active I/O and one latest queued batch", async () => {
	const first = Promise.withResolvers<string | undefined>();
	const last = Promise.withResolvers<string | undefined>();
	const enteredFirst = Promise.withResolvers<void>();
	const enteredLast = Promise.withResolvers<void>();
	releases.push(
		() => first.resolve(undefined),
		() => last.resolve(undefined),
	);
	const names: string[] = [];
	let active = 0;
	let maxActive = 0;
	const producer = new WifiRadioIdentityProducer({
		readText: async (path) => {
			const name = path.split("/").at(-2) ?? "";
			names.push(name);
			active++;
			maxActive = Math.max(maxActive, active);
			try {
				if (name === "first") {
					enteredFirst.resolve();
					return await first.promise;
				}
				enteredLast.resolve();
				return await last.promise;
			} finally {
				active--;
			}
		},
		realpath: async () => undefined,
	});
	const observer = new WifiRadioObservation(producer);
	observers.push(observer);
	observer.enqueue([{ ifname: "first" }], producer.captureObservation());
	jest.advanceTimersByTime(0);
	await enteredFirst.promise;
	for (let n = 0; n < 20; n++)
		observer.enqueue(
			[{ ifname: n === 19 ? "last" : "discarded" }],
			producer.captureObservation(),
		);
	expect(names).toEqual(["first"]);
	first.resolve(undefined);
	await observer.settled;
	jest.advanceTimersByTime(0);
	await enteredLast.promise;
	expect(names).toEqual(["first", "last"]);
	expect(maxActive).toBe(1);
	last.resolve(undefined);
	await observer.settled;
	expect(names).toEqual(["first", "last"]);
});

test("shadow rejection releases its queued batch without propagating", async () => {
	const gate = Promise.withResolvers<string | undefined>();
	const entered = Promise.withResolvers<void>();
	releases.push(() => gate.resolve(undefined));
	let reads = 0;
	const producer = new WifiRadioIdentityProducer({
		readText: async () => {
			if (++reads === 1) {
				entered.resolve();
				return gate.promise;
			}
			return undefined;
		},
		realpath: async () => undefined,
	});
	const observer = new WifiRadioObservation(producer);
	observers.push(observer);
	const failures = getWifiRadioShadowFailures();
	observer.enqueue([{ ifname: "first" }], producer.captureObservation());
	jest.advanceTimersByTime(0);
	await entered.promise;
	observer.enqueue([{ ifname: "next" }], producer.captureObservation());
	gate.reject(new Error("shadow rejected"));
	await observer.settled;
	jest.advanceTimersByTime(0);
	await observer.settled;
	expect(reads).toBe(2);
	expect(getWifiRadioShadowFailures() - failures).toBe(1);
});

test("the production confirmation poll keeps its independent main read", async () => {
	const gate = Promise.withResolvers<string[]>();
	releases.push(() => gate.resolve([]));
	let reads = 0;
	spyOn(nm, "nmDevices").mockImplementation(() =>
		++reads === 1 ? gate.promise : Promise.resolve([]),
	);
	const iface: WifiInterfaceWithHotspot = {
		id: 0,
		ifname: "wlan0",
		conn: "ap",
		hw: "radio",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: { conn: "ap", availableChannels: ["auto"], warnings: {} },
	};
	const discovery = startLegacy();
	const confirmation = defaultHotspotDeps.pollHotspotActive?.(iface);
	expect(reads).toBe(2);
	expect(await confirmation).toBe(true);
	gate.resolve([]);
	expect(await discovery).toBe(false);
});

test("overlapping legacy failures preserve each original error object", async () => {
	const first = new Error("first legacy failure");
	const second = new Error("second legacy failure");
	spyOn(nm, "nmDevices")
		.mockRejectedValueOnce(first)
		.mockRejectedValueOnce(second);
	const firstResult = startLegacy().catch((error: unknown) => error);
	const secondResult = startLegacy().catch((error: unknown) => error);
	expect(await firstResult).toBe(first);
	expect(await secondResult).toBe(second);
});

test("the real saved-connection callee completes with all capabilities faked", async () => {
	const profiles = spyOn(nm, "nmConnsGet").mockResolvedValue([""]);
	await startLegacy();
	expect(profiles).toHaveBeenCalledTimes(1);
});

test("unavailable and recovery stay internal on an already disconnected row", async () => {
	const mac = "58:02:05:e1:79:1c";
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) =>
		path.endsWith("/ifindex") ? "3" : path.endsWith("/index") ? "0" : mac,
	);
	spyOn(radioIdentityReaders, "realpath").mockResolvedValue(
		"/sys/devices/radio/phy0",
	);
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
	broadcasts.length = 0;
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
	expect(broadcasts).toHaveLength(0);
});
