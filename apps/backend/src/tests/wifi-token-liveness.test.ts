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
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";
import * as nm from "../modules/network/network-manager.ts";
import * as relay from "../modules/remote-control/status-relay.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import {
	resetWifiCapabilitiesForTest,
	setWifiCapabilityDepsForTest,
} from "../modules/wifi/wifi-capabilities.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	handleWifiMonitorEvent,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import {
	type BaseWifiInterface,
	resetWifiInterfaceDiscoveryForTest,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import {
	RADIO_SHADOW_TIMEOUT_MS,
	wifiRadioObservation,
} from "../modules/wifi/wifi-radio-observation.ts";
import { invalidateWifiRadioRow } from "../modules/wifi/wifi-radio-publication.ts";
import * as compat from "../rpc/compat.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const mac = "58:02:05:e1:79:1c";
let inheritedRegistry: ReturnType<typeof isolateWifiRegistry>;
const releases: Array<() => void> = [];
const discoveries: Array<ReturnType<typeof wifiUpdateDevices>> = [];
const logs: unknown[][] = [];

function seed(ifname = "wlan0", id = 0): BaseWifiInterface {
	const row: BaseWifiInterface = {
		id,
		ifname,
		conn: null,
		hw: "radio",
		available: new Map(),
		saved: {},
		savedAll: {},
	};
	addWifiInterface(id === 0 ? mac : "dc:a6:32:aa:bb:cc", row);
	return row;
}

function queue(): void {
	const generation = wifiRadioIdentity.captureObservation();
	const rows = Object.values(getWifiInterfacesByMacAddress());
	for (const row of rows) invalidateWifiRadioRow(row, generation);
	wifiRadioObservation.enqueue(
		rows.map((row) => ({ ifname: row.ifname, row })),
		generation,
	);
}

async function advance(ms: number): Promise<void> {
	jest.advanceTimersByTime(ms);
	// Drain the bounded sysfs read chain and its publication continuation.
	for (let n = 0; n < 32; n++) await Promise.resolve();
}

function stallReads() {
	const read = spyOn(radioIdentityReaders, "readText").mockImplementation(
		() => {
			const pending = Promise.withResolvers<string | undefined>();
			releases.push(() => pending.resolve(undefined));
			return pending.promise;
		},
	);
	return read;
}

beforeEach(async () => {
	jest.useFakeTimers();
	jest.setSystemTime(0);
	inheritedRegistry = isolateWifiRegistry();
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	await wifiRadioIdentity.discover([]);
	releases.length = 0;
	discoveries.length = 0;
	logs.length = 0;
	resetShutdownForTest();
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) =>
		path.endsWith("/ifindex")
			? path.includes("wlan1")
				? "4"
				: "3"
			: path.endsWith("/index")
				? path.includes("phy1")
					? "1"
					: "0"
				: path.includes("phy1")
					? "dc:a6:32:aa:bb:cc"
					: mac,
	);
	spyOn(radioIdentityReaders, "realpath").mockImplementation(
		async (path) =>
			`/sys/devices/radio/phy${path.includes("wlan1") ? "1" : "0"}`,
	);
	spyOn(runner, "run").mockRejectedValue(new Error("Unfaked command"));
	spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:disconnected:"]);
	spyOn(nm, "nmConnsGet").mockResolvedValue([""]);
	spyOn(nm, "nmScanResults").mockResolvedValue([""]);
	spyOn(compat, "broadcastMsg").mockImplementation(() => undefined);
	for (const level of ["error", "warn", "info", "debug"] as const) {
		spyOn(logger, level).mockImplementation((...args: unknown[]) => {
			logs.push(args);
			return logger;
		});
	}
	resetWifiInterfaceDiscoveryForTest();
	wifiCancelScanRefresh();
	onWifiChange(() => undefined);
	setWifiState({});
	resetWifiCapabilitiesForTest();
	setWifiCapabilityDepsForTest({
		runIw: async (args) => (args[0] === "reg" ? "country 00: DFS-UNSET\n" : ""),
		readPhyName: async () => undefined,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => new Map(),
		now: () => 0,
	});
});

afterEach(async () => {
	wifiRadioObservation.stop();
	for (const release of releases) release();
	await Promise.allSettled(discoveries);
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	resetWifiInterfaceDiscoveryForTest();
	wifiCancelScanRefresh();
	resetWifiCapabilitiesForTest();
	onWifiChange(() => undefined);
	setWifiState({});
	mock.restore();
	restoreWifiRegistry(inheritedRegistry);
	resetShutdownForTest();
	jest.useRealTimers();
});

