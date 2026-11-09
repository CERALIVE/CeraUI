import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { logger } from "../helpers/logger.ts";
import * as mockService from "../mocks/mock-service.ts";
import { MockMonitorEmitter } from "../modules/network/monitor/mock-monitor.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import {
	broadcastWifiState,
	currentHotspotApIfnames,
	wifiBuildMsg,
} from "../modules/wifi/wifi.ts";
import * as capabilities from "../modules/wifi/wifi-capabilities.ts";
import {
	addWifiInterface,
	removeWifiInterface,
	wifiStateInit,
} from "../modules/wifi/wifi-connections.ts";
import {
	getHotspotClientsForInterface,
	pollHotspotClients,
	refreshHotspotClients,
	resetHotspotClientsForTest,
	setHotspotClientsChangeListener,
	setHotspotClientsDepsForTest,
	startHotspotClientsPoll,
	stopHotspotClientsPoll,
} from "../modules/wifi/wifi-hotspot-clients.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const STATION = "Station aa:bb:cc:dd:ee:01 (on wlan0)\n";
let nowMs: number;
let tickAtMs: number;
let dump: string;
let calls: string[][];
let changed: number;
let timerId: number;
let readerRegistry: ReturnType<typeof isolateWifiRegistry>;
const callbacks = new Map<
	number | ReturnType<typeof setInterval>,
	() => void
>();
const timers = {
	setInterval(callback: () => void, delay: number) {
		expect(delay).toBe(5_000);
		callbacks.set(++timerId, callback);
		return timerId;
	},
	clearInterval(id: number | ReturnType<typeof setInterval>) {
		callbacks.delete(id);
	},
};

beforeEach(() => {
	resetHotspotClientsForTest();
	readerRegistry = isolateWifiRegistry();
	addWifiInterface("aa:bb:cc:dd:ee:ff", makeInterface(false));
	nowMs = tickAtMs = 100_000;
	dump = "";
	calls = [];
	changed = timerId = 0;
	callbacks.clear();
	setHotspotClientsDepsForTest({
		now: () => nowMs,
		runIw: async (args) => {
			calls.push(args);
			await Promise.resolve();
			// Completion is later than the scheduled tick: an unforced poll
			// would see a 4950 ms-old cache and miss every other interval.
			nowMs += 50;
			return dump;
		},
	});
});

afterEach(() => {
	resetHotspotClientsForTest();
	restoreWifiRegistry(readerRegistry);
});

function countPublication() {
	changed++;
	broadcastWifiState();
}

function addReaderSecondAp() {
	addWifiInterface("aa:bb:cc:dd:ef:ff", {
		...makeInterface(false),
		id: 1,
		ifname: "wlan1",
	});
}

async function tick(apIfnames: string[]) {
	expect(currentHotspotApIfnames()).toEqual(apIfnames);
	nowMs = tickAtMs += 5_000;
	// Await the captured production callback, so a skipped tick cannot be
	// hidden by a test-triggered refresh.
	await Promise.all([...callbacks.values()].map((callback) => callback()));
}

function makeInterface(hybrid: boolean): WifiInterfaceWithHotspot {
	return {
		id: 0,
		ifname: "wlan0",
		conn: hybrid ? "upstream" : "hotspot",
		activeConn: hybrid ? "upstream" : "hotspot",
		activeMode: hybrid ? "infrastructure" : "ap",
		hw: "Wi-Fi adapter",
		available: new Map(),
		saved: {},
		savedAll: {},
		...(hybrid
			? {
					supportsApStaConcurrency: true,
					concurrentHotspot: { ifname: "clap-wlan0", activeConn: "hotspot" },
				}
			: {}),
		hotspot: {
			conn: "hotspot",
			name: "CERALIVE_test",
			availableChannels: ["auto"],
			warnings: {},
		},
	};
}

function hybridBroadcastHarness() {
	const registry = isolateWifiRegistry();
	const monitor = new MockMonitorEmitter();
	const iface = makeInterface(true);
	addWifiInterface("aa:bb:cc:dd:ee:ff", iface);
	const frames: unknown[] = [];
	const broadcast = spyOn(websocket, "broadcastMsg").mockImplementation(
		(type, data) => {
			frames.push({ type, data });
		},
	);
	const link = spyOn(
		capabilities,
		"refreshWifiLinkTelemetry",
	).mockResolvedValue(undefined);
	let initialized = false;
	return {
		iface,
		frames,
		init: () => {
			// Priming a reader is not a publication. Broadcast the initial roster
			// explicitly, without consuming later changes during repeated init.
			if (!initialized) {
				broadcastWifiState();
				frames.length = 0;
				initialized = true;
			}
			return wifiStateInit(monitor, timers);
		},
		dispose: () => {
			resetHotspotClientsForTest();
			monitor.reset();
			link.mockRestore();
			broadcast.mockRestore();
			restoreWifiRegistry(registry);
		},
	};
}

