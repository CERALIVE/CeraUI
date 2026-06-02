import { afterEach, describe, expect, test } from "bun:test";

import {
	type IMonitorEmitter,
	MockMonitorEmitter,
	type MonitorEvent,
	type ScriptedMonitorEvent,
	shouldUseMockMonitor,
} from "../modules/network/monitor/mock-monitor.ts";
import { loadFixture, loadFixtureLines } from "./helpers/load-fixture.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const deviceUp = (device: string): MonitorEvent => ({
	type: "device-state",
	device,
	state: "connected",
});

const modemAdded = (id: string): MonitorEvent => ({
	type: "modem-added",
	id,
});

// ─── interface conformance ───────────────────────────────────────────────────

describe("MockMonitorEmitter — IMonitorEmitter conformance", () => {
	test("satisfies the IMonitorEmitter contract", () => {
		// Type-level: assignable to the shared interface.
		const emitter: IMonitorEmitter = new MockMonitorEmitter();
		expect(typeof emitter.start).toBe("function");
		expect(typeof emitter.stop).toBe("function");
		expect(typeof emitter.on).toBe("function");
		expect(typeof emitter.off).toBe("function");
	});
});

// ─── scripted emission ───────────────────────────────────────────────────────

describe("MockMonitorEmitter — scripted emission", () => {
	test("emits events in scripted order after their delays", async () => {
		const script: ScriptedMonitorEvent[] = [
			{ delayMs: 10, event: deviceUp("eth0") },
			{ delayMs: 20, event: modemAdded("0") },
			{ delayMs: 30, event: deviceUp("wlan0") },
		];
		const emitter = new MockMonitorEmitter(script);
		const received: MonitorEvent[] = [];
		emitter.on("monitor-event", (e) => received.push(e));

		emitter.start();
		expect(received).toHaveLength(0); // nothing synchronously

		await sleep(60);

		expect(received).toEqual(script.map((s) => s.event));
		emitter.stop();
	});

	test("equal delays preserve array order", async () => {
		const script: ScriptedMonitorEvent[] = [
			{ delayMs: 5, event: modemAdded("0") },
			{ delayMs: 5, event: modemAdded("1") },
			{ delayMs: 5, event: modemAdded("2") },
		];
		const emitter = new MockMonitorEmitter(script);
		const ids: string[] = [];
		emitter.on("monitor-event", (e) => {
			if (e.type === "modem-added") ids.push(e.id);
		});

		emitter.start();
		await sleep(30);

		expect(ids).toEqual(["0", "1", "2"]);
		emitter.stop();
	});

	test("start() is idempotent — no double emission", async () => {
		const emitter = new MockMonitorEmitter([
			{ delayMs: 5, event: modemAdded("0") },
		]);
		let count = 0;
		emitter.on("monitor-event", () => count++);

		emitter.start();
		emitter.start(); // should be a no-op
		await sleep(20);

		expect(count).toBe(1);
		emitter.stop();
	});
});

// ─── listeners ───────────────────────────────────────────────────────────────

describe("MockMonitorEmitter — listeners", () => {
	test("off() removes a listener before it fires", async () => {
		const emitter = new MockMonitorEmitter([
			{ delayMs: 5, event: modemAdded("0") },
		]);
		let count = 0;
		const listener = () => count++;
		emitter.on("monitor-event", listener);
		emitter.off("monitor-event", listener);

		emitter.start();
		await sleep(20);

		expect(count).toBe(0);
		emitter.stop();
	});

	test("off() removes a listener", async () => {
		const emitter = new MockMonitorEmitter([
			{ delayMs: 5, event: modemAdded("0") },
		]);
		let count = 0;
		const listener = () => count++;
		emitter.on("monitor-event", listener);
		emitter.off("monitor-event", listener);

		emitter.start();
		await sleep(20);

		expect(count).toBe(0);
		emitter.stop();
	});

	test("multiple listeners all receive each event", async () => {
		const emitter = new MockMonitorEmitter([
			{ delayMs: 5, event: modemAdded("7") },
		]);
		const a: string[] = [];
		const b: string[] = [];
		emitter.on("monitor-event", (e) => {
			if (e.type === "modem-added") a.push(e.id);
		});
		emitter.on("monitor-event", (e) => {
			if (e.type === "modem-added") b.push(e.id);
		});

		emitter.start();
		await sleep(20);

		expect(a).toEqual(["7"]);
		expect(b).toEqual(["7"]);
		emitter.stop();
	});
});

// ─── stop / reset / re-script ────────────────────────────────────────────────

