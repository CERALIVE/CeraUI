import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";

import { MOCK_FEEDBACK_BROADCAST_INTERVAL_MS } from "../mocks/mock-constants.ts";
import {
	getMockState,
	initMockService,
	resetMockState,
	runMockFeedbackBroadcast,
	setMockModemState,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	discoverModems,
	initModemUpdateLoop,
	stopModemUpdateLoop,
} from "../modules/modems/modem-update-loop.ts";
import { getModemIds, removeModem } from "../modules/modems/modems-state.ts";
import { setModemsState } from "../modules/modems/state/modems-state-cache.ts";
import type {
	IMonitorEmitter,
	MonitorEvent,
} from "../modules/network/state-types.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

const SCENARIO = "multi-modem-wifi";

/** Minimal in-test monitor — the loop only needs on/off/start/stop dispatch. */
class FakeMonitor implements IMonitorEmitter {
	private readonly listeners = new Set<(e: MonitorEvent) => void>();
	on(_event: "monitor-event", cb: (e: MonitorEvent) => void): void {
		this.listeners.add(cb);
	}
	off(_event: "monitor-event", cb: (e: MonitorEvent) => void): void {
		this.listeners.delete(cb);
	}
	start(): void {}
	stop(): void {}
	emit(event: MonitorEvent): void {
		for (const cb of [...this.listeners]) cb(event);
	}
}

type StatusPayload = Record<string, unknown>;

/** Authed fake client that decodes and records every broadcast it receives. */
function makeRecordingClient(
	sink: Array<Record<string, unknown>>,
): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (msg: string) => {
			try {
				sink.push(JSON.parse(msg) as Record<string, unknown>);
			} catch {
				// non-JSON frame — irrelevant to these assertions
			}
		},
	} as unknown as AppWebSocket;
}

function statusPayloads(sink: Array<Record<string, unknown>>): StatusPayload[] {
	return sink
		.filter((m) => "status" in m)
		.map((m) => m.status as StatusPayload);
}

function modemStatuses(sink: Array<Record<string, unknown>>): StatusPayload[] {
	return statusPayloads(sink).filter((s) => "modems" in s);
}

function wifiStatuses(sink: Array<Record<string, unknown>>): StatusPayload[] {
	return statusPayloads(sink).filter((s) => "wifi" in s);
}

const monitor = new FakeMonitor();

// Both blocks below flip MOCK_MODE on; restore it (bun shares one global across
// files, so an unrestored env write leaks into every later suite).
const savedMockMode = process.env.MOCK_MODE;

