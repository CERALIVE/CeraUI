import { describe, expect, it } from "vitest";

import {
	CYCLE_DAY_OPTIONS,
	formatThresholdGb,
	isThresholdInvalid,
	readUsagePolicyForm,
	toUsagePolicyWireFields,
} from "./modem-usage-policy";

const GB = 1024 ** 3;

describe("readUsagePolicyForm", () => {
	it("seeds both fields from a device policy", () => {
		expect(
			readUsagePolicyForm({ cycle_day: 17, threshold_bytes: 10 * GB }),
		).toEqual({ cycleDay: "17", thresholdGb: "10" });
	});

	it("an unset field reads as empty, never as a fabricated default", () => {
		expect(readUsagePolicyForm(undefined)).toEqual({
			cycleDay: "",
			thresholdGb: "",
		});
		expect(readUsagePolicyForm({ cycle_day: 3 })).toEqual({
			cycleDay: "3",
			thresholdGb: "",
		});
	});

	it("a ZERO limit survives — it is a real setting, not an absent one", () => {
		expect(readUsagePolicyForm({ threshold_bytes: 0 })).toEqual({
			cycleDay: "",
			thresholdGb: "0",
		});
	});
});

describe("formatThresholdGb", () => {
	it("renders in the SAME unit the meter does, so a limit reads back unchanged", () => {
		expect(formatThresholdGb(5 * GB)).toBe("5");
		expect(formatThresholdGb(10 * GB)).toBe("10");
	});

	it("trims trailing zeros so a typed 5 comes back as 5, not 5.00", () => {
		expect(formatThresholdGb(GB)).toBe("1");
		expect(formatThresholdGb(1.5 * GB)).toBe("1.5");
	});

	it("a non-finite or negative byte count yields no value at all", () => {
		expect(formatThresholdGb(Number.NaN)).toBe("");
		expect(formatThresholdGb(-1)).toBe("");
	});
});

describe("isThresholdInvalid", () => {
	it("EMPTY is valid — it is how an operator says 'no limit'", () => {
		expect(isThresholdInvalid("")).toBe(false);
		expect(isThresholdInvalid("   ")).toBe(false);
	});

	it("accepts a plain and a fractional number, and zero", () => {
		expect(isThresholdInvalid("5")).toBe(false);
		expect(isThresholdInvalid("1.5")).toBe(false);
		expect(isThresholdInvalid("0")).toBe(false);
	});

	it("rejects a negative limit and anything that is not a number", () => {
		expect(isThresholdInvalid("-1")).toBe(true);
		expect(isThresholdInvalid("ten")).toBe(true);
	});
});

describe("toUsagePolicyWireFields", () => {
	it("projects both values as bytes and a day index", () => {
		expect(
			toUsagePolicyWireFields({ cycleDay: "17", thresholdGb: "10" }),
		).toEqual({
			data_usage_cycle_day: 17,
			data_usage_threshold_bytes: 10 * GB,
		});
	});

	it("EMPTY becomes an explicit null, so the device CLEARS rather than keeps", () => {
		expect(toUsagePolicyWireFields({ cycleDay: "", thresholdGb: "" })).toEqual({
			data_usage_cycle_day: null,
			data_usage_threshold_bytes: null,
		});
	});

	it("a zero limit is sent as zero, never collapsed into null", () => {
		expect(toUsagePolicyWireFields({ cycleDay: "", thresholdGb: "0" })).toEqual(
			{
				data_usage_cycle_day: null,
				data_usage_threshold_bytes: 0,
			},
		);
	});

	it("refuses to project a value the device would reject anyway", () => {
		expect(
			toUsagePolicyWireFields({ cycleDay: "0", thresholdGb: "" }),
		).toBeUndefined();
		expect(
			toUsagePolicyWireFields({ cycleDay: "32", thresholdGb: "" }),
		).toBeUndefined();
		expect(
			toUsagePolicyWireFields({ cycleDay: "", thresholdGb: "-1" }),
		).toBeUndefined();
	});

	it("round-trips a device policy back to the same bytes", () => {
		const form = readUsagePolicyForm({
			cycle_day: 28,
			threshold_bytes: 3 * GB,
		});
		expect(toUsagePolicyWireFields(form)).toEqual({
			data_usage_cycle_day: 28,
			data_usage_threshold_bytes: 3 * GB,
		});
	});
});

describe("CYCLE_DAY_OPTIONS", () => {
	it("offers every day the wire accepts, and no day it does not", () => {
		expect(CYCLE_DAY_OPTIONS).toHaveLength(31);
		expect(CYCLE_DAY_OPTIONS[0]).toBe(1);
		expect(CYCLE_DAY_OPTIONS.at(-1)).toBe(31);
	});
});
