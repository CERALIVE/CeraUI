import { describe, expect, it } from "vitest";

import {
	bandSelectionChanged,
	deriveBandOffer,
	initialBandSelection,
	toggleBand,
} from "./modem-bands";

const OFFERED = {
	success: true,
	bands: {
		supported: ["eutran-1", "eutran-3", "eutran-7", "ngran-78"],
		current: ["any"],
		offerable: ["eutran-3", "eutran-7"],
		unlocked: true,
	},
} as const;

describe("deriveBandOffer", () => {
	it("offers exactly what the device said is offerable, never the supported set", () => {
		// `supported` is what the modem advertises; `offerable` is what a reviewer
		// proved can be left again. Rendering the first would offer a lock with no
		// evidence that it is reversible.
		const offer = deriveBandOffer(OFFERED);
		expect(offer.phase).toBe("offered");
		expect(offer.offerable).toEqual(["eutran-3", "eutran-7"]);
		expect(offer.unlocked).toBe(true);
	});

	it("WITHHOLDS with a keyed reason — never a raw wire token", () => {
		const offer = deriveBandOffer({ success: false, error: "uncertified" });
		expect(offer.phase).toBe("withheld");
		expect(offer.reasonKey).toBe("network.modem.bands.reason.uncertified");
		expect(offer.offerable).toEqual([]);
	});

	it("maps every refusal to its own key", () => {
		const refusals = [
			"unsupported",
			"uncertified",
			"module_disabled",
			"unknown_modem",
			"read_failed",
		] as const;
		const keys = refusals.map(
			(error) => deriveBandOffer({ success: false, error }).reasonKey,
		);
		expect(new Set(keys).size).toBe(refusals.length);
		expect(
			keys.every((key) => key?.startsWith("network.modem.bands.reason.")),
		).toBe(true);
	});

	it("an un-answered read is `unknown` and claims NOTHING about the modem", () => {
		// The distinction that matters: reporting this as `uncertified` would state
		// a certification fact nobody established.
		const offer = deriveBandOffer(undefined);
		expect(offer.phase).toBe("unknown");
		expect(offer.reasonKey).toBeUndefined();
	});

	it("a success carrying no bands block is `unknown`, not an empty offer", () => {
		expect(deriveBandOffer({ success: true }).phase).toBe("unknown");
	});
});

describe("toggleBand", () => {
	it("makes `any` exclusive — picking it clears every specific band", () => {
		expect(toggleBand(["eutran-3", "eutran-7"], "any")).toEqual(["any"]);
	});

	it("…and picking a specific band drops `any`", () => {
		expect(toggleBand(["any"], "eutran-3")).toEqual(["eutran-3"]);
	});

	it("adds and removes a specific band", () => {
		expect(toggleBand(["eutran-3"], "eutran-7")).toEqual([
			"eutran-3",
			"eutran-7",
		]);
		expect(toggleBand(["eutran-3", "eutran-7"], "eutran-3")).toEqual([
			"eutran-7",
		]);
	});

	it("deselecting the LAST band falls back to `any`, never to nothing", () => {
		// An empty selection is not a state a radio can be in, and Apply on one
		// would only ever produce a refusal.
		expect(toggleBand(["eutran-3"], "eutran-3")).toEqual(["any"]);
	});
});

describe("selection bookkeeping", () => {
	it("seeds from what the modem currently reports", () => {
		expect(initialBandSelection(deriveBandOffer(OFFERED))).toEqual(["any"]);
		expect(
			initialBandSelection(
				deriveBandOffer({
					success: true,
					bands: {
						supported: [],
						current: ["eutran-3"],
						offerable: ["eutran-3"],
						unlocked: false,
					},
				}),
			),
		).toEqual(["eutran-3"]);
	});

	it("falls back to `any` for a modem that reported no current band", () => {
		expect(initialBandSelection(deriveBandOffer(undefined))).toEqual(["any"]);
	});

	it("detects a change regardless of order", () => {
		expect(
			bandSelectionChanged(["eutran-3", "eutran-7"], ["eutran-7", "eutran-3"]),
		).toBe(false);
		expect(bandSelectionChanged(["any"], ["eutran-3"])).toBe(true);
		expect(bandSelectionChanged(["eutran-3"], ["eutran-3", "eutran-7"])).toBe(
			true,
		);
	});
});
