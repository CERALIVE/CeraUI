import {
	CANONICAL_PRESETS,
	MEDIA_TYPE_H264,
	MEDIA_TYPE_H265,
	type OfferedSet,
} from "@ceraui/rpc";
import { describe, expect, it } from "vitest";

import { OPTION_UNSUPPORTED_ON_PLATFORM } from "$lib/components/streaming/ValidationAdapter";
import type { EncoderConfig } from "$main/dialogs/EncoderDialog.svelte";

import {
	findMatchingPresetId,
	MODE_PRESETS,
	presetToDraft,
	presetViews,
} from "./modePresets";

// The board's real bitrate window — presets clamp their default into it.
const wideBounds = {
	min: 2000,
	max: 12000,
	defaultMin: 4000,
	defaultMax: 9000,
};
// A low-cap board: the 4K preset's 8 Mbps default must clamp down to 5000.
const lowCapBounds = {
	min: 1000,
	max: 5000,
	defaultMin: 1000,
	defaultMax: 5000,
};

// A fully-permissive offered set: every resolution/framerate/codec on offer.
function offeredAll(): OfferedSet {
	return {
		resolutions: ["480p", "720p", "1080p", "1440p", "2160p"],
		framerates: [25, 29.97, 30, 50, 59.94, 60],
		codecs: [MEDIA_TYPE_H264, MEDIA_TYPE_H265],
		bitrateRange: { min: 2000, max: 12000, unit: "kbps" },
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
	};
}

// An H.264-only, 1080p-ceiling board: no H.265, no 4K.
function offeredH264Only(): OfferedSet {
	return {
		...offeredAll(),
		resolutions: ["480p", "720p", "1080p"],
		codecs: [MEDIA_TYPE_H264],
	};
}

// A draft as LiveView owns it (operator-set source + overlay).
function makeDraft(overrides: Partial<EncoderConfig> = {}): EncoderConfig {
	return {
		source: "hdmi",
		resolution: "720p",
		framerate: 30,
		bitrate: 5000,
		bitrateOverlay: true,
		...overrides,
	};
}

describe("presetToDraft — preset → draft field mapping", () => {
	it("writes the preset resolution and framerate onto the draft", () => {
		const next = presetToDraft(
			CANONICAL_PRESETS["1080p60-h264"],
			makeDraft(),
			wideBounds,
		);
		expect(next.resolution).toBe("1080p");
		expect(next.framerate).toBe(60);
	});

	it("seeds bitrate from the preset bitrateDefault (within the board window)", () => {
		const next = presetToDraft(
			CANONICAL_PRESETS["1080p60-h264"],
			makeDraft(),
			wideBounds,
		);
		// bitrateDefault 6000 sits inside 2000..12000 → carried as-is.
		expect(next.bitrate).toBe(6000);
	});

	it("clamps a preset bitrateDefault that exceeds the board ceiling", () => {
		const next = presetToDraft(
			CANONICAL_PRESETS["4k30-h265"],
			makeDraft(),
			lowCapBounds,
		);
		// 4K preset default 8000 → clamped to the 5000 board max.
		expect(next.bitrate).toBe(5000);
	});

	it("preserves the operator-owned source and overlay (codec is not a draft field)", () => {
		const next = presetToDraft(
			CANONICAL_PRESETS["4k30-h265"],
			makeDraft({ source: "uvc_h265", bitrateOverlay: false }),
			wideBounds,
		);
		expect(next.source).toBe("uvc_h265");
		expect(next.bitrateOverlay).toBe(false);
		expect("codec" in next).toBe(false);
	});

	it("does not mutate the input draft", () => {
		const draft = makeDraft();
		presetToDraft(CANONICAL_PRESETS["1080p60-h264"], draft, wideBounds);
		expect(draft.resolution).toBe("720p");
		expect(draft.framerate).toBe(30);
	});
});

describe("findMatchingPresetId — active-preset detection on seed", () => {
	it("returns the preset id when resolution + framerate match", () => {
		expect(findMatchingPresetId({ resolution: "1080p", framerate: 60 })).toBe(
			"1080p60-h264",
		);
	});

	it("returns null for a bespoke (Custom) combination", () => {
		expect(
			findMatchingPresetId({ resolution: "1440p", framerate: 50 }),
		).toBeNull();
	});

	it("is codec-aware: same res/fps, different codec disambiguates", () => {
		expect(
			findMatchingPresetId(
				{ resolution: "1080p", framerate: 30 },
				MEDIA_TYPE_H265,
			),
		).toBe("1080p30-h265");
		expect(
			findMatchingPresetId(
				{ resolution: "1080p", framerate: 30 },
				MEDIA_TYPE_H264,
			),
		).toBe("1080p30-h264");
	});
});

describe("presetViews — supported/disabled-with-reason verdict", () => {
	it("marks every preset supported on a fully-permissive offered set", () => {
		const views = presetViews(offeredAll());
		expect(views).toHaveLength(MODE_PRESETS.length);
		expect(views.every((v) => v.supported)).toBe(true);
		expect(views.every((v) => v.reason === undefined)).toBe(true);
	});

	it("disables H.265 / 4K presets (with a reason) on an H.264-only 1080p board", () => {
		const views = presetViews(offeredH264Only());
		const h265 = views.find((v) => v.preset.id === "1080p30-h265");
		const fourK = views.find((v) => v.preset.id === "4k30-h265");
		const h264 = views.find((v) => v.preset.id === "1080p60-h264");

		expect(h265?.supported).toBe(false);
		expect(h265?.reason).toBe(OPTION_UNSUPPORTED_ON_PLATFORM);
		expect(fourK?.supported).toBe(false);
		expect(fourK?.reason).toBe(OPTION_UNSUPPORTED_ON_PLATFORM);
		// A universal H.264 preset stays selectable.
		expect(h264?.supported).toBe(true);
		expect(h264?.reason).toBeUndefined();
	});

	it("never hides an unsupported preset — all are returned", () => {
		const views = presetViews(offeredH264Only());
		expect(views).toHaveLength(MODE_PRESETS.length);
	});
});
