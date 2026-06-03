import { describe, expect, it } from "bun:test";
import {
	COALESCE_WINDOW_MS,
	type CoalesceState,
	getCoalesceWindowMs,
	shouldCoalesce,
	updateCoalesceState,
} from "../rpc/coalesce.ts";

/**
 * Drive the coalescer the same way the broadcast path does: check
 * `shouldCoalesce`, and only when it returns false do we "broadcast" and
 * `updateCoalesceState`. Returns the list of values that actually passed
 * through (were broadcast), with the matching `now` timestamp.
 *
 * NO fake timers — `now` is injected explicitly per the project convention.
 */
function drive(
	emissions: Array<{ now: number; value: unknown }>,
	windowMs: number,
	type = "sensors",
): unknown[] {
	const map: CoalesceState = new Map();
	const passed: unknown[] = [];
	for (const { now, value } of emissions) {
		if (!shouldCoalesce(map, type, value, now, windowMs)) {
			updateCoalesceState(map, type, value, now);
			passed.push(value);
		}
	}
	return passed;
}

describe("shouldCoalesce", () => {
	it("never coalesces the first value of a type (nothing to compare to)", () => {
		const map: CoalesceState = new Map();
		expect(shouldCoalesce(map, "sensors", { t: 1 }, 0, 1000)).toBe(false);
	});

	it("drops an identical value emitted again within the window", () => {
		const map: CoalesceState = new Map();
		updateCoalesceState(map, "sensors", { t: 1 }, 0);
		// identical payload, 300ms later, window is 1000ms → coalesce (drop)
		expect(shouldCoalesce(map, "sensors", { t: 1 }, 300, 1000)).toBe(true);
	});

	it("passes a DIFFERENT value even within the window", () => {
		const map: CoalesceState = new Map();
		updateCoalesceState(map, "sensors", { t: 1 }, 0);
		expect(shouldCoalesce(map, "sensors", { t: 2 }, 300, 1000)).toBe(false);
	});

	it("passes an identical value once the window has elapsed", () => {
		const map: CoalesceState = new Map();
		updateCoalesceState(map, "sensors", { t: 1 }, 0);
		// exactly at the window boundary the value passes (>= window → elapsed)
		expect(shouldCoalesce(map, "sensors", { t: 1 }, 1000, 1000)).toBe(false);
	});

	it("compares deeply, ignoring object key order", () => {
		const map: CoalesceState = new Map();
		updateCoalesceState(map, "sensors", { a: 1, b: 2 }, 0);
		expect(shouldCoalesce(map, "sensors", { b: 2, a: 1 }, 100, 1000)).toBe(
			true,
		);
	});

	it("never coalesces when windowMs <= 0 (disabled / unknown type)", () => {
		const map: CoalesceState = new Map();
		updateCoalesceState(map, "status", { t: 1 }, 0);
		expect(shouldCoalesce(map, "status", { t: 1 }, 0, 0)).toBe(false);
	});

	it("keeps per-type state independent", () => {
		const map: CoalesceState = new Map();
		updateCoalesceState(map, "sensors", { t: 1 }, 0);
		// a different type with the same payload has no prior state → passes
		expect(shouldCoalesce(map, "gateways", { t: 1 }, 100, 2000)).toBe(false);
	});
});

describe("coalescer end-to-end (driven like the broadcast path)", () => {
	it("drops a superseded intermediate duplicate within the window, passes the latest", () => {
		const A = { temp: 50 };
		const B = { temp: 51 };
		const passed = drive(
			[
				{ now: 0, value: A }, // first → pass
				{ now: 300, value: A }, // identical within window → DROPPED
				{ now: 400, value: B }, // changed → pass (latest)
				{ now: 1500, value: A }, // window elapsed since B → pass
			],
			1000,
		);
		expect(passed).toEqual([A, B, A]);
	});
});

describe("local cadence is unchanged", () => {
	it("passes every sensors tick at the ~1s cadence (changing telemetry)", () => {
		// Realistic sensors: value changes each second → every tick broadcasts.
		const emissions = [0, 1000, 2000, 3000, 4000].map((now) => ({
			now,
			value: { temp: 40 + now / 1000 },
		}));
		const passed = drive(emissions, COALESCE_WINDOW_MS.sensors);
		expect(passed).toHaveLength(5);
	});

	it("passes identical sensors ticks landing on the 1s window boundary", () => {
		// Even if the payload is identical, ticks exactly one window apart pass,
		// so the local 1s cadence is preserved.
		const A = { temp: 42 };
		const emissions = [0, 1000, 2000, 3000].map((now) => ({ now, value: A }));
		const passed = drive(emissions, COALESCE_WINDOW_MS.sensors);
		expect(passed).toHaveLength(4);
	});

	it("exposes the documented per-type windows = broadcast intervals", () => {
		expect(getCoalesceWindowMs("netif")).toBe(5000);
		expect(getCoalesceWindowMs("sensors")).toBe(1000);
		expect(getCoalesceWindowMs("gateways")).toBe(2000);
		expect(getCoalesceWindowMs("modems")).toBe(30000);
		// unknown types are not coalesced (window 0)
		expect(getCoalesceWindowMs("status")).toBe(0);
	});
});