function restoreMockMode(): void {
	if (savedMockMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMockMode;
}

describe("mock feedback broadcast — signal fluctuations reach clients on a 5s cadence", () => {
	beforeAll(async () => {
		process.env.MOCK_MODE = "true";
		initMockService(SCENARIO);
		// Register the onModemsChange → broadcast handler and the 3 mock modems so
		// the refresh path has real targets; no auto 30s poll (tests drive ticks).
		await initModemUpdateLoop({
			monitor,
			autoDiscover: false,
			startPoll: false,
		});
		await discoverModems();
	});

	beforeEach(() => {
		// Clean slate each test: restores pristine mock state, clears every timer
		// (so the 1s fluctuation timer never mutates mid-test), resets dedupe caches.
		resetMockState();
	});

	afterAll(() => {
		stopModemUpdateLoop();
		stopMockService();
		for (const id of getModemIds()) removeModem(id);
		setModemsState({});
		restoreMockMode();
	});

	test("(a) two consecutive feedback ticks broadcast the changed modem signal", async () => {
		const sink: Array<Record<string, unknown>> = [];
		const client = makeRecordingClient(sink);
		addClient(client);
		try {
			getMockState().modemSignals.set(0, 61);
			await runMockFeedbackBroadcast();

			getMockState().modemSignals.set(0, 88);
			await runMockFeedbackBroadcast();

			const signals = modemStatuses(sink).map((s) =>
				String(
					(s.modems as Record<string, { status: { signal: unknown } }>)["0"]
						.status.signal,
				),
			);
			expect(signals).toContain("61");
			expect(signals).toContain("88");
		} finally {
			removeClient(client);
		}
	});

	test("(b) a wifi-signal change is surfaced via a status.wifi broadcast", async () => {
		const sink: Array<Record<string, unknown>> = [];
		const client = makeRecordingClient(sink);
		addClient(client);
		try {
			const ssid = [...getMockState().wifiSignals.keys()][0];
			expect(ssid).toBeDefined();
			getMockState().wifiSignals.set(ssid as string, 33);

			await runMockFeedbackBroadcast();

			const found = wifiStatuses(sink).some((s) => {
				const wifi = s.wifi as Record<
					string,
					{ available?: Array<{ ssid: string; signal: number }> }
				>;
				return Object.values(wifi).some((iface) =>
					(iface.available ?? []).some(
						(n) => n.ssid === ssid && n.signal === 33,
					),
				);
			});
			expect(found).toBe(true);
		} finally {
			removeClient(client);
		}
	});

	test("no modem broadcast when the signal is unchanged since the last emit (dedupe)", async () => {
		const sink: Array<Record<string, unknown>> = [];
		const client = makeRecordingClient(sink);
		addClient(client);
		try {
			getMockState().modemSignals.set(0, 73);
			await runMockFeedbackBroadcast();
			const first = modemStatuses(sink).length;
			expect(first).toBeGreaterThanOrEqual(1);

			// Nothing changed → second tick must not re-broadcast modems.
			await runMockFeedbackBroadcast();
			expect(modemStatuses(sink).length).toBe(first);
		} finally {
			removeClient(client);
		}
	});

	test("no wifi broadcast when the wifi signal is unchanged (dedupe)", async () => {
		const sink: Array<Record<string, unknown>> = [];
		const client = makeRecordingClient(sink);
		addClient(client);
		try {
			const ssid = [...getMockState().wifiSignals.keys()][0] as string;
			getMockState().wifiSignals.set(ssid, 44);
			await runMockFeedbackBroadcast();
			const first = wifiStatuses(sink).length;
			expect(first).toBeGreaterThanOrEqual(1);

			await runMockFeedbackBroadcast();
			expect(wifiStatuses(sink).length).toBe(first);
		} finally {
			removeClient(client);
		}
	});

	test("setMockModemState mutates state, refreshes, and broadcasts one modems update", async () => {
		const sink: Array<Record<string, unknown>> = [];
		const client = makeRecordingClient(sink);
		addClient(client);
		try {
			await setMockModemState(0, "searching");

			expect(getMockState().modemStates.get(0)).toBe("searching");
			const statuses = modemStatuses(sink);
			expect(statuses.length).toBeGreaterThanOrEqual(1);
			const last = statuses[statuses.length - 1]?.modems as Record<
				string,
				{ status: { connection: string } }
			>;
			expect(last["0"].status.connection).toBe("searching");
		} finally {
			removeClient(client);
		}
	});
});

describe("mock feedback broadcast — timer lifecycle", () => {
	beforeAll(() => {
		process.env.MOCK_MODE = "true";
	});
	afterEach(() => {
		resetMockState();
	});
	afterAll(() => {
		stopMockService();
		restoreMockMode();
	});

	test("(c) resetMockState clears the feedback broadcast interval (no leaked timer)", () => {
		const setSpy = spyOn(globalThis, "setInterval");
		initMockService(SCENARIO);

		let feedbackTimerId: ReturnType<typeof setInterval> | undefined;
		setSpy.mock.calls.forEach((call, i) => {
			if (call[1] === MOCK_FEEDBACK_BROADCAST_INTERVAL_MS) {
				feedbackTimerId = setSpy.mock.results[i]?.value as ReturnType<
					typeof setInterval
				>;
			}
		});
		setSpy.mockRestore();
		expect(feedbackTimerId).toBeDefined();

		const clearSpy = spyOn(globalThis, "clearInterval");
		resetMockState();
		const wasCleared = clearSpy.mock.calls.some(
			(c) => c[0] === feedbackTimerId,
		);
		clearSpy.mockRestore();
		expect(wasCleared).toBe(true);
	});
});

describe("mock feedback broadcast — production/real gating", () => {
	test("(d) with mocks off (production/real device) no feedback interval is scheduled", () => {
		const prevMockMode = process.env.MOCK_MODE;
		const prevNodeEnv = process.env.NODE_ENV;
		const prevDeviceType = process.env.CERALIVE_DEVICE_TYPE;

		delete process.env.MOCK_MODE;
		process.env.NODE_ENV = "production";
		process.env.CERALIVE_DEVICE_TYPE = "real";
		stopMockService();

		const setSpy = spyOn(globalThis, "setInterval");
		try {
			initMockService(SCENARIO);
			const scheduledFeedback = setSpy.mock.calls.some(
				(c) => c[1] === MOCK_FEEDBACK_BROADCAST_INTERVAL_MS,
			);
			expect(scheduledFeedback).toBe(false);
		} finally {
			setSpy.mockRestore();
			stopMockService();
			if (prevMockMode === undefined) delete process.env.MOCK_MODE;
			else process.env.MOCK_MODE = prevMockMode;
			if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = prevNodeEnv;
			if (prevDeviceType === undefined) delete process.env.CERALIVE_DEVICE_TYPE;
			else process.env.CERALIVE_DEVICE_TYPE = prevDeviceType;
		}
	});
});
