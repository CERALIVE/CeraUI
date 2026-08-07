import { describe, expect, it } from "vitest";

import { deriveCpuLoad } from "./cpu-load";

describe("deriveCpuLoad", () => {
	it("turns a load average into a share of the board's total capacity", () => {
		// The board report that produced this signal: one software encode pegging
		// a single core of an 8-core RK3588 reads 1.00, which is an eighth of the
		// machine — not the saturation the bare figure implied.
		const reading = deriveCpuLoad(1.0, 8);

		expect(reading).toEqual({
			load1: 1.0,
			cores: 8,
			percent: 13,
			fraction: 0.125,
			band: "light",
		});
	});

	it("keeps the raw load average as secondary context in every reading", () => {
		expect(deriveCpuLoad(3.4, 4)?.load1).toBe(3.4);
		expect(deriveCpuLoad(3.4, null)?.load1).toBe(3.4);
	});

	describe("the denominator is never assumed", () => {
		it.each([
			["absent", undefined],
			["null", null],
			["zero", 0],
			["negative", -4],
			["non-integral garbage", Number.NaN],
		])("reports no percentage when the core count is %s", (_label, cores) => {
			const reading = deriveCpuLoad(1.0, cores as number | null | undefined);

			expect(reading).not.toBeNull();
			expect(reading?.cores).toBeNull();
			expect(reading?.percent).toBeNull();
			expect(reading?.fraction).toBeNull();
			expect(reading?.band).toBeNull();
			// The load average itself is still a real reading and must survive.
			expect(reading?.load1).toBe(1.0);
		});
	});

	describe("no load average at all", () => {
		it.each([
			["absent", undefined],
			["null", null],
			["not finite", Number.POSITIVE_INFINITY],
			["negative", -1],
		])("is the tile's no-reading state when the load is %s", (_l, load) => {
			expect(deriveCpuLoad(load as number | null | undefined, 8)).toBeNull();
		});
	});

	describe("oversubscription", () => {
		it("reports the TRUE percentage above 100 while clamping the bar", () => {
			const reading = deriveCpuLoad(12, 8);

			expect(reading?.percent).toBe(150);
			expect(reading?.fraction).toBe(1);
			expect(reading?.band).toBe("heavy");
		});
	});

	describe("bands", () => {
		it.each([
			[0, "light"],
			[4.79, "light"],
			[4.8, "moderate"],
			[6.79, "moderate"],
			[6.8, "heavy"],
			[8, "heavy"],
		])("a load of %s on 8 cores is %s", (load, band) => {
			expect(deriveCpuLoad(load, 8)?.band).toBe(band);
		});
	});
});