function stationMac(index: number): string {
	return `aa:bb:cc:dd:ee:${index.toString(16).padStart(2, "0")}`;
}

function stationDump(macs: readonly string[]): string {
	return macs.map((mac) => `Station ${mac} (on clap-wlan0)\n`).join("");
}

for (const size of [32, 33, 100]) {
	test(`cap sweep: reordering ${size} clients emits no frames and keeps the wire window bounded`, async () => {
		const h = hybridBroadcastHarness();
		const macs = Array.from({ length: size }, (_, index) => stationMac(index));
		try {
			dump = stationDump(macs);
			await refreshHotspotClients(["clap-wlan0"]);
			h.init();
			const reversed = [...macs].reverse();
			dump = stationDump(reversed);
			await tick(["clap-wlan0"]);
			const counts = [h.frames.length];
			await tick(["clap-wlan0"]);
			counts.push(h.frames.length);

			expect(counts).toEqual([0, 0]);
			// Key sorting must not sort or truncate the parser's input in place.
			expect(getHotspotClientsForInterface("clap-wlan0")).toEqual({
				count: size,
				stations: reversed.slice(0, 32).map((mac) => ({ mac })),
			});
		} finally {
			h.dispose();
		}
	});

	test(`cap sweep: replacing only client ${size} emits exactly one frame with the full wire count`, async () => {
		const h = hybridBroadcastHarness();
		const macs = Array.from({ length: size }, (_, index) => stationMac(index));
		try {
			dump = stationDump(macs);
			await refreshHotspotClients(["clap-wlan0"]);
			h.init();
			const replacement = [...macs.slice(0, -1), stationMac(200)];
			dump = stationDump(replacement);
			await tick(["clap-wlan0"]);
			const counts = [h.frames.length];
			await tick(["clap-wlan0"]);
			counts.push(h.frames.length);
			const wireClients = {
				count: size,
				stations: replacement.slice(0, 32).map((mac) => ({ mac })),
			};

			expect(counts).toEqual([1, 1]);
			expect(getHotspotClientsForInterface("clap-wlan0")).toEqual(wireClients);
			expect(h.frames[0]).toMatchObject({
				type: "status",
				data: { wifi: { "0": { hotspot: { clients: wireClients } } } },
			});
		} finally {
			h.dispose();
		}
	});
}

for (const replace of [false, true]) {
	test(`cap sweep: duplicate MAC records retain multiplicity when ${replace ? "replaced beyond the window" : "reordered"}`, async () => {
		const h = hybridBroadcastHarness();
		const unique = Array.from({ length: 32 }, (_, index) => stationMac(index));
		const macs = [...unique, stationMac(0)];
		try {
			dump = stationDump(macs);
			await refreshHotspotClients(["clap-wlan0"]);
			h.init();
			const next = replace ? [...unique, stationMac(1)] : [...macs].reverse();
			dump = stationDump(next);
			await tick(["clap-wlan0"]);
			const counts = [h.frames.length];
			await tick(["clap-wlan0"]);
			counts.push(h.frames.length);

			expect(counts).toEqual(replace ? [1, 1] : [0, 0]);
			// The existing parser counts records, including repeated MACs.
			expect(getHotspotClientsForInterface("clap-wlan0")).toEqual({
				count: 33,
				stations: next.slice(0, 32).map((mac) => ({ mac })),
			});
		} finally {
			h.dispose();
		}
	});
}

test("cap sweep: mixed-case MACs normalize before complete membership comparison", async () => {
	const h = hybridBroadcastHarness();
	const macs = Array.from({ length: 33 }, (_, index) => stationMac(index));
	try {
		dump = stationDump(macs);
		await refreshHotspotClients(["clap-wlan0"]);
		h.init();
		const mixed = macs.map((mac, index) =>
			index % 2 === 0 ? mac.toUpperCase() : mac,
		);
		dump = stationDump(mixed);
		await tick(["clap-wlan0"]);
		await tick(["clap-wlan0"]);
		expect(h.frames).toHaveLength(0);
		expect(getHotspotClientsForInterface("clap-wlan0")).toEqual({
			count: 33,
			stations: macs.slice(0, 32).map((mac) => ({ mac })),
		});

		dump = stationDump([...mixed.slice(0, 32), stationMac(200).toUpperCase()]);
		await tick(["clap-wlan0"]);
		await tick(["clap-wlan0"]);
		expect(h.frames).toHaveLength(1);
	} finally {
		h.dispose();
	}
});

