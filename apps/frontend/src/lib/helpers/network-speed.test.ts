import { describe, expect, it } from "vitest";
import {
	convertBytesToKbids,
	formatThroughput,
	speedTier,
} from "./network-speed";

describe("network-speed helpers", () => {
	describe("convertBytesToKbids", () => {
		it("converts bytes to kilobits per second", () => {
			expect(convertBytesToKbids(128)).toBe(1); // (128 * 8) / 1024 = 1
			expect(convertBytesToKbids(1024)).toBe(8); // (1024 * 8) / 1024 = 8
			expect(convertBytesToKbids(131072)).toBe(1024); // (131072 * 8) / 1024 = 1024
		});

		it("rounds to nearest integer", () => {
			expect(convertBytesToKbids(100)).toBe(1); // (100 * 8) / 1024 = 0.78... → 1
			expect(convertBytesToKbids(200)).toBe(2); // (200 * 8) / 1024 = 1.56... → 2
		});

		it("handles zero", () => {
			expect(convertBytesToKbids(0)).toBe(0);
		});
	});

	describe("formatThroughput", () => {
		it('formats kbps below 1000 as "N kbps"', () => {
			expect(formatThroughput(0)).toBe("0 kbps");
			expect(formatThroughput(500)).toBe("500 kbps");
			expect(formatThroughput(999)).toBe("999 kbps");
		});

		it('formats kbps >= 1000 as "X.X Mbps"', () => {
			expect(formatThroughput(1000)).toBe("1.0 Mbps");
			expect(formatThroughput(1500)).toBe("1.5 Mbps");
			expect(formatThroughput(12345)).toBe("12.3 Mbps");
			expect(formatThroughput(10000)).toBe("10.0 Mbps");
		});

		it('returns "—" for null', () => {
			expect(formatThroughput(null)).toBe("—");
		});

		it('returns "—" for non-finite values', () => {
			expect(formatThroughput(NaN)).toBe("—");
			expect(formatThroughput(Infinity)).toBe("—");
			expect(formatThroughput(-Infinity)).toBe("—");
		});

		it("respects optional locale parameter", () => {
			// Locale parameter is accepted but not used in this implementation
			expect(formatThroughput(1000, "en-US")).toBe("1.0 Mbps");
			expect(formatThroughput(null, "de-DE")).toBe("—");
		});
	});

	describe("speedTier", () => {
		it('returns "weak" for null', () => {
			expect(speedTier(null)).toBe("weak");
		});

		it('returns "weak" for kbps < 1000', () => {
			expect(speedTier(0)).toBe("weak");
			expect(speedTier(500)).toBe("weak");
			expect(speedTier(999)).toBe("weak");
		});

		it('returns "fair" for 1000 <= kbps < 5000', () => {
			expect(speedTier(1000)).toBe("fair");
			expect(speedTier(2500)).toBe("fair");
			expect(speedTier(4999)).toBe("fair");
		});

		it('returns "good" for kbps >= 5000', () => {
			expect(speedTier(5000)).toBe("good");
			expect(speedTier(10000)).toBe("good");
			expect(speedTier(50000)).toBe("good");
		});

		it("handles boundary cases correctly", () => {
			// Boundary: 999 → weak, 1000 → fair
			expect(speedTier(999)).toBe("weak");
			expect(speedTier(1000)).toBe("fair");

			// Boundary: 4999 → fair, 5000 → good
			expect(speedTier(4999)).toBe("fair");
			expect(speedTier(5000)).toBe("good");
		});
	});
});
