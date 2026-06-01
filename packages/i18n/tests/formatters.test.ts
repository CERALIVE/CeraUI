import { describe, expect, it } from "bun:test";

import {
	createFormatters,
	formatBitrate,
	formatCurrent,
	formatPercent,
	formatRelativeTime,
	formatTemp,
	formatVoltage,
} from "../src/formatters.js";

describe("formatBitrate", () => {
	it("renders sub-1000 kbps as kbps", () => {
		expect(formatBitrate("en")(850)).toBe("850 kbps");
	});

	it("promotes >=1000 kbps to Mbps with one fractional digit", () => {
		expect(formatBitrate("en")(1500)).toBe("1.5 Mbps");
	});

	it("rounds kbps and keeps Mbps to one decimal", () => {
		expect(formatBitrate("en")(849.6)).toBe("850 kbps");
		expect(formatBitrate("en")(1000)).toBe("1 Mbps");
		expect(formatBitrate("en")(12000)).toBe("12 Mbps");
	});

	it("handles non-finite input gracefully", () => {
		expect(formatBitrate("en")(Number.NaN)).toBe("—");
	});
});

describe("formatTemp", () => {
	it("appends the Celsius unit and keeps one decimal", () => {
		const out = formatTemp("en")(43.2);
		expect(out).toContain("43.2");
		expect(out).toContain("°C");
		expect(out).toBe("43.2 °C");
	});
});

describe("formatVoltage / formatCurrent", () => {
	it("formats voltage in volts", () => {
		expect(formatVoltage("en")(12.1)).toBe("12.1 V");
	});

	it("formats current in amperes", () => {
		expect(formatCurrent("en")(2.3)).toBe("2.3 A");
	});
});

describe("formatPercent", () => {
	it("renders a whole-number percent input as a percentage string", () => {
		expect(formatPercent("en")(87)).toBe("87%");
	});

	it("clamps fractional input to whole percent", () => {
		expect(formatPercent("en")(87.4)).toBe("87%");
		expect(formatPercent("en")(100)).toBe("100%");
	});
});

describe("formatRelativeTime", () => {
	it("returns 'just now' within the recency window", () => {
		expect(formatRelativeTime("en")(new Date(Date.now() - 2000))).toBe(
			"just now",
		);
	});

	it("formats minutes ago in English", () => {
		const out = formatRelativeTime("en")(new Date(Date.now() - 120_000));
		expect(out.length).toBeGreaterThan(0);
		expect(out).toContain("2");
	});

	it("produces non-empty localized strings for de, ar, ja", () => {
		const past = new Date(Date.now() - 5 * 60_000);
		for (const locale of ["de", "ar", "ja"] as const) {
			const out = formatRelativeTime(locale)(past);
			expect(typeof out).toBe("string");
			expect(out.trim().length).toBeGreaterThan(0);
		}
	});
});

describe("createFormatters", () => {
	it("binds every formatter to a single locale", () => {
		const f = createFormatters("en");
		expect(f.bitrate(850)).toBe("850 kbps");
		expect(f.temp(43.2)).toBe("43.2 °C");
		expect(f.voltage(12.1)).toBe("12.1 V");
		expect(f.current(2.3)).toBe("2.3 A");
		expect(f.percent(87)).toBe("87%");
		expect(typeof f.relativeTime(new Date())).toBe("string");
	});
});