test("cap sweep: telemetry beyond the wire window never changes membership", async () => {
	const h = hybridBroadcastHarness();
	const macs = Array.from({ length: 100 }, (_, index) => stationMac(index));
	try {
		dump = stationDump(macs);
		await refreshHotspotClients(["clap-wlan0"]);
		h.init();
		dump +=
			"\tsignal: -90 dBm\n\ttx bitrate: 6.0 MBit/s\n\trx bitrate: 1.0 MBit/s\n";
		await tick(["clap-wlan0"]);
		await tick(["clap-wlan0"]);

		expect(h.frames).toHaveLength(0);
		expect(getHotspotClientsForInterface("clap-wlan0")).toEqual({
			count: 100,
			stations: macs.slice(0, 32).map((mac) => ({ mac })),
		});
	} finally {
		h.dispose();
	}
});

test("cap sweep: whitespace and non-station garbage do not change valid membership", async () => {
	const h = hybridBroadcastHarness();
	const macs = Array.from({ length: 33 }, (_, index) => stationMac(index));
	try {
		dump = stationDump(macs);
		await refreshHotspotClients(["clap-wlan0"]);
		h.init();
		dump = `warning before stations\r\n${macs
			.map(
				(mac) =>
					` \tStation\t${mac}\t(on clap-wlan0)\r\n\tvendor extension\r\n`,
			)
			.join("")} \t\r\n`;
		await tick(["clap-wlan0"]);
		await tick(["clap-wlan0"]);

		expect(h.frames).toHaveLength(0);
		expect(getHotspotClientsForInterface("clap-wlan0")).toEqual({
			count: 33,
			stations: macs.slice(0, 32).map((mac) => ({ mac })),
		});
	} finally {
		h.dispose();
	}
});

test("cap sweep: unread failed zero malformed and recovered rosters stay distinct", async () => {
	const h = hybridBroadcastHarness();
	const failedRead = new Error("iw unavailable");
	let result: string | Error = failedRead;
	const zero = { count: 0, stations: [] };
	const one = { count: 1, stations: [{ mac: stationMac(0) }] };
	setHotspotClientsDepsForTest({
		now: () => nowMs,
		runIw: async () => {
			if (result instanceof Error) throw result;
			return result;
		},
	});
	try {
		h.init();
		const unread = wifiBuildMsg()["0"]?.hotspot?.clients;
		await refreshHotspotClients(["clap-wlan0"], { force: true });
		expect(unread).toBeUndefined();
		expect(h.frames).toHaveLength(0);
		const cases = [
			{ output: "", wire: zero },
			{ output: failedRead, wire: zero },
			{ output: stationDump([stationMac(0)]), wire: one },
			{ output: failedRead, wire: one },
			{
				output: `${stationDump([stationMac(0)])}Station <unknown> (on clap-wlan0)\n`,
				wire: undefined,
			},
			{ output: "garbage only\n", wire: undefined },
			{ output: "Station <unknown>\n", wire: undefined },
			{ output: " \t\r\n", wire: zero },
			{ output: "", wire: zero },
		];
		const counts = [h.frames.length];
		for (const entry of cases) {
			result = entry.output;
			await tick(["clap-wlan0"]);
			expect(wifiBuildMsg()["0"]?.hotspot?.clients).toEqual(entry.wire);
			// Drain the getter's absent-roster read before changing its outcome.
			await refreshHotspotClients(["clap-wlan0"]);
			counts.push(h.frames.length);
		}
		expect(counts).toEqual([0, 1, 1, 2, 2, 3, 3, 3, 4, 4]);
	} finally {
		h.dispose();
	}
});

function addSecondHybridInterface(
	h: ReturnType<typeof hybridBroadcastHarness>,
) {
	const other = {
		...h.iface,
		id: 1,
		ifname: "wlan1",
		concurrentHotspot: { ifname: "clap-wlan1", activeConn: "hotspot" },
	};
	addWifiInterface("aa:bb:cc:dd:ef:ff", other);
	return other;
}

