import { describe, expect, test } from "bun:test";

import { MockMonitorEmitter } from "../modules/network/monitor/mock-monitor.ts";
import {
	createMonitorManager,
	type MonitorProcess,
	NmcliMonitorManager,
	parseMonitorLine,
} from "../modules/network/monitor/monitor-manager.ts";
import type { MonitorEvent } from "../modules/network/state-types.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const encoder = new TextEncoder();

/**
 * A controllable stand-in for the `nmcli monitor` child. Emits `lines` (each
 * newline-terminated) then either exits immediately or, with `hang: true`,
 * blocks until `kill()` is called — modelling a long-lived monitor.
 */
function makeFakeProc(
	lines: string[],
	opts: { hang?: boolean; chunkSplit?: boolean } = {},
): MonitorProcess {
	let resolveKilled!: () => void;
	const killed = new Promise<void>((r) => {
		resolveKilled = r;
	});
	let resolveExited!: (code: number) => void;
	const exited = new Promise<number>((r) => {
		resolveExited = r;
	});

	const stdout = (async function* () {
		for (const line of lines) {
			const text = `${line}\n`;
			if (opts.chunkSplit && text.length > 2) {
				// Split mid-line across two chunks to exercise newline buffering.
				const mid = Math.floor(text.length / 2);
				yield encoder.encode(text.slice(0, mid));
				yield encoder.encode(text.slice(mid));
			} else {
				yield encoder.encode(text);
			}
		}
		if (opts.hang) {
			await killed;
		}
		resolveExited(0);
	})();

	return {
		stdout,
		exited,
		kill() {
			resolveKilled();
			resolveExited(0);
		},
	};
}

// ─── 1. line parsing ──────────────────────────────────────────────────────────

describe("parseMonitorLine", () => {
	test("device-state: bare state", () => {
		expect(parseMonitorLine("wlan0: disconnected")).toEqual({
			type: "device-state",
			device: "wlan0",
			state: "disconnected",
		});
	});

	test("device-state: 'connected to' strips the connection name", () => {
		expect(parseMonitorLine("wlan0: connected to 'Wifi'")).toEqual({
			type: "device-state",
			device: "wlan0",
			state: "connected",
		});
		expect(parseMonitorLine('eth0: connected to "Wired connection 1"')).toEqual(
			{
				type: "device-state",
				device: "eth0",
				state: "connected",
			},
		);
	});

	test("device-state: strips the connecting (phase) parenthetical", () => {
		expect(
			parseMonitorLine("eth0: connecting (getting IP configuration)"),
		).toEqual({
			type: "device-state",
			device: "eth0",
			state: "connecting",
		});
	});

	test("connection-state: quoted connection line", () => {
		expect(
			parseMonitorLine(
				'"Wired connection 1" (ethernet, 192.168.1.100/24): connection activated',
			),
		).toEqual({
			type: "connection-state",
			connection: "Wired connection 1",
			state: "activated",
		});
		expect(
			parseMonitorLine('"gsm-operator" (gsm): connection deactivated'),
		).toEqual({
			type: "connection-state",
			connection: "gsm-operator",
			state: "deactivated",
		});
	});

	test("global / connectivity lines return null (skipped)", () => {
		expect(
			parseMonitorLine(
				"NetworkManager is now in the 'connected (global)' state",
			),
		).toBeNull();
		expect(parseMonitorLine("NetworkManager is stopped")).toBeNull();
		expect(parseMonitorLine("Connectivity is now 'full'")).toBeNull();
	});

	test("blank / malformed lines return null", () => {
		expect(parseMonitorLine("")).toBeNull();
		expect(parseMonitorLine("   ")).toBeNull();
		expect(parseMonitorLine("garbage with no separator")).toBeNull();
		expect(parseMonitorLine('"unterminated quote line')).toBeNull();
	});
});

describe("NmcliMonitorManager — streaming parse", () => {
	test("emits parsed events from streamed stdout lines (incl. split chunks)", async () => {
		const spawn = () =>
			makeFakeProc(
				[
					"eth0: connecting (prepare)",
					'eth0: connected to "Wired connection 1"',
					'"Wired connection 1" (ethernet, 192.168.1.100/24): connection activated',
					"Connectivity is now 'full'", // global → skipped
				],
				{ hang: true, chunkSplit: true },
			);

		const events: MonitorEvent[] = [];
		const mgr = new NmcliMonitorManager(() => {}, spawn);
		mgr.on("monitor-event", (e) => events.push(e));
		mgr.start();

		await sleep(50);
		mgr.stop();
		await sleep(20);

		expect(events).toEqual([
			{ type: "device-state", device: "eth0", state: "connecting" },
			{ type: "device-state", device: "eth0", state: "connected" },
			{
				type: "connection-state",
				connection: "Wired connection 1",
				state: "activated",
			},
		]);
	});
});