test("(a) an unavailable event for a device that is not a Wi-Fi row does not cancel the pending sample", async () => {
	await wifiUpdateDevices();
	resetWifiInterfaceDiscoveryForTest();
	wifiCancelScanRefresh();
	handleWifiMonitorEvent({
		type: "device-state",
		device: "clap-wlan0",
		state: "unavailable",
	});
	await advance(0);
	await wifiRadioObservation.settled;
	expect(wifiBuildMsg()[0]?.incarnation).toEqual(expect.any(String));
});

test("(b) a failed device listing does not strand the token", async () => {
	const row = seed();
	await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
	const token = wifiBuildMsg()[0]?.incarnation;
	expect(token).toEqual(expect.any(String));
	spyOn(nm, "nmDevices").mockResolvedValue(undefined);
	await wifiUpdateDevices();
	await advance(0);
	await wifiRadioObservation.settled;
	expect(wifiBuildMsg()[0]?.incarnation).toBe(token);
});

test("(c) a sample that is cut off is retried", async () => {
	seed();
	const pending = Promise.withResolvers<string | undefined>();
	releases.push(() => pending.resolve(undefined));
	const read = spyOn(radioIdentityReaders, "readText").mockImplementationOnce(
		() => pending.promise,
	);
	queue();
	await advance(0);
	expect(read).toHaveBeenCalledTimes(1);
	await advance(RADIO_SHADOW_TIMEOUT_MS);
	await advance(249);
	expect(wifiBuildMsg()[0]?.incarnation).toBeUndefined();
	await advance(1);
	expect(wifiBuildMsg()[0]?.incarnation).toEqual(expect.any(String));
});

test("(d) retries are bounded", async () => {
	seed();
	const read = stallReads();
	const warning = spyOn(logger, "warn");
	queue();
	await advance(0);
	for (const delay of [250, 1000, 4000]) {
		await advance(RADIO_SHADOW_TIMEOUT_MS);
		await advance(delay);
	}
	await advance(RADIO_SHADOW_TIMEOUT_MS);
	expect(read).toHaveBeenCalledTimes(4);
	expect(warning).toHaveBeenCalledTimes(4);
	expect(logs).toEqual([
		["Wi-Fi identity sample lost (timed out) for wlan0; retry 1/3"],
		["Wi-Fi identity sample lost (timed out) for wlan0; retry 2/3"],
		["Wi-Fi identity sample lost (timed out) for wlan0; retry 3/3"],
		["Wi-Fi identity sample lost (timed out) for wlan0; no retries left"],
	]);
	expect(jest.getTimerCount()).toBe(0);
});

test("(e) a client that is already connected is told", async () => {
	seed();
	const frames: unknown[] = [];
	spyOn(compat, "broadcastMsgLocal").mockImplementation((type, data) => {
		if (type === "status") frames.push(data);
		return "";
	});
	const cloud = spyOn(relay, "relayStatusToGateway").mockImplementation(
		() => undefined,
	);
	queue();
	await advance(0);
	await wifiRadioObservation.settled;
	expect(frames).toEqual([{ wifi: wifiBuildMsg() }]);
	expect(cloud).toHaveBeenCalledTimes(0);
	const row = Object.values(getWifiInterfacesByMacAddress())[0];
	if (!row) throw new Error("Missing current row");
	// A duplicate publication without invalidating its wire evidence is a no-op.
	wifiRadioObservation.enqueue(
		[{ ifname: row.ifname, row }],
		wifiRadioIdentity.state.rows.get(row.ifname)?.observation ?? 0,
	);
	await advance(0);
	await wifiRadioObservation.settled;
	expect(frames).toHaveLength(1);
	expect(cloud).toHaveBeenCalledTimes(0);
});

test("(f) an unavailable event for a real row rotates only that row", async () => {
	const first = seed();
	const second = seed("wlan1", 1);
	await wifiRadioIdentity.discover(
		[first, second].map((row) => ({ ifname: row.ifname, row })),
	);
	const before = wifiBuildMsg();
	expect(before[0]?.incarnation).toEqual(expect.any(String));
	expect(before[1]?.incarnation).toEqual(expect.any(String));
	handleWifiMonitorEvent({
		type: "device-state",
		device: "wlan0",
		state: "unavailable",
	});
	const after = wifiBuildMsg();
	expect(after[0]?.incarnation).toEqual(expect.any(String));
	expect(after[0]?.incarnation).not.toBe(before[0]?.incarnation);
	expect(after[1]?.incarnation).toBe(before[1]?.incarnation);
});