// Fixed reproductions from the four independent verifier reports. The earlier
// cases below retain prune-before-completion, reset, and complete-cap coverage.
for (const primed of [true, false]) {
	test(`AP stops before its dump completes and before the removal poll: primed=${primed}`, async () => {
		const h = hybridBroadcastHarness();
		const gate = Promise.withResolvers<string>();
		let pending: Promise<void> | undefined;
		try {
			if (primed) {
				dump = STATION;
				await refreshHotspotClients(["clap-wlan0"]);
			}
			h.init();
			setHotspotClientsDepsForTest({
				now: () => nowMs,
				runIw: () => gate.promise,
			});
			pending = tick(["clap-wlan0"]);
			delete h.iface.concurrentHotspot;
			gate.resolve(`${STATION}Station aa:bb:cc:dd:ee:02\n`);
			await pending;
			const counts = [h.frames.length];
			await tick([]);
			counts.push(h.frames.length);
			await tick([]);
			counts.push(h.frames.length);
			expect(counts).toEqual(primed ? [1, 1, 1] : [0, 0, 0]);
		} finally {
			gate.resolve(STATION);
			await pending;
			h.dispose();
		}
	});
}

test("the existing structural off broadcast is not duplicated by the roster poll", async () => {
	const h = hybridBroadcastHarness();
	try {
		dump = STATION;
		await refreshHotspotClients(["clap-wlan0"]);
		h.init();
		delete h.iface.concurrentHotspot;
		broadcastWifiState();
		const counts = [h.frames.length];
		await tick([]);
		counts.push(h.frames.length);
		await tick([]);
		counts.push(h.frames.length);
		expect(counts).toEqual([1, 1, 1]);
	} finally {
		h.dispose();
	}
});

for (const completedFirst of [0, 1])
	for (const lateFirst of [false, true]) {
		test(`partial removal is quiet in either completion order: AP ${completedFirst}, late first=${lateFirst}`, async () => {
			const h = hybridBroadcastHarness();
			const other = addSecondHybridInterface(h);
			const gates = [
				Promise.withResolvers<string>(),
				Promise.withResolvers<string>(),
			];
			let pending: Promise<void> | undefined;
			try {
				dump = STATION;
				await refreshHotspotClients(["clap-wlan0", "clap-wlan1"]);
				h.init();
				setHotspotClientsDepsForTest({
					now: () => nowMs,
					runIw: (args) => {
						const gate = gates[args[1] === "clap-wlan0" ? 0 : 1];
						if (!gate) throw new Error("missing verifier gate");
						return gate.promise;
					},
				});
				pending = tick(["clap-wlan0", "clap-wlan1"]);
				const first = gates[completedFirst],
					late = gates[1 - completedFirst];
				if (!first || !late) throw new Error("missing verifier completion");
				first.resolve(`${STATION}Station aa:bb:cc:dd:ee:02\n`);
				await first.promise;
				delete (completedFirst === 0 ? other : h.iface).concurrentHotspot;
				const remaining = [completedFirst === 0 ? "clap-wlan0" : "clap-wlan1"];
				const counts: number[] = [];
				if (lateFirst) {
					late.resolve(STATION);
					await pending;
					counts.push(h.frames.length);
					await tick(remaining);
				} else {
					await tick(remaining);
					counts.push(h.frames.length);
					late.resolve(STATION);
					await pending;
				}
				counts.push(h.frames.length);
				await tick(remaining);
				counts.push(h.frames.length);
				expect(counts).toEqual([1, 1, 1]);
			} finally {
				for (const gate of gates) gate.resolve(STATION);
				await pending;
				h.dispose();
			}
		});
	}

for (const rename of [false, true]) {
	test(`a partial batch cannot notify again after an AP is ${rename ? "renamed" : "disabled"}`, async () => {
		const h = hybridBroadcastHarness();
		const other: WifiInterfaceWithHotspot = addSecondHybridInterface(h);
		const first = Promise.withResolvers<string>();
		const second = Promise.withResolvers<string>();
		const newRoster = `${STATION}Station aa:bb:cc:dd:ee:02 (on clap-wlan0)\n`;
		let pending: Promise<void> | undefined;
		try {
			dump = STATION;
			await refreshHotspotClients(["clap-wlan0", "clap-wlan1"]);
			h.init();
			setHotspotClientsDepsForTest({
				now: () => nowMs,
				runIw: (args) =>
					args[1] === "clap-wlan0"
						? first.promise
						: args[1] === "clap-wlan1"
							? second.promise
							: Promise.resolve(STATION),
			});
			pending = tick(["clap-wlan0", "clap-wlan1"]);
			first.resolve(newRoster);
			if (rename) {
				other.ifname = "wlan2";
				other.concurrentHotspot = {
					ifname: "clap-wlan2",
					activeConn: "hotspot",
				};
			} else {
				delete other.concurrentHotspot;
			}
			await tick(rename ? ["clap-wlan0", "clap-wlan2"] : ["clap-wlan0"]);
			const frameCounts = [h.frames.length];
			second.resolve(STATION);
			await pending;
			frameCounts.push(h.frames.length);

			expect(frameCounts).toEqual([1, 1]);
			expect(h.frames[0]).toMatchObject({
				type: "status",
				data: { wifi: { "0": { hotspot: { clients: { count: 2 } } } } },
			});
			if (rename) {
				expect(getHotspotClientsForInterface("clap-wlan2")?.count).toBe(1);
			} else {
				expect(h.frames[0]).not.toHaveProperty("data.wifi.1.hotspot");
			}
		} finally {
			first.resolve(newRoster);
			second.resolve(STATION);
			await pending;
			h.dispose();
		}
	});
}