// ─── 2. exit → restart + resync ────────────────────────────────────────────────

describe("NmcliMonitorManager — death detection / restart", () => {
	test("restarts after the child exits and calls onResync exactly once", async () => {
		let spawnCount = 0;
		const spawn = () => {
			spawnCount++;
			if (spawnCount === 1) {
				// First child emits a line then exits → triggers a restart.
				return makeFakeProc(['eth0: connected to "Wired connection 1"']);
			}
			// Subsequent child is long-lived so the supervisor parks here.
			return makeFakeProc([], { hang: true });
		};

		let resyncCount = 0;
		const events: MonitorEvent[] = [];
		const mgr = new NmcliMonitorManager(() => {
			resyncCount++;
		}, spawn);
		mgr.on("monitor-event", (e) => events.push(e));
		mgr.start();

		// First child exits, supervisor waits baseDelay (100ms) then respawns.
		await sleep(300);

		expect(spawnCount).toBe(2);
		expect(resyncCount).toBe(1);
		expect(events).toContainEqual({
			type: "device-state",
			device: "eth0",
			state: "connected",
		});

		mgr.stop();
		await sleep(20);
	});

	test("stop() halts the supervisor — no further restarts", async () => {
		let spawnCount = 0;
		const spawn = () => {
			spawnCount++;
			// Every child exits quickly; only stop() should end the loop.
			return makeFakeProc(["wlan0: disconnected"]);
		};
		const mgr = new NmcliMonitorManager(() => {}, spawn);
		mgr.start();

		await sleep(120); // allow at least one restart cycle
		mgr.stop();
		const countAtStop = spawnCount;
		await sleep(300); // would restart several more times if not stopped

		expect(mgr.isRunning).toBe(false);
		expect(spawnCount).toBe(countAtStop);
	});
});

// ─── 3. malformed line resilience ───────────────────────────────────────────────

describe("NmcliMonitorManager — resilience", () => {
	test("garbage input does not crash; stream continues and valid events still emit", async () => {
		const spawn = () =>
			makeFakeProc(
				[
					"garbage nonsense no separator",
					"###",
					'"unterminated quote',
					"NetworkManager is running",
					"wlan0: connected to 'FieldHotspot-5G'",
					"",
					"!!! totally broken !!!",
					"eth0: disconnected",
				],
				{ hang: true },
			);

		const events: MonitorEvent[] = [];
		const mgr = new NmcliMonitorManager(() => {}, spawn);
		mgr.on("monitor-event", (e) => events.push(e));
		mgr.start();

		await sleep(50);
		mgr.stop();
		await sleep(20);

		// Only the two valid device lines survive the garbage.
		expect(events).toEqual([
			{ type: "device-state", device: "wlan0", state: "connected" },
			{ type: "device-state", device: "eth0", state: "disconnected" },
		]);
	});
});

// ─── selection gate ─────────────────────────────────────────────────────────────

describe("createMonitorManager — selection", () => {
	const original = {
		MOCK_SCENARIO: process.env.MOCK_SCENARIO,
		NODE_ENV: process.env.NODE_ENV,
	};

	const restore = () => {
		if (original.MOCK_SCENARIO === undefined) delete process.env.MOCK_SCENARIO;
		else process.env.MOCK_SCENARIO = original.MOCK_SCENARIO;
		if (original.NODE_ENV === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = original.NODE_ENV;
	};

	test("returns the mock emitter when shouldUseMockMonitor() is true", () => {
		process.env.MOCK_SCENARIO = "multi-modem-wifi";
		try {
			const mgr = createMonitorManager(() => {});
			expect(mgr).toBeInstanceOf(MockMonitorEmitter);
		} finally {
			restore();
		}
	});

	test("returns the real manager when mock gate is off", () => {
		delete process.env.MOCK_SCENARIO;
		process.env.NODE_ENV = "production";
		try {
			// Inject a fake spawn so no real nmcli is ever invoked.
			const mgr = createMonitorManager(
				() => {},
				() => makeFakeProc([], { hang: true }),
			);
			expect(mgr).toBeInstanceOf(NmcliMonitorManager);
		} finally {
			restore();
		}
	});
});
