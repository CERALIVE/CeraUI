import { describe, expect, it } from "vitest";

import {
	type HealthRollup,
	parseHealthRollup,
} from "$lib/stores/stream-health.svelte";

/**
 * Task 15 — `parseHealthRollup` defensive parsing.
 *
 * The HUD rollup surfaces the per-subsystem breakdown (process/frames/SRT/bond)
 * the backend broadcasts. The parser must extract that breakdown when the frame
 * carries a recognised tri-state, and degrade safely (never throw, never return
 * a half-built object) for malformed or partial frames so a bad broadcast can
 * never crash the persistent HUD bar.
 */

const healthyFrame = {
	state: "healthy",
	process: { alive: true },
	frames: { advancing: true, count: 42 },
	srt: { reconnecting: false, reconnectCount: 0 },
	bond: { linkCount: 2, activeLinks: 2 },
};

describe("parseHealthRollup", () => {
	it("extracts the full breakdown from a healthy frame", () => {
		expect(parseHealthRollup(healthyFrame)).toEqual<HealthRollup>({
			state: "healthy",
			process: { alive: true },
			frames: { advancing: true, count: 42 },
			srt: { reconnecting: false, reconnectCount: 0 },
			bond: { linkCount: 2, activeLinks: 2 },
		});
	});

	it("carries the degraded state with its bond shortfall", () => {
		const rollup = parseHealthRollup({
			state: "degraded",
			process: { alive: true },
			frames: { advancing: false, count: 7 },
			srt: { reconnecting: true, reconnectCount: 3 },
			bond: { linkCount: 3, activeLinks: 1 },
		});
		expect(rollup?.state).toBe("degraded");
		expect(rollup?.frames.advancing).toBe(false);
		expect(rollup?.srt.reconnecting).toBe(true);
		expect(rollup?.bond).toEqual({ linkCount: 3, activeLinks: 1 });
	});

	it("reports a dead process from a dead frame", () => {
		const rollup = parseHealthRollup({
			state: "dead",
			process: { alive: false },
			frames: { advancing: false, count: 0 },
			srt: { reconnecting: false, reconnectCount: 0 },
			bond: { linkCount: 2, activeLinks: 0 },
		});
		expect(rollup?.state).toBe("dead");
		expect(rollup?.process.alive).toBe(false);
	});

	it("returns null for an unrecognised or missing state", () => {
		expect(parseHealthRollup({ state: "bogus" })).toBeNull();
		expect(parseHealthRollup({})).toBeNull();
		expect(parseHealthRollup(null)).toBeNull();
		expect(parseHealthRollup(undefined)).toBeNull();
		expect(parseHealthRollup("dead")).toBeNull();
	});

	it("coerces a partial frame to safe defaults instead of throwing", () => {
		// A recognised state with everything else missing must not throw and must
		// collapse booleans to false and counts to 0.
		expect(parseHealthRollup({ state: "degraded" })).toEqual<HealthRollup>({
			state: "degraded",
			process: { alive: false },
			frames: { advancing: false, count: 0 },
			srt: { reconnecting: false, reconnectCount: 0 },
			bond: { linkCount: 0, activeLinks: 0 },
		});
	});

	it("rejects negative and non-finite counts down to 0", () => {
		const rollup = parseHealthRollup({
			state: "healthy",
			process: { alive: true },
			frames: { advancing: true, count: -5 },
			srt: { reconnecting: false, reconnectCount: Number.NaN },
			bond: { linkCount: 2.9, activeLinks: 2 },
		});
		expect(rollup?.frames.count).toBe(0);
		expect(rollup?.srt.reconnectCount).toBe(0);
		// 2.9 truncates to 2 (a count is an integer link tally).
		expect(rollup?.bond.linkCount).toBe(2);
	});
});
