/**
 * CPU topology collector — the denominator `device-stats.cpuLoad1` was missing.
 *
 * Two properties carry this signal, and both are asserted here: the count is
 * READ from the host (never a constant, so a board with a different core count
 * reports its own), and an unusable answer degrades to `null` rather than to a
 * plausible number that would silently distort every derived percentage.
 */
import { describe, expect, test } from "bun:test";

import { CPU_UNKNOWN, collectCpuInfo } from "../modules/system/cpu.ts";

describe("collectCpuInfo", () => {
	test("reports the core count the host actually reported", () => {
		expect(collectCpuInfo({ cpuCount: () => 8 })).toEqual({ cores: 8 });
		expect(collectCpuInfo({ cpuCount: () => 4 })).toEqual({ cores: 4 });
	});

	test.each([
		["zero", 0],
		["negative", -1],
		["non-integral", 6.5],
		["not a number", Number.NaN],
	])("degrades to null when the count is %s", (_label, count) => {
		expect(collectCpuInfo({ cpuCount: () => count })).toEqual(CPU_UNKNOWN);
	});

	test("degrades to null instead of throwing when the read fails", () => {
		expect(
			collectCpuInfo({
				cpuCount: () => {
					throw new Error("no /proc/cpuinfo");
				},
			}),
		).toEqual(CPU_UNKNOWN);
	});

	test("the production default reads a real, positive count from this host", () => {
		// No injected dep: proves the shipped wiring resolves a count rather than
		// relying on the seam every other case here uses.
		const { cores } = collectCpuInfo();

		expect(cores).not.toBeNull();
		expect(Number.isInteger(cores)).toBe(true);
		expect(cores as number).toBeGreaterThan(0);
	});
});
