import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";

import {
	getMockState,
	initMockService,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	discoverModems,
	initModemUpdateLoop,
	runModemStatusPoll,
	stopModemUpdateLoop,
	whenModemUpdatesSettled,
} from "../modules/modems/modem-update-loop.ts";
import {
	getModem,
	getModemIds,
	removeModem,
} from "../modules/modems/modems-state.ts";
import {
	onGsmConnectionsReset,
	onModemsChange,
	setModemsState,
} from "../modules/modems/state/modems-state-cache.ts";
import type {
	IMonitorEmitter,
	MonitorEvent,
} from "../modules/network/state-types.ts";

/**
 * Minimal in-test {@link IMonitorEmitter} that lets the test drive monitor
 * events synchronously via `emit()`. The real loop only depends on
 * on/off/start/stop + listener dispatch.
 */
class FakeMonitor implements IMonitorEmitter {
	private readonly listeners = new Set<(e: MonitorEvent) => void>();
	started = false;

	on(_event: "monitor-event", cb: (e: MonitorEvent) => void): void {
		this.listeners.add(cb);
	}

	off(_event: "monitor-event", cb: (e: MonitorEvent) => void): void {
		this.listeners.delete(cb);
	}

	start(): void {
		this.started = true;
	}

	stop(): void {
		this.started = false;
	}

	emit(event: MonitorEvent): void {
		for (const cb of [...this.listeners]) {
			cb(event);
		}
	}
}

const monitor = new FakeMonitor();

describe("modem migration — event-driven presence + retained status poll", () => {
	const savedMockMode = process.env.MOCK_MODE;

	beforeAll(async () => {
		// Activate the mock providers so mmcli/nmcli never touch real binaries.
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");

		// Wire the loop with an injected monitor; no auto-discovery and no live
		// 30s interval — the tests drive presence + polls explicitly.
		await initModemUpdateLoop({
			monitor,
			autoDiscover: false,
			startPoll: false,
		});
	});

	afterAll(() => {
		stopModemUpdateLoop();
		stopMockService();
		// The final discoverModems test registers modems into the shared
		// modemsState singleton; clear it so they don't leak into later files.
		for (const id of getModemIds()) {
			removeModem(id);
		}
		setModemsState({});
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
	});

	beforeEach(() => {
		// Reset both the legacy record and the T11 cache to a clean baseline.
		for (const id of getModemIds()) {
			removeModem(id);
		}
		setModemsState({});
	});

	test("modem-added event registers the modem and resets gsm connections once", async () => {
		expect(getModem(0)).toBeUndefined();

		let gsmResets = 0;
		const unsubGsm = onGsmConnectionsReset(() => {
			gsmResets++;
		});

		let calls = 0;
		let captured: ReturnType<typeof captureDiff> | undefined;
		const unsubDiff = onModemsChange((diff) => {
			calls++;
			captured = captureDiff(diff);
		});

		monitor.emit({ type: "modem-added", id: "0" });
		await whenModemUpdatesSettled();

		unsubDiff();
		unsubGsm();

		// Modem registered into the live state.
		expect(getModem(0)).toBeDefined();
		expect(getModem(0)?.ifname).toBe("usb0");

		// The reconcile diff classified it as an addition…
		expect(calls).toBe(1);
		expect(captured?.added).toEqual([0]);
		expect(captured?.removed).toEqual([]);
		expect(captured?.changed).toEqual([]);

		// …and gsm connections were reset exactly once (on the add).
		expect(gsmResets).toBe(1);
	});

	test("status poll refreshes signal without a full rebuild and does NOT reset gsm", async () => {
		// Register modem 0 first (this fires its own add-time gsm reset, before
		// our counters are attached below).
		monitor.emit({ type: "modem-added", id: "0" });
		await whenModemUpdatesSettled();

		const baselineSignal = getModem(0)?.status?.signal;
		expect(baselineSignal).toBeDefined();

		// Force a clearly different signal for the next mmcli read.
		const newSignal = (baselineSignal ?? 0) >= 50 ? 20 : 90;
		getMockState().modemSignals.set(0, newSignal);

		let gsmResets = 0;
		const unsubGsm = onGsmConnectionsReset(() => {
			gsmResets++;
		});

		let calls = 0;
		let captured: ReturnType<typeof captureDiff> | undefined;
		const unsubDiff = onModemsChange((diff) => {
			calls++;
			captured = captureDiff(diff);
		});

		await runModemStatusPoll();

		unsubDiff();
		unsubGsm();

		// Signal-only diff: the modem changed, nothing was added or removed.
		expect(calls).toBe(1);
		expect(captured?.changed).toEqual([0]);
		expect(captured?.added).toEqual([]);
		expect(captured?.removed).toEqual([]);
		// mmcli's `-K` parser yields string scalars at runtime; compare by value.
		expect(String(getModem(0)?.status?.signal)).toBe(String(newSignal));

		// The retained status poll must NEVER reset gsm connections.
		expect(gsmResets).toBe(0);
	});

	test("modem-removed event drops the modem and resets gsm once", async () => {
		monitor.emit({ type: "modem-added", id: "0" });
		await whenModemUpdatesSettled();
		expect(getModem(0)).toBeDefined();

		let gsmResets = 0;
		const unsubGsm = onGsmConnectionsReset(() => {
			gsmResets++;
		});
		let captured: ReturnType<typeof captureDiff> | undefined;
		const unsubDiff = onModemsChange((diff) => {
			captured = captureDiff(diff);
		});

		monitor.emit({ type: "modem-removed", id: "0" });
		await whenModemUpdatesSettled();

		unsubDiff();
		unsubGsm();

		expect(getModem(0)).toBeUndefined();
		expect(captured?.removed).toEqual([0]);
		expect(captured?.added).toEqual([]);
		expect(gsmResets).toBe(1);
	});

	test("the old 10s self-recursive presence driver is gone; the retained poll is jittered + reduced-cadence", async () => {
		const src = await Bun.file(
			`${import.meta.dir}/../modules/modems/modem-update-loop.ts`,
		).text();

		// The old always-on 10s self-recursive presence driver is gone: no
		// `setTimeout(updateModems, …)` re-listing loop, no 10s cadence.
		expect(src).not.toContain("setTimeout(updateModems");
		expect(src).not.toContain("10_000");

		// The retained status poll runs at the reduced 30s cadence, event-driven
		// presence still drives add/remove, and the poll is jittered to
		// de-correlate the fleet (a self-rescheduling jittered setTimeout, NOT a
		// resurrection of the old presence driver).
		expect(src).toContain("STATUS_POLL_INTERVAL_MS");
		expect(src).toContain("30_000");
		expect(src).toContain("applyJitter(");
		expect(src).toContain('"modem-added"');
		expect(src).toContain('"modem-removed"');
	});

	test("discoverModems reconciles the full mock modem set on startup/resync", async () => {
		await discoverModems();
		// multi-modem-wifi scenario exposes 3 modems.
		expect(getModemIds().sort((a, b) => a - b)).toEqual([0, 1, 2]);
	});
});

function captureDiff(diff: {
	added: Array<{ id: number }>;
	removed: Array<{ id: number }>;
	changed: Array<{ id: number }>;
}) {
	return {
		added: diff.added.map((e) => e.id),
		removed: diff.removed.map((e) => e.id),
		changed: diff.changed.map((e) => e.id),
	};
}
