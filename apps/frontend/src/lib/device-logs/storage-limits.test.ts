import { describe, expect, it } from "vitest";

import {
	keepForOptions,
	limitFromValue,
	limitValue,
	maxSizeOptions,
	retentionDraft,
	sameRetention,
} from "./storage-limits";

describe("keepForOptions", () => {
	it.each([
		[30, [3, 7, 14, 30]],
		[14, [3, 7, 14]],
		[10, [3, 7, 10]],
		[7, [3, 7]],
		[5, [3, 5]],
		[3, [3]],
		[2, [2]],
		[1, [1]],
		[365, [3, 7, 14, 365]],
	])(
		"offers 3, 7, 14 and the ceiling itself, never above a %i-day ceiling",
		(ceiling, options) => {
			expect(keepForOptions(ceiling)).toEqual(options);
		},
	);
});

describe("maxSizeOptions", () => {
	it.each([
		[256, [32, 64, 128]],
		[128, [32, 64, 128]],
		[127, [32, 64]],
		[64, [32, 64]],
		[50, [32]],
		[32, [32]],
		[31, []],
		[16, []],
	])(
		"offers 32, 64 and 128 MB, never above a %i MB ceiling",
		(ceiling, options) => {
			expect(maxSizeOptions(ceiling)).toEqual(options);
		},
	);
});

describe("retentionDraft", () => {
	const ceiling = { maxAgeDays: 30, maxSizeMb: 256 };

	it("keeps saved limits that fit inside the ceiling, edges included", () => {
		expect(
			retentionDraft({
				ceiling,
				retention: { maxAgeDays: 30, maxSizeMb: 256, detail: "info" },
			}),
		).toEqual({ maxAgeDays: 30, maxSizeMb: 256, detail: "info" });
		expect(
			retentionDraft({
				ceiling,
				retention: { maxAgeDays: 1, maxSizeMb: 16, detail: "debug" },
			}),
		).toEqual({ maxAgeDays: 1, maxSizeMb: 16, detail: "debug" });
	});

	it("folds a limit above the ceiling back to the device limit, one axis at a time", () => {
		expect(
			retentionDraft({
				ceiling,
				retention: { maxAgeDays: 31, maxSizeMb: 64, detail: "debug" },
			}),
		).toEqual({ maxAgeDays: null, maxSizeMb: 64, detail: "debug" });
		expect(
			retentionDraft({
				ceiling,
				retention: { maxAgeDays: 7, maxSizeMb: 257, detail: "debug" },
			}),
		).toEqual({ maxAgeDays: 7, maxSizeMb: null, detail: "debug" });
	});

	it("drops every limit when the ceiling is unknown, keeping the detail", () => {
		expect(
			retentionDraft({
				ceiling: null,
				retention: { maxAgeDays: 7, maxSizeMb: 64, detail: "info" },
			}),
		).toEqual({ maxAgeDays: null, maxSizeMb: null, detail: "info" });
	});

	it("keeps the device limit as the device limit", () => {
		expect(
			retentionDraft({
				ceiling,
				retention: { maxAgeDays: null, maxSizeMb: null, detail: "debug" },
			}),
		).toEqual({ maxAgeDays: null, maxSizeMb: null, detail: "debug" });
	});
});

describe("sameRetention", () => {
	const base = { maxAgeDays: 7, maxSizeMb: 64, detail: "debug" } as const;

	it("is true only when all three fields match", () => {
		expect(sameRetention(base, { ...base })).toBe(true);
		expect(sameRetention(base, { ...base, maxAgeDays: 14 })).toBe(false);
		expect(sameRetention(base, { ...base, maxAgeDays: null })).toBe(false);
		expect(sameRetention(base, { ...base, maxSizeMb: 32 })).toBe(false);
		expect(sameRetention(base, { ...base, detail: "info" })).toBe(false);
	});
});

describe("limit select values", () => {
	it("round-trips the device limit and whole numbers", () => {
		expect(limitValue(null)).toBe("device");
		expect(limitValue(14)).toBe("14");
		expect(limitFromValue("device")).toBeNull();
		expect(limitFromValue("14")).toBe(14);
		for (const value of [null, 1, 3, 30, 256]) {
			expect(limitFromValue(limitValue(value))).toBe(value);
		}
	});
});
