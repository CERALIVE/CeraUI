import {
	afterEach,
	beforeEach,
	expect,
	jest,
	mock,
	spyOn,
	test,
} from "bun:test";
import { statusResponseSchema } from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import * as runner from "../helpers/run.ts";
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getControlChannel,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
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
import { addClient, removeClient } from "../rpc/events.ts";
import { statusClient } from "./helpers/status-client.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const mac = "58:02:05:e1:79:1c";
let inheritedRegistry: ReturnType<typeof isolateWifiRegistry>;
const releases: Array<() => void> = [];
const discoveries: Array<ReturnType<typeof wifiUpdateDevices>> = [];
const logs: unknown[][] = [];
const clients: Array<ReturnType<typeof statusClient>> = [];
let inheritedChannel: ReturnType<typeof getControlChannel>;

function healthyText(path: string): string {
	return path.endsWith("/ifindex")
		? path.includes("wlan1")
			? "4"
			: "3"
		: path.endsWith("/index")
			? path.includes("phy1")
				? "1"
				: "0"
			: path.includes("phy1")
				? "dc:a6:32:aa:bb:cc"
				: mac;
}

function delivery() {
	const local: unknown[] = [];
	const remote: unknown[] = [];
	const client = statusClient((raw) => {
		const frame: unknown = JSON.parse(raw);
		if (typeof frame !== "object" || frame === null || !("status" in frame))
			throw new Error("Expected a status frame");
		local.push(statusResponseSchema.parse(frame.status).wifi);
	});
	clients.push(client);
	addClient(client);
	setControlChannel({
		isConnected: () => true,
		sendFrame: (frame) => {
			remote.push(frame);
		},
	});
	return { local, remote };
}

function lostWarnings(): unknown[][] {
	return logs.filter(
		([message]) =>
			typeof message === "string" &&
			message.startsWith("Wi-Fi identity sample lost"),
	);
}