test("a partial batch cannot notify a new listener after reset", async () => {
	const h = hybridBroadcastHarness();
	addSecondHybridInterface(h);
	const first = Promise.withResolvers<string>();
	const second = Promise.withResolvers<string>();
	const newRoster = `${STATION}Station aa:bb:cc:dd:ee:02 (on clap-wlan0)\n`;
	let pending: Promise<void> | undefined;
	try {
		dump = STATION;
		await refreshHotspotClients(["clap-wlan0", "clap-wlan1"]);
		setHotspotClientsDepsForTest({
			now: () => nowMs,
			runIw: (args) =>
				args[1] === "clap-wlan0" ? first.promise : second.promise,
		});
		pending = refreshHotspotClients(["clap-wlan0", "clap-wlan1"], {
			force: true,
		});
		first.resolve(newRoster);
		await refreshHotspotClients(["clap-wlan0"], { force: true });
		resetHotspotClientsForTest();
		setHotspotClientsDepsForTest({ now: () => nowMs, runIw: async () => "" });
		await pollHotspotClients(currentHotspotApIfnames);
		h.init();
		second.resolve(STATION);
		await pending;

		expect(h.frames).toHaveLength(0);
		expect(getHotspotClientsForInterface("clap-wlan0")?.count).toBe(0);
	} finally {
		first.resolve(newRoster);
		second.resolve(STATION);
		await pending;
		h.dispose();
	}
});

test("a partial batch cannot notify after repeated init, but its unannounced change reaches the next poll", async () => {
	const h = hybridBroadcastHarness();
	addSecondHybridInterface(h);
	const first = Promise.withResolvers<string>();
	const second = Promise.withResolvers<string>();
	const newRoster = `${STATION}Station aa:bb:cc:dd:ee:02 (on clap-wlan0)\n`;
	let pending: Promise<void> | undefined;
	try {
		dump = STATION;
		await refreshHotspotClients(["clap-wlan0", "clap-wlan1"]);
		h.init();
		setHotspotClientsDepsForTest({
			now: () => nowMs,
			runIw: (args) =>
				args[1] === "clap-wlan0" ? first.promise : second.promise,
		});
		pending = tick(["clap-wlan0", "clap-wlan1"]);
		first.resolve(newRoster);
		await first.promise;
		expect(getHotspotClientsForInterface("clap-wlan0")?.count).toBe(2);
		h.init();
		second.resolve(STATION);
		await pending;
		expect(h.frames).toHaveLength(0);

		setHotspotClientsDepsForTest({
			now: () => nowMs,
			runIw: async (args) => (args[1] === "clap-wlan0" ? newRoster : STATION),
		});
		await tick(["clap-wlan0", "clap-wlan1"]);
		expect(callbacks.size).toBe(1);
		expect(h.frames).toHaveLength(1);
		expect(h.frames[0]).toMatchObject({
			type: "status",
			data: { wifi: { "0": { hotspot: { clients: { count: 2 } } } } },
		});
		await tick(["clap-wlan0", "clap-wlan1"]);
		expect(h.frames).toHaveLength(1);
	} finally {
		first.resolve(newRoster);
		second.resolve(STATION);
		await pending;
		h.dispose();
	}
});

test("stopping a partial batch clears its timer and permits one valid completion", async () => {
	const h = hybridBroadcastHarness();
	addSecondHybridInterface(h);
	const first = Promise.withResolvers<string>();
	const second = Promise.withResolvers<string>();
	const newRoster = `${STATION}Station aa:bb:cc:dd:ee:02 (on clap-wlan0)\n`;
	let pending: Promise<void> | undefined;
	try {
		dump = STATION;
		await refreshHotspotClients(["clap-wlan0", "clap-wlan1"]);
		h.init();
		setHotspotClientsDepsForTest({
			now: () => nowMs,
			runIw: (args) =>
				args[1] === "clap-wlan0" ? first.promise : second.promise,
		});
		pending = tick(["clap-wlan0", "clap-wlan1"]);
		first.resolve(newRoster);
		await first.promise;
		stopHotspotClientsPoll();
		expect(callbacks.size).toBe(0);
		second.resolve(STATION);
		await pending;

		expect(h.frames).toHaveLength(1);
		expect(h.frames[0]).toMatchObject({
			type: "status",
			data: { wifi: { "0": { hotspot: { clients: { count: 2 } } } } },
		});
	} finally {
		first.resolve(newRoster);
		second.resolve(STATION);
		await pending;
		h.dispose();
	}
});