describe("MockMonitorEmitter — stop / reset / re-script", () => {
	test("stop() cancels pending events", async () => {
		const emitter = new MockMonitorEmitter([
			{ delayMs: 30, event: modemAdded("0") },
		]);
		let count = 0;
		emitter.on("monitor-event", () => count++);

		emitter.start();
		emitter.stop();
		await sleep(50);

		expect(count).toBe(0);
	});

	test("can be re-scripted and re-started after stop", async () => {
		const emitter = new MockMonitorEmitter([
			{ delayMs: 5, event: modemAdded("0") },
		]);
		const received: MonitorEvent[] = [];
		emitter.on("monitor-event", (e) => received.push(e));

		emitter.start();
		await sleep(20);
		expect(received).toHaveLength(1);

		emitter.stop();
		emitter.script([
			{ delayMs: 5, event: deviceUp("usb0") },
			{ delayMs: 10, event: deviceUp("usb1") },
		]);
		emitter.start();
		await sleep(30);

		expect(received).toHaveLength(3);
		expect(received[1]).toEqual(deviceUp("usb0"));
		expect(received[2]).toEqual(deviceUp("usb1"));
		emitter.stop();
	});

	test("reset() clears timers, listeners and script", async () => {
		const emitter = new MockMonitorEmitter([
			{ delayMs: 10, event: modemAdded("0") },
		]);
		let count = 0;
		emitter.on("monitor-event", () => count++);

		emitter.start();
		emitter.reset();
		await sleep(20);

		expect(count).toBe(0);
		expect(emitter.isStarted).toBe(false);

		// After reset the script is empty; starting emits nothing.
		emitter.start();
		await sleep(20);
		expect(count).toBe(0);
		emitter.stop();
	});

	test("isStarted reflects lifecycle", () => {
		const emitter = new MockMonitorEmitter();
		expect(emitter.isStarted).toBe(false);
		emitter.start();
		expect(emitter.isStarted).toBe(true);
		emitter.stop();
		expect(emitter.isStarted).toBe(false);
	});
});

// ─── env gate ────────────────────────────────────────────────────────────────

describe("shouldUseMockMonitor — env gate", () => {
	const original = {
		MOCK_SCENARIO: process.env.MOCK_SCENARIO,
		NODE_ENV: process.env.NODE_ENV,
	};

	afterEach(() => {
		if (original.MOCK_SCENARIO === undefined) delete process.env.MOCK_SCENARIO;
		else process.env.MOCK_SCENARIO = original.MOCK_SCENARIO;
		if (original.NODE_ENV === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = original.NODE_ENV;
	});

	test("true when MOCK_SCENARIO is set", () => {
		delete process.env.NODE_ENV;
		process.env.MOCK_SCENARIO = "multi-modem-wifi";
		expect(shouldUseMockMonitor()).toBe(true);
	});

	test("true when NODE_ENV=test", () => {
		delete process.env.MOCK_SCENARIO;
		process.env.NODE_ENV = "test";
		expect(shouldUseMockMonitor()).toBe(true);
	});

	test("false when neither is set", () => {
		delete process.env.MOCK_SCENARIO;
		process.env.NODE_ENV = "production";
		expect(shouldUseMockMonitor()).toBe(false);
	});
});

// ─── fixtures sanity ─────────────────────────────────────────────────────────

describe("network fixtures — load + shape sanity", () => {
	test("nmcli device status fixture is colon-separated terse output", () => {
		const lines = loadFixtureLines("network/nmcli-device-status.txt");
		expect(lines.length).toBeGreaterThan(0);
		const [first] = lines;
		expect(first).toBeDefined();
		// DEVICE:TYPE:STATE:CONNECTION:CON-PATH
		expect((first as string).split(":").length).toBeGreaterThanOrEqual(5);
		expect(first as string).toContain("eth0");
	});

	test("nmcli empty fixtures contain no data lines", () => {
		expect(loadFixtureLines("network/nmcli-device-status-empty.txt")).toEqual(
			[],
		);
		expect(loadFixtureLines("network/nmcli-wifi-list-empty.txt")).toEqual([]);
		expect(loadFixtureLines("network/nmcli-connection-show-empty.txt")).toEqual(
			[],
		);
	});

	test("nmcli device show error fixture has Error prefix", () => {
		expect(loadFixture("network/nmcli-device-show-error.txt")).toContain(
			"Error:",
		);
	});

	test("mmcli list fixtures advertise the right modem counts", () => {
		expect(loadFixture("network/mmcli-list-0.txt")).toContain(
			"modem-list.length",
		);
		expect(
			loadFixtureLines("network/mmcli-list-1.txt").filter((l) =>
				l.includes("/Modem/"),
			),
		).toHaveLength(1);
		expect(
			loadFixtureLines("network/mmcli-list-3.txt").filter((l) =>
				l.includes("/Modem/"),
			),
		).toHaveLength(3);
	});

	test("mmcli modem detail fixture is key : value shaped", () => {
		const text = loadFixture("network/mmcli-modem-0.txt");
		expect(text).toContain("modem.generic.model");
		expect(text).toContain("modem.3gpp.operator-name");
		// every non-empty line carries a ':' separator
		for (const line of loadFixtureLines("network/mmcli-modem-0.txt")) {
			expect(line).toContain(":");
		}
	});

	test("mmcli error fixtures start with 'error:'", () => {
		expect(loadFixture("network/mmcli-modem-error.txt")).toContain("error:");
		expect(loadFixture("network/mmcli-3gpp-scan-error.txt")).toContain(
			"error:",
		);
	});
});