test("(e) replacing a row without changing its projected token sends no frame", async () => {
	const original = seed();
	await wifiRadioIdentity.discover([
		{ ifname: original.ifname, row: original },
	]);
	const token = wifiBuildMsg()[0]?.incarnation;
	expect(token).toEqual(expect.any(String));
	const replacement = { ...original };
	const generation = wifiRadioIdentity.captureObservation();
	invalidateWifiRadioRow(replacement, generation);
	const held = Promise.withResolvers<string | undefined>();
	releases.push(() => held.resolve(undefined));
	spyOn(radioIdentityReaders, "readText").mockImplementationOnce(
		() => held.promise,
	);
	const local = spyOn(compat, "broadcastMsgLocal").mockReturnValue("");
	const cloud = spyOn(relay, "relayStatusToGateway").mockImplementation(
		() => undefined,
	);
	wifiRadioObservation.enqueue(
		[{ ifname: replacement.ifname, row: replacement }],
		generation,
	);
	await advance(0);
	addWifiInterface(mac, replacement);
	held.resolve("3");
	await wifiRadioObservation.settled;
	expect(wifiBuildMsg()[0]?.incarnation).toBe(token);
	expect(local).toHaveBeenCalledTimes(0);
	expect(cloud).toHaveBeenCalledTimes(0);
});

test("(g) the handler resumes a suspended row when the identity update throws", async () => {
	const row = seed();
	await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
	const token = wifiBuildMsg()[0]?.incarnation;
	expect(token).toEqual(expect.any(String));
	spyOn(wifiRadioIdentity, "markUnavailable").mockImplementation(() => {
		throw new Error("Identity update failed");
	});
	handleWifiMonitorEvent({
		type: "device-state",
		device: "wlan0",
		state: "unavailable",
	});
	expect(wifiBuildMsg()[0]?.incarnation).toBe(token);
});

test("(h) the warning carries no status payload", async () => {
	const row = seed();
	addWifiInterface(mac, {
		...row,
		hotspot: {
			name: "Synthetic",
			password: "synthetic-liveness-password",
			availableChannels: ["auto"],
			warnings: {},
		},
	});
	stallReads();
	const warning = spyOn(logger, "warn");
	queue();
	await advance(0);
	await advance(RADIO_SHADOW_TIMEOUT_MS);
	expect(warning).toHaveBeenCalledTimes(1);
	expect(logs).toContainEqual([
		"Wi-Fi identity sample lost (timed out) for wlan0; retry 1/3",
	]);
	for (const args of logs) {
		expect(args.every((arg) => typeof arg === "string")).toBe(true);
		expect(JSON.stringify(args)).not.toContain("synthetic-liveness-password");
	}
});

test.each(["stop", "discovery"] as const)(
	"a pending retry is cleared by %s",
	async (action) => {
		seed();
		const read = stallReads();
		queue();
		await advance(0);
		await advance(RADIO_SHADOW_TIMEOUT_MS);
		expect(jest.getTimerCount()).toBe(1);
		if (action === "stop") {
			wifiRadioObservation.stop();
			expect(jest.getTimerCount()).toBe(0);
		} else {
			const listing = Promise.withResolvers<string[] | undefined>();
			releases.push(() => listing.resolve(undefined));
			spyOn(nm, "nmDevices").mockReturnValue(listing.promise);
			const discovery = wifiUpdateDevices();
			discoveries.push(discovery);
			expect(jest.getTimerCount()).toBe(0);
			listing.resolve(undefined);
			await discovery;
			await advance(0);
			expect(read).toHaveBeenCalledTimes(2);
			wifiRadioObservation.stop();
		}
		await advance(6000);
		expect(read).toHaveBeenCalledTimes(action === "stop" ? 1 : 2);
		expect(jest.getTimerCount()).toBe(0);
	},
);

test.each(["SIGTERM", "SIGINT"] as const)(
	"a pending retry is cleared by production %s shutdown",
	async (signal) => {
		seed();
		const read = stallReads();
		queue();
		await advance(0);
		await advance(RADIO_SHADOW_TIMEOUT_MS);
		expect(jest.getTimerCount()).toBe(1);
		const exited = Promise.withResolvers<number>();
		handleTerminationSignal(signal, {
			gracefulShutdown: async () => undefined,
			stopSrtIngest: async () => undefined,
			stopDmesgWatchers: () => undefined,
			exit: (code) => exited.resolve(code),
		});
		expect(await exited.promise).toBe(0);
		expect(jest.getTimerCount()).toBe(0);
		await advance(6000);
		expect(read).toHaveBeenCalledTimes(1);
		expect(jest.getTimerCount()).toBe(0);
	},
);
