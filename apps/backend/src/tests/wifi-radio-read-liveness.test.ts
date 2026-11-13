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
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";
import * as nm from "../modules/network/network-manager.ts";
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
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import * as devices from "../modules/wifi/wifi-device-list.ts";
import {
	type BaseWifiInterface,
	resetWifiInterfaceDiscoveryForTest,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	resetWifiPermanentMacCache,
	setPermanentMacReaderForTest,
} from "../modules/wifi/wifi-permanent-mac.ts";
import {
	radioIdentityReaders,
	WifiRadioIdentityProducer,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const mac = "58:02:05:e1:79:1c";
let registry: ReturnType<typeof isolateWifiRegistry>;
const releases: Array<() => void> = [];
const work: Promise<unknown>[] = [];
const controllers: AbortController[] = [];
const warnings: unknown[][] = [];

function seed(): BaseWifiInterface {
	const row: BaseWifiInterface = {
		id: 0,
		ifname: "wlan0",
		conn: null,
		hw: "radio",
		available: new Map(),
		saved: {},
		savedAll: {},
	};
	addWifiInterface(mac, row);
	return row;
}

function text(path: string): string {
	return path.endsWith("/ifindex") ? "3" : path.endsWith("/index") ? "0" : mac;
}

async function advance(ms: number): Promise<void> {
	jest.advanceTimersByTime(ms);
	for (let n = 0; n < 128; n++) await Promise.resolve();
}

beforeEach(async () => {
	jest.useFakeTimers();
	jest.setSystemTime(0);
	registry = isolateWifiRegistry();
	resetShutdownForTest();
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	await wifiRadioIdentity.discover([]);
	releases.length = 0;
	work.length = 0;
	controllers.length = 0;
	warnings.length = 0;
	spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args);
		return logger;
	});
	for (const level of ["error", "debug", "info"] as const)
		spyOn(logger, level).mockImplementation(() => logger);
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) =>
		text(path),
	);
	spyOn(radioIdentityReaders, "realpath").mockResolvedValue(
		"/sys/devices/radio/phy0",
	);
	spyOn(nm, "nmDevices").mockResolvedValue(undefined);
	spyOn(devices, "wifiDeviceListGetMacAddress").mockReturnValue(mac);
	setPermanentMacReaderForTest(async () => mac);
	resetWifiPermanentMacCache();
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
	for (const controller of controllers) controller.abort();
	for (const release of releases) release();
	await Promise.allSettled(work);
	wifiRadioObservation.stop();
	await advance(0);
	resetWifiInterfaceDiscoveryForTest();
	wifiCancelScanRefresh();
	resetWifiCapabilitiesForTest();
	setPermanentMacReaderForTest(null);
	resetWifiPermanentMacCache();
	onWifiChange(() => undefined);
	setWifiState({});
	restoreWifiRegistry(registry);
	resetShutdownForTest();
	mock.restore();
	jest.useRealTimers();
});

test("fifty discoveries retain at most four physical reads and settlement resumes the latest sample", async () => {
	seed();
	const calls: string[] = [];
	let active = 0;
	let maximum = 0;
	let healthy = false;
	const physical = async (path: string, isPath: boolean) => {
		calls.push(path);
		active++;
		maximum = Math.max(maximum, active);
		try {
			if (!healthy) {
				const held = Promise.withResolvers<string | undefined>();
				releases.push(() => held.resolve(undefined));
				return await held.promise;
			}
			return isPath ? "/sys/devices/radio/phy0" : text(path);
		} finally {
			active--;
		}
	};
	spyOn(radioIdentityReaders, "readText").mockImplementation((path) =>
		physical(path, false),
	);
	spyOn(radioIdentityReaders, "realpath").mockImplementation((path) =>
		physical(path, true),
	);
	for (let n = 0; n < 50; n++) {
		await wifiUpdateDevices();
		await advance(0);
		await advance(1000);
	}
	expect(calls).toHaveLength(4);
	expect(maximum).toBe(4);
	expect(
		warnings.filter(
			([message]) =>
				typeof message === "string" &&
				message.startsWith("Wi-Fi identity reads still held"),
		),
	).toEqual([["Wi-Fi identity reads still held (4); deferring sampling"]]);
	expect(jest.getTimerCount()).toBe(0);
	healthy = true;
	const releaseFirst = releases[0];
	if (!releaseFirst) throw new Error("Missing held physical read");
	releaseFirst();
	await advance(0);
	expect(wifiBuildMsg()[0]?.incarnation).toEqual(expect.any(String));
	expect(active).toBe(3);
	const published = wifiRadioIdentity.state;
	const beforeLate = calls.length;
	for (const release of releases) release();
	await advance(0);
	expect(calls).toHaveLength(beforeLate);
	expect(wifiRadioIdentity.state).toBe(published);
	expect(active).toBe(0);
	expect(maximum).toBe(4);
	await wifiUpdateDevices();
	await advance(0);
	expect(wifiBuildMsg()[0]?.incarnation).toEqual(expect.any(String));
	expect(jest.getTimerCount()).toBe(0);
});

