/**
 * The three-state encoder-load model.
 *
 * The load-bearing assertion in this file is a NEGATIVE one: nothing anywhere
 * turns a busy/idle reading into a number. A mainline kernel reports only the
 * encoder cores' clock enable-state, so rendering `active: true` as "50 %" (or
 * as a half-filled bar) would fabricate a denominator the driver never produced
 * — exactly the class of lie the panel exists to prevent.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	anyCoreBusy,
	coreReadingFromEnableCount,
	coreReadingFromPercent,
	ENCODER_CORE_IDS,
	ENCODER_LOAD_UNAVAILABLE,
	type EncoderLoadReading,
	encoderLoadPrecision,
	isEncoderLoadInstrumented,
	parseLoadPercent,
} from "./encoder-load";
import {
	DEFAULT_ENCODER_LOAD_MOCK_FLAVOR,
	mockEncoderLoadAt,
	parseEncoderLoadMockFlavor,
} from "./encoder-load-mock";

const T = 1_800_000_000_000;

describe("parseLoadPercent", () => {
	it("accepts the measured vendor-kernel figures", () => {
		expect(parseLoadPercent(0)).toBe(0);
		expect(parseLoadPercent("11.34")).toBe(11.34);
		expect(parseLoadPercent(45.53)).toBe(45.53);
	});

	it("REFUSES an out-of-range figure rather than clamping it", () => {
		// A clamped wrong figure still reads as a measurement.
		expect(parseLoadPercent(101)).toBeNull();
		expect(parseLoadPercent(-1)).toBeNull();
		expect(parseLoadPercent("n/a")).toBeNull();
		expect(parseLoadPercent(Number.NaN)).toBeNull();
	});
});

describe("coreReadingFromEnableCount — busy/idle ONLY", () => {
	it("maps a positive count to busy without inventing a magnitude", () => {
		const reading = coreReadingFromEnableCount("rkvenc0", 2);
		expect(reading).toEqual({ core: "rkvenc0", kind: "active", active: true });
		expect(reading).not.toHaveProperty("percent");
	});

	it("treats the measured 2-vs-1 as a REFERENCE COUNT, not a magnitude", () => {
		// Four concurrent sessions produced core0=2, core1=1 on mainline. That is
		// not "core0 is twice as busy" — both are simply enabled.
		const core0 = coreReadingFromEnableCount("rkvenc0", 2);
		const core1 = coreReadingFromEnableCount("rkvenc1", 1);
		expect(core0).toEqual(core1 && { ...core1, core: "rkvenc0" });
	});

	it("maps zero to idle and a malformed read to unavailable", () => {
		expect(coreReadingFromEnableCount("rkvenc1", 0)).toEqual({
			core: "rkvenc1",
			kind: "active",
			active: false,
		});
		expect(coreReadingFromEnableCount("rkvenc1", "oops").kind).toBe(
			"unavailable",
		);
		expect(coreReadingFromEnableCount("rkvenc1", -3).kind).toBe("unavailable");
	});
});

describe("coreReadingFromPercent", () => {
	it("degrades an unparseable read to unavailable, never to zero", () => {
		expect(coreReadingFromPercent("rkvenc0", "").kind).toBe("unavailable");
		expect(coreReadingFromPercent("rkvenc0", 0)).toEqual({
			core: "rkvenc0",
			kind: "percent",
			percent: 0,
		});
	});
});

describe("precision + instrumentation", () => {
	const reading = (
		cores: EncoderLoadReading["cores"],
		source: EncoderLoadReading["source"],
	): EncoderLoadReading => ({ source, cores, updatedAt: T, simulated: false });

	it("the honest floor claims nothing", () => {
		expect(isEncoderLoadInstrumented(ENCODER_LOAD_UNAVAILABLE)).toBe(false);
		expect(encoderLoadPrecision(ENCODER_LOAD_UNAVAILABLE)).toBe("none");
	});

	it("a source with every core unreadable is NOT instrumented", () => {
		const r = reading(
			ENCODER_CORE_IDS.map((core) => ({ core, kind: "unavailable" as const })),
			"mpp-service",
		);
		expect(isEncoderLoadInstrumented(r)).toBe(false);
	});

	it("percent and binary readings get different precisions", () => {
		expect(
			encoderLoadPrecision(
				reading(
					[{ core: "rkvenc0", kind: "percent", percent: 11.34 }],
					"mpp-service",
				),
			),
		).toBe("percent");
		expect(
			encoderLoadPrecision(
				reading(
					[{ core: "rkvenc0", kind: "active", active: true }],
					"clk-enable-count",
				),
			),
		).toBe("binary");
	});

	it("a zero-percent core is not busy; an active core is", () => {
		expect(
			anyCoreBusy(
				reading(
					[{ core: "rkvenc0", kind: "percent", percent: 0 }],
					"mpp-service",
				),
			),
		).toBe(false);
		expect(
			anyCoreBusy(
				reading(
					[{ core: "rkvenc0", kind: "active", active: true }],
					"clk-enable-count",
				),
			),
		).toBe(true);
	});
});

describe("no path converts busy/idle into a number", () => {
	it("exports no active-to-percent helper", async () => {
		const module = await import("./encoder-load");
		for (const [name, value] of Object.entries(module)) {
			if (typeof value !== "function") continue;
			expect(name).not.toMatch(/percentFrom|toPercent|asPercent/i);
		}
	});

	it("the module source contains no numeric literal beside an active reading", () => {
		const source = readFileSync(
			fileURLToPath(new URL("./encoder-load.ts", import.meta.url)),
			"utf8",
		);
		expect(source).not.toMatch(/active\s*\?\s*\d/);
		expect(source).not.toMatch(/active\s*&&\s*\d/);
	});

	it("a mainline reading never carries a percent field", () => {
		const reading = mockEncoderLoadAt("mainline", T, true);
		for (const core of reading.cores) {
			expect(core).not.toHaveProperty("percent");
		}
		expect(encoderLoadPrecision(reading)).toBe("binary");
	});
});

describe("the dev fixture", () => {
	it("defaults to the kernel the shipped image runs", () => {
		expect(parseEncoderLoadMockFlavor(null)).toBe(
			DEFAULT_ENCODER_LOAD_MOCK_FLAVOR,
		);
		expect(parseEncoderLoadMockFlavor("nonsense")).toBe(
			DEFAULT_ENCODER_LOAD_MOCK_FLAVOR,
		);
		expect(parseEncoderLoadMockFlavor("mainline")).toBe("mainline");
	});

	it("marks every synthetic reading as simulated", () => {
		expect(mockEncoderLoadAt("vendor", T, true).simulated).toBe(true);
		expect(mockEncoderLoadAt("mainline", T, false).simulated).toBe(true);
		expect(mockEncoderLoadAt("unavailable", T, true).simulated).toBe(false);
	});

	it("reproduces the measured idle state exactly — 0.00 on both cores", () => {
		const idle = mockEncoderLoadAt("vendor", T, false);
		expect(idle.cores).toEqual([
			{ core: "rkvenc0", kind: "percent", percent: 0 },
			{ core: "rkvenc1", kind: "percent", percent: 0 },
		]);
	});

	it("keeps vendor core 1 idle under load, as measured", () => {
		const busy = mockEncoderLoadAt("vendor", T, true);
		expect(busy.cores[1]).toEqual({
			core: "rkvenc1",
			kind: "percent",
			percent: 0,
		});
		const core0 = busy.cores[0];
		expect(core0?.kind).toBe("percent");
		if (core0?.kind === "percent") {
			expect(core0.percent).toBeGreaterThan(8);
			expect(core0.percent).toBeLessThan(15);
		}
	});

	it("mainline dispatches to BOTH cores under load — the observable difference", () => {
		const busy = mockEncoderLoadAt("mainline", T, true);
		expect(busy.cores).toEqual([
			{ core: "rkvenc0", kind: "active", active: true },
			{ core: "rkvenc1", kind: "active", active: true },
		]);
	});

	it("is deterministic in its inputs", () => {
		expect(mockEncoderLoadAt("vendor", T, true)).toEqual(
			mockEncoderLoadAt("vendor", T, true),
		);
	});

	it("the unavailable flavour IS the production floor", () => {
		expect(mockEncoderLoadAt("unavailable", T, true)).toBe(
			ENCODER_LOAD_UNAVAILABLE,
		);
	});
});
