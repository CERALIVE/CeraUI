/**
 * Unit tests for streaming-stop-watchdog.ts (pure core).
 *
 * Locks the exact pull/redispatch/pull sequencing the field-reported "stuck after
 * stop until reload" recovery depends on (T0 acceptance 3):
 *
 *   • `stopping` + no flag change → exactly ONE pull, then
 *     - (pull=true)  exactly ONE stop re-dispatch + a second pull + banner exposed
 *     - (pull=false) immediate reconcile with NO re-dispatch (and no banner)
 */

import { describe, expect, it, vi } from "vitest";

import {
	runStopWatchdog,
	STOP_WATCHDOG_REPULL_DELAY_MS,
	STOP_WATCHDOG_TIMEOUT_MS,
	type StopWatchdogDeps,
} from "./streaming-stop-watchdog";

interface Recorder {
	deps: StopWatchdogDeps;
	pullCalls: number;
	redispatchCalls: number;
	delayCalls: number;
	reconciledWith: boolean[];
	bannerHistory: boolean[];
}

/** Build injectable deps whose `pullStatus` returns the given queued booleans. */
function makeDeps(pullResults: boolean[]): Recorder {
	const rec: Recorder = {
		pullCalls: 0,
		redispatchCalls: 0,
		delayCalls: 0,
		reconciledWith: [],
		bannerHistory: [],
		deps: undefined as unknown as StopWatchdogDeps,
	};
	rec.deps = {
		pullStatus: async () => {
			const value = pullResults[rec.pullCalls] ?? false;
			rec.pullCalls += 1;
			return value;
		},
		reconcile: (isStreaming) => {
			rec.reconciledWith.push(isStreaming);
		},
		redispatchStop: () => {
			rec.redispatchCalls += 1;
		},
		delay: async () => {
			rec.delayCalls += 1;
		},
		setBannerVisible: (visible) => {
			rec.bannerHistory.push(visible);
		},
	};
	return rec;
}

describe("streaming-stop-watchdog", () => {
	it("exports sane bounded timing constants", () => {
		expect(STOP_WATCHDOG_TIMEOUT_MS).toBeGreaterThan(0);
		expect(STOP_WATCHDOG_REPULL_DELAY_MS).toBeGreaterThan(0);
		// The re-pull delay must be comfortably inside the fire window.
		expect(STOP_WATCHDOG_REPULL_DELAY_MS).toBeLessThan(
			STOP_WATCHDOG_TIMEOUT_MS,
		);
	});

	it("pull=false → exactly ONE pull, reconcile(false), NO re-dispatch, NO banner (no-rebroadcast trap)", async () => {
		const rec = makeDeps([false]);
		await runStopWatchdog(rec.deps);

		expect(rec.pullCalls).toBe(1);
		expect(rec.redispatchCalls).toBe(0);
		expect(rec.delayCalls).toBe(0);
		expect(rec.reconciledWith).toEqual([false]);
		// Banner never shown; if touched at all it is only to hide it.
		expect(rec.bannerHistory.every((v) => v === false)).toBe(true);
	});

	it("pull=true then still true → ONE re-dispatch + a second pull + banner exposed (genuinely stuck)", async () => {
		const rec = makeDeps([true, true]);
		await runStopWatchdog(rec.deps);

		expect(rec.pullCalls).toBe(2);
		expect(rec.redispatchCalls).toBe(1);
		expect(rec.delayCalls).toBe(1);
		expect(rec.reconciledWith).toEqual([true, true]);
		// Banner is exposed and, since the second pull is still streaming, NOT cleared.
		expect(rec.bannerHistory).toContain(true);
		expect(rec.bannerHistory.at(-1)).toBe(true);
	});

	it("pull=true then false → ONE re-dispatch + second pull, banner cleared (recovered after re-dispatch)", async () => {
		const rec = makeDeps([true, false]);
		await runStopWatchdog(rec.deps);

		expect(rec.pullCalls).toBe(2);
		expect(rec.redispatchCalls).toBe(1);
		expect(rec.reconciledWith).toEqual([true, false]);
		// Banner is exposed first, then cleared on the confirming false pull.
		expect(rec.bannerHistory).toContain(true);
		expect(rec.bannerHistory.at(-1)).toBe(false);
	});

	it("re-dispatches through the injected direct path, never a window global", async () => {
		const redispatch = vi.fn();
		const rec = makeDeps([true, false]);
		rec.deps.redispatchStop = redispatch;
		await runStopWatchdog(rec.deps);
		expect(redispatch).toHaveBeenCalledTimes(1);
	});
});