function faultSamples(
	reason: "rejected" | "superseded",
	row: BaseWifiInterface,
) {
	const fault = { enabled: true };
	let competing = false;
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
		if (fault.enabled && !competing) {
			if (reason === "rejected") throw new Error("Synthetic sample rejection");
			if (path.endsWith("/ifindex")) {
				competing = true;
				try {
					await wifiRadioIdentity.discover(
						[{ ifname: row.ifname, row }],
						wifiRadioIdentity.captureObservation(),
					);
				} finally {
					competing = false;
				}
			}
		}
		return healthyText(path);
	});
	return fault;
}

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
	for (let n = 0; n < 128; n++) await Promise.resolve();
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
	clients.length = 0;
	inheritedChannel = getControlChannel();
	setControlChannel(null);
	resetShutdownForTest();
	wifiRadioObservation.reopenForTest();
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) =>
		healthyText(path),
	);
	spyOn(radioIdentityReaders, "realpath").mockImplementation(
		async (path) =>
			`/sys/devices/radio/phy${path.includes("wlan1") ? "1" : "0"}`,
	);
	spyOn(runner, "run").mockRejectedValue(new Error("Unfaked command"));
	spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:disconnected:"]);
	spyOn(nm, "nmConnsGet").mockResolvedValue([""]);
	spyOn(nm, "nmScanResults").mockResolvedValue([""]);
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
	for (const client of clients) removeClient(client);
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
	setControlChannel(inheritedChannel);
	resetShutdownForTest();
	wifiRadioObservation.reopenForTest();
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
	queue();
	await advance(0);
	for (const delay of [250, 1000, 4000]) {
		await advance(RADIO_SHADOW_TIMEOUT_MS);
		await advance(delay);
	}
	await advance(RADIO_SHADOW_TIMEOUT_MS);
	expect(read).toHaveBeenCalledTimes(4);
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
	const received = delivery();
	queue();
	await advance(0);
	await wifiRadioObservation.settled;
	expect(received.local).toEqual([wifiBuildMsg()]);
	expect(received.remote).toEqual([]);
	const row = Object.values(getWifiInterfacesByMacAddress())[0];
	if (!row) throw new Error("Missing current row");
	// A duplicate publication without invalidating its wire evidence is a no-op.
	wifiRadioObservation.enqueue(
		[{ ifname: row.ifname, row }],
		wifiRadioIdentity.state.rows.get(row.ifname)?.observation ?? 0,
	);
	await advance(0);
	await wifiRadioObservation.settled;
	expect(received.local).toEqual([wifiBuildMsg()]);
	expect(received.remote).toEqual([]);
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
	const received = delivery();
	wifiRadioObservation.enqueue(
		[{ ifname: replacement.ifname, row: replacement }],
		generation,
	);
	await advance(0);
	addWifiInterface(mac, replacement);
	held.resolve("3");
	await wifiRadioObservation.settled;
	expect(wifiBuildMsg()[0]?.incarnation).toBe(token);
	expect(received.local).toEqual([]);
	expect(received.remote).toEqual([]);
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
	queue();
	await advance(0);
	await advance(RADIO_SHADOW_TIMEOUT_MS);
	expect(logs).toEqual([
		["Wi-Fi identity sample lost (timed out) for wlan0; retry 1/3"],
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
			terminateWifiObservation: () => wifiRadioObservation.terminate(),
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

test.each(["missing read", "ifindex replacement"] as const)(
	"an incomplete %s publishes uncertainty then recovers on its first retry",
	async (kind) => {
		seed();
		if (kind === "missing read") {
			spyOn(radioIdentityReaders, "readText").mockImplementationOnce(
				async () => undefined,
			);
		} else {
			let indexes = 0;
			spyOn(radioIdentityReaders, "readText").mockImplementation(
				async (path) =>
					path.endsWith("/ifindex")
						? ++indexes === 1
							? "3"
							: "4"
						: healthyText(path),
			);
		}
		queue();
		await advance(0);
		expect(wifiRadioIdentity.state.rows.get("wlan0")).toMatchObject({
			classification: "unverified",
			lifetime: undefined,
		});
		expect(wifiBuildMsg()[0]?.incarnation).toBeUndefined();
		expect(lostWarnings()).toEqual([
			["Wi-Fi identity sample lost (incomplete) for wlan0; retry 1/3"],
		]);
		await advance(250);
		expect(wifiBuildMsg()[0]?.incarnation).toEqual(expect.any(String));
		expect(jest.getTimerCount()).toBe(0);
	},
);

test("incomplete samples exhaust exactly three retries while uncertainty stays published", async () => {
	seed();
	spyOn(radioIdentityReaders, "readText").mockResolvedValue(undefined);
	queue();
	await advance(0);
	for (const delay of [250, 1000, 4000]) await advance(delay);
	await advance(420_000);
	expect(wifiRadioIdentity.state.rows.get("wlan0")?.classification).toBe(
		"unverified",
	);
	expect(wifiBuildMsg()[0]?.incarnation).toBeUndefined();
	expect(lostWarnings()).toEqual([
		["Wi-Fi identity sample lost (incomplete) for wlan0; retry 1/3"],
		["Wi-Fi identity sample lost (incomplete) for wlan0; retry 2/3"],
		["Wi-Fi identity sample lost (incomplete) for wlan0; retry 3/3"],
		["Wi-Fi identity sample lost (incomplete) for wlan0; no retries left"],
	]);
	expect(jest.getTimerCount()).toBe(0);
});

test.each([
	"unavailable",
	"operational-mac-missing",
	"permanent-mac-unresolved",
] as const)(
	"a declared %s row does not retry incomplete evidence",
	async (reason) => {
		seed().degradedReason = reason;
		spyOn(radioIdentityReaders, "readText").mockResolvedValue(undefined);
		queue();
		await advance(0);
		await advance(420_000);
		expect(wifiBuildMsg()[0]).toMatchObject({ degraded_reason: reason });
		expect(wifiBuildMsg()[0]?.incarnation).toBeUndefined();
		expect(lostWarnings()).toEqual([]);
		expect(jest.getTimerCount()).toBe(0);
	},
);

for (const reason of ["rejected", "superseded"] as const) {
	test(`a ${reason} sample recovers without another discovery`, async () => {
		const row = seed();
		const held =
			reason === "superseded"
				? Promise.withResolvers<string | undefined>()
				: undefined;
		let fault: { enabled: boolean } | undefined;
		if (held) {
			await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
			releases.push(() => held.resolve(undefined));
			spyOn(radioIdentityReaders, "readText").mockImplementationOnce(
				() => held.promise,
			);
		} else {
			fault = faultSamples(reason, row);
		}
		queue();
		await advance(0);
		if (held) {
			wifiRadioIdentity.markUnavailable(row.ifname);
			held.resolve("3");
			await advance(0);
		}
		expect(wifiBuildMsg()[0]?.incarnation).toBeUndefined();
		expect(lostWarnings()).toEqual([
			[`Wi-Fi identity sample lost (${reason}) for wlan0; retry 1/3`],
		]);
		if (fault) fault.enabled = false;
		await advance(250);
		expect(wifiBuildMsg()[0]?.incarnation).toEqual(expect.any(String));
		expect(jest.getTimerCount()).toBe(0);
	});

	test(`${reason} samples stop after exhausting their retry budget`, async () => {
		const row = seed();
		faultSamples(reason, row);
		queue();
		await advance(0);
		for (const delay of [250, 1000, 4000]) await advance(delay);
		await advance(420_000);
		expect(wifiBuildMsg()[0]?.incarnation).toBeUndefined();
		expect(lostWarnings()).toEqual([
			[`Wi-Fi identity sample lost (${reason}) for wlan0; retry 1/3`],
			[`Wi-Fi identity sample lost (${reason}) for wlan0; retry 2/3`],
			[`Wi-Fi identity sample lost (${reason}) for wlan0; retry 3/3`],
			[`Wi-Fi identity sample lost (${reason}) for wlan0; no retries left`],
		]);
		expect(jest.getTimerCount()).toBe(0);
	});
}

test("a successful publication ends its retry cycle and leaves a full next budget", async () => {
	const row = seed();
	const fault = faultSamples("rejected", row);
	queue();
	await advance(0);
	await advance(250);
	fault.enabled = false;
	await advance(1000);
	const token = wifiBuildMsg()[0]?.incarnation;
	expect(token).toEqual(expect.any(String));
	await advance(420_000);
	expect(wifiBuildMsg()[0]?.incarnation).toBe(token);
	expect(jest.getTimerCount()).toBe(0);
	fault.enabled = true;
	queue();
	await advance(0);
	for (const delay of [250, 1000, 4000]) await advance(delay);
	expect(lostWarnings()).toEqual([
		["Wi-Fi identity sample lost (rejected) for wlan0; retry 1/3"],
		["Wi-Fi identity sample lost (rejected) for wlan0; retry 2/3"],
		["Wi-Fi identity sample lost (rejected) for wlan0; retry 1/3"],
		["Wi-Fi identity sample lost (rejected) for wlan0; retry 2/3"],
		["Wi-Fi identity sample lost (rejected) for wlan0; retry 3/3"],
		["Wi-Fi identity sample lost (rejected) for wlan0; no retries left"],
	]);
	expect(jest.getTimerCount()).toBe(0);
});

test("a new discovery resets an already-spent retry budget", async () => {
	const row = seed();
	faultSamples("rejected", row);
	spyOn(nm, "nmDevices").mockResolvedValue(undefined);
	queue();
	await advance(0);
	await advance(250);
	await wifiUpdateDevices();
	await advance(0);
	for (const delay of [250, 1000, 4000]) await advance(delay);
	expect(lostWarnings()).toEqual([
		["Wi-Fi identity sample lost (rejected) for wlan0; retry 1/3"],
		["Wi-Fi identity sample lost (rejected) for wlan0; retry 2/3"],
		["Wi-Fi identity sample lost (rejected) for wlan0; retry 1/3"],
		["Wi-Fi identity sample lost (rejected) for wlan0; retry 2/3"],
		["Wi-Fi identity sample lost (rejected) for wlan0; retry 3/3"],
		["Wi-Fi identity sample lost (rejected) for wlan0; no retries left"],
	]);
	expect(jest.getTimerCount()).toBe(0);
});

test("stop immediately after a retry fires permits no later read or publication", async () => {
	seed();
	const read = stallReads();
	queue();
	await advance(0);
	await advance(RADIO_SHADOW_TIMEOUT_MS);
	jest.advanceTimersByTime(250);
	expect(wifiRadioObservation.settled).toBeInstanceOf(Promise);
	const started = read.mock.calls.length;
	const state = wifiRadioIdentity.state;
	wifiRadioObservation.stop();
	await advance(420_000);
	expect(read).toHaveBeenCalledTimes(started);
	expect(wifiRadioIdentity.state).toBe(state);
	expect(lostWarnings()).toEqual([
		["Wi-Fi identity sample lost (timed out) for wlan0; retry 1/3"],
	]);
	expect(jest.getTimerCount()).toBe(0);
});
