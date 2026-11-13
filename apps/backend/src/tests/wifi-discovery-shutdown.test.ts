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
	wifiCancelScanRefresh,
	wifiScheduleScanRefresh,
	wifiUpdateScanResult,
} from "../modules/wifi/wifi-connections.ts";
import {
	resetWifiInterfaceDiscoveryForTest,
	scheduleWifiUpdate,
	stopWifiUpdateLoopForTest,
	terminateWifiDiscovery,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import * as compat from "../rpc/compat.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

let registry: ReturnType<typeof isolateWifiRegistry>;
const work: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
let starts = 0;

async function advance(ms = 0): Promise<void> {
	jest.advanceTimersByTime(ms);
	for (let n = 0; n < 128; n++) await Promise.resolve();
}

function shutdown(signal: "SIGTERM" | "SIGINT") {
	const cleanup = Promise.withResolvers<void>();
	const exited = Promise.withResolvers<number>();
	releases.push(() => cleanup.resolve());
	handleTerminationSignal(signal, {
		terminateWifiObservation: () => wifiRadioObservation.terminate(),
		terminateWifiDiscovery,
		stopSrtIngest: () => cleanup.promise,
		stopDmesgWatchers: () => undefined,
		gracefulShutdown: async () => undefined,
		exit: (code) => exited.resolve(code),
	});
	return { cleanup, exited };
}

beforeEach(async () => {
	jest.useFakeTimers();
	jest.setSystemTime(0);
	registry = isolateWifiRegistry();
	wifiRadioObservation.reopenForTest();
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	resetShutdownForTest();
	resetWifiInterfaceDiscoveryForTest();
	onWifiChange(() => undefined);
	setWifiState({});
	work.length = 0;
	releases.length = 0;
	starts = 0;
	addWifiInterface("58:02:05:e1:79:1c", {
		id: 0,
		ifname: "wlan0",
		conn: null,
		hw: "Radio",
		available: new Map(),
		saved: {},
		savedAll: {},
	});
	spyOn(nm, "nmDevices").mockImplementation(async () => {
		starts++;
		return ["wlan0:wifi:unavailable:"];
	});
	spyOn(nm, "nmScanResults").mockResolvedValue([""]);
	spyOn(nm, "nmConnsGet").mockResolvedValue([""]);
	spyOn(runner, "run").mockRejectedValue(new Error("Unfaked command"));
	spyOn(compat, "broadcastMsg").mockImplementation(() => undefined);
	for (const level of ["debug", "info", "warn", "error"] as const)
		spyOn(logger, level).mockImplementation(() => logger);
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
	for (const release of releases) release();
	stopWifiUpdateLoopForTest();
	wifiCancelScanRefresh();
	for (let n = 0; n < 3; n++) await advance(1000);
	await Promise.allSettled(work);
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	resetWifiInterfaceDiscoveryForTest();
	wifiCancelScanRefresh();
	resetWifiCapabilitiesForTest();
	resetShutdownForTest();
	wifiRadioObservation.reopenForTest();
	onWifiChange(() => undefined);
	setWifiState({});
	mock.restore();
	restoreWifiRegistry(registry);
	jest.useRealTimers();
});

test.each(["SIGTERM", "SIGINT"] as const)(
	"%s settles queued discovery before held cleanup and prevents resurrection",
	async (signal) => {
		const listing = Promise.withResolvers<string[]>();
		releases.push(() => listing.resolve([]));
		spyOn(nm, "nmDevices").mockImplementation(() => {
			starts++;
			return starts === 1
				? listing.promise
				: Promise.resolve(["wlan0:wifi:unavailable:"]);
		});
		const first = wifiUpdateDevices();
		let queuedSettled = false;
		const queued = wifiUpdateDevices().then((result) => {
			queuedSettled = true;
			return result;
		});
		work.push(first, queued);
		const { cleanup, exited } = shutdown(signal);
		await advance();
		expect(queuedSettled).toBe(true);
		expect(await queued).toBeUndefined();
		listing.resolve(["wlan0:wifi:unavailable:"]);
		expect(await first).toBeUndefined();
		await advance(60_000);
		expect(starts).toBe(1);
		expect(jest.getTimerCount()).toBe(0);
		expect(await wifiUpdateDevices()).toBeUndefined();
		expect(starts).toBe(1);
		cleanup.resolve();
		expect(await exited.promise).toBe(0);
	},
);

test("termination cancels existing discovery timers and reusable cancellation cannot reopen it", async () => {
	await wifiUpdateDevices();
	const { cleanup, exited } = shutdown("SIGTERM");
	expect(jest.getTimerCount()).toBe(0);
	stopWifiUpdateLoopForTest();
	wifiCancelScanRefresh();
	scheduleWifiUpdate(1000);
	wifiScheduleScanRefresh();
	await advance(60_000);
	expect(starts).toBe(1);
	expect(jest.getTimerCount()).toBe(0);
	cleanup.resolve();
	expect(await exited.promise).toBe(0);
});

test.each([
	"saved connections",
	"saved failure",
	"saved retry",
	"scan result",
	"scan retry",
] as const)(
	"an active discovery at %s cannot re-arm timers during shutdown",
	async (boundary) => {
		const gate = Promise.withResolvers<string[] | undefined>();
		let reads = 0;
		releases.push(() => gate.resolve([""]));
		const entered = Promise.withResolvers<void>();
		if (boundary.startsWith("saved")) {
			isolateWifiRegistry();
			spyOn(nm, "nmConnsGet").mockImplementation(() => {
				reads++;
				entered.resolve();
				return gate.promise;
			});
		} else {
			spyOn(nm, "nmScanResults").mockImplementation(() => {
				reads++;
				entered.resolve();
				return gate.promise;
			});
		}
		const active =
			boundary === "scan retry" ? wifiUpdateScanResult() : wifiUpdateDevices();
		work.push(active);
		await entered.promise;
		if (boundary === "scan retry" || boundary === "saved retry") {
			gate.resolve(undefined);
			await advance();
		}
		const { cleanup, exited } = shutdown("SIGTERM");
		gate.resolve(
			boundary === "scan result" || boundary === "saved failure"
				? undefined
				: [""],
		);
		await advance();
		expect(jest.getTimerCount()).toBe(0);
		await active;
		scheduleWifiUpdate(1);
		wifiScheduleScanRefresh();
		await advance(60_000);
		expect(reads).toBe(1);
		expect(jest.getTimerCount()).toBe(0);
		expect(starts).toBe(boundary === "scan retry" ? 0 : 1);
		cleanup.resolve();
		expect(await exited.promise).toBe(0);
	},
);