test("an obsolete Hybrid dump cannot restore a pruned roster or broadcast again", async () => {
	const h = hybridBroadcastHarness();
	const oldDump = Promise.withResolvers<string>();
	let pending: Promise<void> | undefined;
	try {
		dump = STATION;
		await refreshHotspotClients(["clap-wlan0"]);
		h.init();
		setHotspotClientsDepsForTest({
			now: () => nowMs,
			runIw: () => oldDump.promise,
		});
		pending = tick(["clap-wlan0"]);
		delete h.iface.concurrentHotspot;
		await tick([]);
		const frameCounts = [h.frames.length];
		oldDump.resolve(STATION);
		await pending;
		frameCounts.push(h.frames.length);
		await tick([]);
		frameCounts.push(h.frames.length);

		expect(frameCounts).toEqual([1, 1, 1]);
		expect(h.frames[0]).toMatchObject({
			type: "status",
			data: { wifi: { "0": {} } },
		});
		expect(h.frames[0]).not.toHaveProperty("data.wifi.0.hotspot");
	} finally {
		oldDump.resolve(STATION);
		await pending;
		h.dispose();
	}
});

for (const oldCompletesFirst of [false, true]) {
	test(`an obsolete Hybrid dump cannot replace a re-added AP's newer read (${oldCompletesFirst ? "old" : "new"} completes first)`, async () => {
		const h = hybridBroadcastHarness();
		const oldDump = Promise.withResolvers<string>();
		const newDump = Promise.withResolvers<string>();
		const newRoster = `${STATION}Station aa:bb:cc:dd:ee:02 (on clap-wlan0)\n`;
		const pending: Promise<void>[] = [];
		let reads = 0;
		try {
			dump = STATION;
			await refreshHotspotClients(["clap-wlan0"]);
			h.init();
			setHotspotClientsDepsForTest({
				now: () => nowMs,
				runIw: () => {
					reads++;
					if (reads === 1) return oldDump.promise;
					if (reads === 2) return newDump.promise;
					return Promise.resolve(newRoster);
				},
			});
			const oldTick = tick(["clap-wlan0"]);
			pending.push(oldTick);
			delete h.iface.concurrentHotspot;
			await tick([]);
			expect(h.frames).toHaveLength(1);
			h.iface.concurrentHotspot = {
				ifname: "clap-wlan0",
				activeConn: "hotspot",
			};
			const newTick = tick(["clap-wlan0"]);
			pending.push(newTick);
			expect(reads).toBe(2);

			if (oldCompletesFirst) {
				oldDump.resolve(STATION);
				await oldTick;
				expect(h.frames).toHaveLength(1);
				// Obsolete cleanup must not clear the new incarnation's flight.
				pending.push(tick(["clap-wlan0"]));
				expect(reads).toBe(2);
				newDump.resolve(newRoster);
			} else {
				newDump.resolve(newRoster);
				await newTick;
				oldDump.resolve(STATION);
			}
			await Promise.all(pending);
			expect(h.frames).toHaveLength(2);
			expect(h.frames[1]).toMatchObject({
				type: "status",
				data: { wifi: { "0": { hotspot: { clients: { count: 2 } } } } },
			});
			expect(getHotspotClientsForInterface("clap-wlan0")?.count).toBe(2);
			await tick(["clap-wlan0"]);
			expect(h.frames).toHaveLength(2);
		} finally {
			oldDump.resolve(STATION);
			newDump.resolve(newRoster);
			await Promise.all(pending);
			h.dispose();
		}
	});
}

test("an obsolete dump cannot overwrite a roster or notify after reset", async () => {
	const oldDump = Promise.withResolvers<string>();
	setHotspotClientsDepsForTest({
		now: () => nowMs,
		runIw: () => oldDump.promise,
	});
	const pending = pollHotspotClients(() => ["wlan0"]);
	try {
		resetHotspotClientsForTest();
		setHotspotClientsDepsForTest({ now: () => nowMs, runIw: async () => "" });
		setHotspotClientsChangeListener(countPublication);
		await pollHotspotClients(() => ["wlan0"]);
		oldDump.resolve(STATION);
		await pending;
		expect(getHotspotClientsForInterface("wlan0")?.count).toBe(0);
		expect(changed).toBe(1);
	} finally {
		oldDump.resolve(STATION);
		await pending;
	}
});

