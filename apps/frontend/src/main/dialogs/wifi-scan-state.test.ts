import { describe, expect, it } from "vitest";

import {
	deriveWifiScanState,
	type WifiScanState,
	type WifiScanStateInput,
	wifiScanFreshnessKey,
	wifiScanResultsSuperseded,
} from "./wifi-scan-state";

const SETTLED: WifiScanStateInput = {
	scanInFlight: false,
	manualScan: false,
	scanFailed: false,
	resultCount: 0,
};

const state = (over: Partial<WifiScanStateInput>): WifiScanState =>
	deriveWifiScanState({ ...SETTLED, ...over });

describe("the empty-list register is byte-identical to the pre-freshness surface", () => {
	it("an operator's own scan with nothing on screen is `scanning`", () => {
		expect(state({ manualScan: true, scanInFlight: true })).toBe("scanning");
	});

	it("a failed scan with nothing on screen is `error`", () => {
		expect(state({ scanFailed: true })).toBe("error");
	});

	it("a settled scan that found nothing is `empty`", () => {
		expect(state({})).toBe("empty");
	});

	it("the operator's scan outranks a previous failure, as it always did", () => {
		expect(
			state({ manualScan: true, scanInFlight: true, scanFailed: true }),
		).toBe("scanning");
	});

	// The poll runs every 22 s. Driving the full-panel spinner from it would flip
	// an adapter that genuinely sees nothing between "Searching…" and "No networks
	// found" for as long as the dialog stays open, so a BACKGROUND tick over an
	// empty list must read exactly as the settled state it interrupts.
	it("a background tick never drives the empty-list spinner", () => {
		expect(state({ scanInFlight: true, manualScan: false })).toBe("empty");
		expect(
			state({ scanInFlight: true, manualScan: false, scanFailed: true }),
		).toBe("error");
	});
});

describe("results on screen carry their own supersession register", () => {
	it("a scan in flight means the visible rows are being replaced", () => {
		expect(
			state({ resultCount: 4, scanInFlight: true, manualScan: true }),
		).toBe("refreshing");
	});

	// The whole point of the `scanInFlight` input: a background tick replaces the
	// list just as completely as a tap does, and the operator is looking at rows
	// they may be about to act on.
	it("a BACKGROUND scan supersedes the rows exactly as a manual one does", () => {
		expect(
			state({ resultCount: 4, scanInFlight: true, manualScan: false }),
		).toBe("refreshing");
	});

	// The honesty hole this closes: `wifi-scan-error` only ever renders in the
	// empty-list branch, so before this a failing background tick left a
	// fresh-looking list on screen with no marker at all.
	it("a failed scan with rows on screen is `stale`, not silence", () => {
		expect(state({ resultCount: 4, scanFailed: true })).toBe("stale");
	});

	it("a settled list with rows on screen says nothing", () => {
		expect(state({ resultCount: 4 })).toBe("settled");
	});

	it("an in-flight scan outranks a previous failure", () => {
		expect(
			state({ resultCount: 4, scanInFlight: true, scanFailed: true }),
		).toBe("refreshing");
	});
});

describe("only a superseded list is qualified", () => {
	it("names copy for exactly the two supersession states", () => {
		expect(wifiScanFreshnessKey("refreshing")).toBe(
			"wifiSelector.freshness.refreshing",
		);
		expect(wifiScanFreshnessKey("stale")).toBe("wifiSelector.freshness.stale");
	});

	// `settled` is the honest silent case; the three empty-list states already
	// render a full panel of their own, so marking them would say it twice.
	it("names no copy for the settled or empty-list states", () => {
		for (const quiet of ["settled", "scanning", "error", "empty"] as const) {
			expect(wifiScanFreshnessKey(quiet)).toBeUndefined();
		}
	});

	it("dims the count for exactly the states that name copy", () => {
		const all: WifiScanState[] = [
			"scanning",
			"refreshing",
			"error",
			"stale",
			"empty",
			"settled",
		];
		for (const s of all) {
			expect(wifiScanResultsSuperseded(s)).toBe(
				wifiScanFreshnessKey(s) !== undefined,
			);
		}
	});
});
