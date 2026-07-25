import { describe, expect, it } from "vitest";
import type { LinkSignal } from "$lib/types/hud";
import { aggregateBondBandwidth, linkUpKbps } from "./bond-bandwidth";

function link(overrides: Partial<LinkSignal> = {}): LinkSignal {
	return {
		id: "wlan0",
		type: "wifi",
		linkIndex: 0,
		signal: 70,
		label: "WiFi",
		isConnected: true,
		isStale: false,
		throughputKbps: 0,
		rateTxKbps: null,
		rateRxKbps: null,
		enabled: true,
		connectionState: "connected",
		...overrides,
	};
}

describe("linkUpKbps", () => {
	it("reports the measured interface rate even when the stream-gated value is 0", () => {
		// The exact live regression: idle stream pins throughputKbps to 0 while the
		// link is genuinely carrying traffic.
		expect(linkUpKbps(link({ throughputKbps: 0, rateTxKbps: 4200 }))).toBe(
			4200,
		);
	});

	it("prefers the measured rate over the stream-gated value when both are set", () => {
		expect(linkUpKbps(link({ throughputKbps: 9999, rateTxKbps: 1500 }))).toBe(
			1500,
		);
	});

	it("falls back to the stream-gated value when no measured rate is reported", () => {
		expect(linkUpKbps(link({ throughputKbps: 800, rateTxKbps: null }))).toBe(
			800,
		);
	});

	it("reports 0 rather than NaN when neither value is available", () => {
		expect(linkUpKbps(link({ throughputKbps: null, rateTxKbps: null }))).toBe(
			0,
		);
	});
});

describe("aggregateBondBandwidth", () => {
	it("sums a non-zero consolidated total across every enabled link", () => {
		const result = aggregateBondBandwidth([
			link({ id: "wlan0", rateTxKbps: 1200, rateRxKbps: 300 }),
			link({ id: "eth0", type: "ethernet", rateTxKbps: 3400, rateRxKbps: 900 }),
		]);

		expect(result.upKbps).toBe(4600);
		expect(result.downKbps).toBe(1200);
		expect(result.hasDownstream).toBe(true);
	});

	it("excludes links the operator has toggled out of the bond", () => {
		const result = aggregateBondBandwidth([
			link({ id: "wlan0", rateTxKbps: 1000, rateRxKbps: 100 }),
			link({ id: "eth0", rateTxKbps: 5000, rateRxKbps: 500, enabled: false }),
		]);

		expect(result.upKbps).toBe(1000);
		expect(result.downKbps).toBe(100);
	});

	it("reports no downstream when the backend sends no receive rates", () => {
		const result = aggregateBondBandwidth([
			link({ throughputKbps: 700, rateTxKbps: null, rateRxKbps: null }),
		]);

		expect(result.upKbps).toBe(700);
		expect(result.downKbps).toBe(0);
		expect(result.hasDownstream).toBe(false);
	});

	it("is zero-safe for an empty bond", () => {
		expect(aggregateBondBandwidth([])).toEqual({
			upKbps: 0,
			downKbps: 0,
			hasDownstream: false,
		});
	});
});