for (const hybrid of [false, true]) {
	test(`a ${hybrid ? "Hybrid" : "Hotspot"} join pushes one frame after repeated init, then stays quiet`, async () => {
		const registry = isolateWifiRegistry();
		const monitor = new MockMonitorEmitter();
		const iface = makeInterface(hybrid);
		const ap = hybrid ? "clap-wlan0" : "wlan0";
		addWifiInterface("aa:bb:cc:dd:ee:ff", iface);
		await refreshHotspotClients([ap]);
		broadcastWifiState();
		const frames: unknown[] = [];
		const broadcast = spyOn(websocket, "broadcastMsg").mockImplementation(
			(type, data) => {
				frames.push({ type, data });
			},
		);
		const link = spyOn(
			capabilities,
			"refreshWifiLinkTelemetry",
		).mockResolvedValue(undefined);
		try {
			wifiStateInit(monitor, timers);
			wifiStateInit(monitor, timers);
			dump = STATION;
			await tick([ap]);
			expect(frames).toHaveLength(1);
			expect(frames[0]).toMatchObject({
				type: "status",
				data: { wifi: { "0": { hotspot: { clients: { count: 1 } } } } },
			});
			await tick([ap]);
			expect(frames).toHaveLength(1);
			expect(callbacks.size).toBe(1);
			expect(calls).toEqual(
				Array.from({ length: 3 }, () => ["dev", ap, "station", "dump"]),
			);
			if (hybrid) {
				delete iface.concurrentHotspot;
				await tick([]);
				expect(currentHotspotApIfnames()).toEqual([]);
				expect(frames).toHaveLength(2);
				expect(frames[1]).toMatchObject({
					type: "status",
					data: { wifi: { "0": {} } },
				});
				expect(broadcast.mock.calls[1]?.[1]).not.toHaveProperty(
					"wifi.0.hotspot",
				);
				await tick([]);
				expect(frames).toHaveLength(2);
				expect(calls).toHaveLength(3);
			}
			stopHotspotClientsPoll();
			expect(callbacks.size).toBe(0);
		} finally {
			resetHotspotClientsForTest();
			monitor.reset();
			link.mockRestore();
			broadcast.mockRestore();
			restoreWifiRegistry(registry);
		}
	});
}

test("the five-second poll reads every tick despite spawn latency and reports joins and leaves once", async () => {
	setHotspotClientsChangeListener(countPublication);
	startHotspotClientsPoll(() => ["wlan0"], timers);
	nowMs = tickAtMs += 5_000;
	await pollHotspotClients(() => ["wlan0"]);
	expect(changed).toBe(1); // Unread -> measured zero.
	dump = STATION;
	nowMs = tickAtMs += 5_000;
	await pollHotspotClients(() => ["wlan0"]);
	expect(changed).toBe(2);
	nowMs = tickAtMs += 5_000;
	await pollHotspotClients(() => ["wlan0"]);
	expect(changed).toBe(2);
	dump = "";
	nowMs = tickAtMs += 5_000;
	await pollHotspotClients(() => ["wlan0"]);
	expect(changed).toBe(3);
	expect(calls).toHaveLength(4);
	expect(getHotspotClientsForInterface("wlan0")?.count).toBe(0);
});

test("station order, signal and rates do not notify but the refreshed telemetry is cached", async () => {
	const second = "Station aa:bb:cc:dd:ee:02 (on wlan0)\n";
	dump = `${STATION}\tsignal: -40 dBm\n${second}`;
	await pollHotspotClients(() => ["wlan0"]);
	broadcastWifiState();
	setHotspotClientsChangeListener(countPublication);
	dump = `${second}${STATION}\tsignal: -70 dBm\n\ttx bitrate: 6.0 MBit/s\n`;
	await pollHotspotClients(() => ["wlan0"]);
	expect(changed).toBe(0);
	expect(getHotspotClientsForInterface("wlan0")?.stations[1]).toEqual({
		mac: "aa:bb:cc:dd:ee:01",
		signal_dbm: -70,
		tx_bitrate_mbps: 6,
	});
	dump = `${second}Station aa:bb:cc:dd:ee:03 (on wlan0)\n`;
	await pollHotspotClients(() => ["wlan0"]);
	expect(changed).toBe(1);
	dump = second;
	await pollHotspotClients(() => ["wlan0"]);
	expect(changed).toBe(2);
});

