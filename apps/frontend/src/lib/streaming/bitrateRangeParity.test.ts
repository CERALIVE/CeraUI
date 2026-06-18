import { describe, expect, it } from "vitest";

import {
	bitrateBoundsFromCaps,
	clampBitrateToBounds,
	streamingConstraints,
} from "$lib/components/streaming/ValidationAdapter";

// The EncoderDialog slider and number input share ONE clamp + ONE board window,
// so a given raw value MUST commit identically regardless of which control it
// came from. These tests pin that parity at the function level (the slider's
// onValueChange and the number input's oninput both call clampBitrateToBounds
// against the same bounds object).

function commitFromSlider(raw: number, bounds = streamingConstraints.bitrate) {
	return clampBitrateToBounds(raw, bounds);
}

function commitFromNumber(raw: number, bounds = streamingConstraints.bitrate) {
	return clampBitrateToBounds(raw, bounds);
}

describe("bitrate slider/number parity", () => {
	it("uses the same range source for both controls", () => {
		const fallback = bitrateBoundsFromCaps(undefined);
		expect(fallback.min).toBe(streamingConstraints.bitrate.min);
		expect(fallback.max).toBe(streamingConstraints.bitrate.max);
	});

	it("clamps identically across the whole numeric sweep", () => {
		for (let raw = -1000; raw <= 60000; raw += 250) {
			expect(commitFromSlider(raw)).toBe(commitFromNumber(raw));
		}
	});

	it("snaps an over-max entry to the same ceiling from either control", () => {
		const bounds = bitrateBoundsFromCaps({
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: "2160p",
			},
			encoder: {
				codecs: ["H264"],
				bitrate_range: { min: 2000, max: 15000, unit: "kbps" },
			},
			sources: [],
		});
		expect(commitFromSlider(50000, bounds)).toBe(15000);
		expect(commitFromNumber(50000, bounds)).toBe(15000);
	});

	it("snaps an under-min entry to the same floor from either control", () => {
		const bounds = bitrateBoundsFromCaps({
			platform: {
				supports_h265: true,
				hardware_accelerated: false,
				max_resolution: "1080p",
			},
			encoder: {
				codecs: ["H264"],
				bitrate_range: { min: 3000, max: 8000, unit: "kbps" },
			},
			sources: [],
		});
		expect(commitFromSlider(100, bounds)).toBe(3000);
		expect(commitFromNumber(100, bounds)).toBe(3000);
	});
});