test.each(["ifindex", "phy80211"] as const)(
	"the physical bound is shared across producers waiting at %s",
	async (boundary) => {
		const calls: string[] = [];
		let heldStarts = 0;
		let active = 0;
		let maximum = 0;
		const physical = async (path: string, isPath: boolean) => {
			calls.push(path);
			active++;
			maximum = Math.max(maximum, active);
			try {
				if (path.endsWith(`/${boundary}`)) {
					heldStarts++;
					const held = Promise.withResolvers<string | undefined>();
					releases.push(() => held.resolve(undefined));
					return await held.promise;
				}
				return isPath ? "/sys/devices/radio/phy0" : text(path);
			} finally {
				active--;
			}
		};
		const producers = Array.from(
			{ length: 5 },
			() =>
				new WifiRadioIdentityProducer({
					readText: (path) => physical(path, false),
					realpath: (path) => physical(path, true),
				}),
		);
		for (const producer of producers) {
			const controller = new AbortController();
			controllers.push(controller);
			work.push(
				producer.discover(
					[{ ifname: "wlan0" }],
					producer.captureObservation(),
					controller.signal,
				),
			);
		}
		await advance(0);
		expect(heldStarts).toBe(4);
		expect(maximum).toBe(4);
		for (const controller of controllers) controller.abort();
		const beforeLate = calls.length;
		for (const release of releases) release();
		await Promise.all(work);
		expect(calls).toHaveLength(beforeLate);
		expect(active).toBe(0);
		expect(producers.map((producer) => [...producer.state.rows])).toEqual([
			[],
			[],
			[],
			[],
			[],
		]);
	},
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	for (const result of ["present", "absent"] as const) {
		test(`${signal} prevents a pending ${result} listing from restarting sampling during cleanup`, async () => {
			seed();
			const reads: string[] = [];
			spyOn(radioIdentityReaders, "readText").mockImplementation(
				async (path) => {
					reads.push(path);
					return text(path);
				},
			);
			const listing = Promise.withResolvers<string[] | undefined>();
			const cleanup = Promise.withResolvers<void>();
			const exited = Promise.withResolvers<number>();
			releases.push(
				() => listing.resolve(undefined),
				() => cleanup.resolve(),
			);
			work.push(exited.promise);
			spyOn(nm, "nmDevices").mockReturnValue(listing.promise);
			const discovery = wifiUpdateDevices();
			work.push(discovery);
			const before = wifiRadioIdentity.state;
			handleTerminationSignal(signal, {
				stopSrtIngest: () => cleanup.promise,
				stopDmesgWatchers: () => undefined,
				gracefulShutdown: async () => undefined,
				exit: (code) => exited.resolve(code),
			});
			listing.resolve(
				result === "present" ? ["wlan0:wifi:disconnected:"] : undefined,
			);
			await discovery;
			await advance(420_000);
			expect(reads).toEqual([]);
			expect(wifiRadioIdentity.state).toBe(before);
			expect(jest.getTimerCount()).toBe(0);
			expect(warnings).toEqual([]);
			cleanup.resolve();
			expect(await exited.promise).toBe(0);
		});
	}
}