test("membership includes the total even when the displayed station window is unchanged", async () => {
	dump = Array.from(
		{ length: 33 },
		(_, i) =>
			`Station aa:bb:cc:dd:ee:${i.toString(16).padStart(2, "0")} (on wlan0)\n`,
	).join("");
	await pollHotspotClients(() => ["wlan0"]);
	broadcastWifiState();
	setHotspotClientsChangeListener(countPublication);
	dump += "Station aa:bb:cc:dd:ee:ff (on wlan0)\n";
	await pollHotspotClients(() => ["wlan0"]);
	expect(changed).toBe(1);
	expect(getHotspotClientsForInterface("wlan0")?.count).toBe(34);
});

test("spawn failure keeps membership quiet; parse failure removes it once", async () => {
	dump = STATION;
	await pollHotspotClients(() => ["wlan0"]);
	broadcastWifiState();
	setHotspotClientsChangeListener(countPublication);
	setHotspotClientsDepsForTest({
		now: () => nowMs,
		runIw: async () => {
			throw new Error("iw unavailable");
		},
	});
	await pollHotspotClients(() => ["wlan0"]);
	expect(changed).toBe(0);
	expect(getHotspotClientsForInterface("wlan0")?.count).toBe(1);
	setHotspotClientsDepsForTest({
		now: () => nowMs,
		runIw: async () => "drift",
	});
	await pollHotspotClients(() => ["wlan0"]);
	expect(changed).toBe(1);
	expect(getHotspotClientsForInterface("wlan0")).toBeUndefined();
	await pollHotspotClients(() => ["wlan0"]);
	expect(changed).toBe(1);
});

test("concurrent refreshes stay single-flight and notify once after all AP reads", async () => {
	addReaderSecondAp();
	const read = Promise.withResolvers<string>();
	setHotspotClientsDepsForTest({
		now: () => nowMs,
		runIw: (args) => {
			calls.push(args);
			return read.promise;
		},
	});
	setHotspotClientsChangeListener(countPublication);
	const first = pollHotspotClients(() => ["wlan0", "wlan1"]);
	const second = pollHotspotClients(() => ["wlan0", "wlan1"]);
	expect(calls).toHaveLength(2);
	expect(changed).toBe(0);
	read.resolve(STATION);
	await Promise.all([first, second]);
	expect(changed).toBe(1);
});

test("pruning all APs notifies once and later empty ticks spawn nothing", async () => {
	addReaderSecondAp();
	dump = STATION;
	await pollHotspotClients(() => ["wlan0", "wlan1"]);
	broadcastWifiState();
	setHotspotClientsChangeListener(countPublication);
	removeWifiInterface("aa:bb:cc:dd:ee:ff");
	removeWifiInterface("aa:bb:cc:dd:ef:ff");
	await pollHotspotClients(() => []);
	await pollHotspotClients(() => []);
	expect(changed).toBe(1);
	expect(calls).toHaveLength(2);
});

test("a throwing listener is logged without rejecting the refresh", async () => {
	const debug = spyOn(logger, "debug").mockImplementation(() => logger);
	setHotspotClientsChangeListener(() => {
		throw new Error("sink unavailable");
	});
	try {
		await pollHotspotClients(() => ["wlan0"]);
		expect(debug).toHaveBeenCalledWith(
			"hotspot clients: change listener failed: Error: sink unavailable",
		);
	} finally {
		debug.mockRestore();
	}
});

test("restarting replaces the interval and reset stops it and clears the listener", async () => {
	const oldStop = startHotspotClientsPoll(() => ["wlan0"], timers);
	startHotspotClientsPoll(() => ["wlan0"], timers);
	oldStop();
	expect(callbacks.size).toBe(1);
	setHotspotClientsChangeListener(countPublication);
	resetHotspotClientsForTest();
	expect(callbacks.size).toBe(0);
	setHotspotClientsDepsForTest({ now: () => nowMs, runIw: async () => "" });
	await pollHotspotClients(() => ["wlan0"]);
	expect(changed).toBe(0);
});

test("mock mode starts no interval and never reads iw", async () => {
	const mocks = spyOn(mockService, "shouldUseMocks").mockReturnValue(true);
	try {
		startHotspotClientsPoll(() => ["wlan0"], timers);
		await pollHotspotClients(() => ["wlan0"]);
		expect(callbacks.size).toBe(0);
		expect(calls).toEqual([]);
	} finally {
		mocks.mockRestore();
	}
});
