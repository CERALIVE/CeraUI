import type { Pipeline } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	framerateOptions,
	OPTION_FIXED_BY_SOURCE,
	OPTION_UNSUPPORTED_ON_PLATFORM,
	offeredEncoderCaps,
	platformCapsForHardware,
	resolutionOptions,
	videoSourceCapFromPipeline,
} from "./ValidationAdapter";

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
	return {
		name: "HDMI Capture",
		description: "fixture",
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		defaultResolution: "1080p",
		defaultFramerate: 30,
		...overrides,
	};
}

describe("platformCapsForHardware", () => {
	it("caps the software fallback at 1080p", () => {
		expect(platformCapsForHardware("generic").max_resolution).toBe("1080p");
	});

	it("lets hardware-accelerated boards reach the 4K rung", () => {
		for (const hw of ["jetson", "rk3588", "n100"] as const) {
			expect(platformCapsForHardware(hw).max_resolution).toBe("2160p");
		}
	});

	it("defaults an unknown/absent board to the generic profile", () => {
		expect(platformCapsForHardware(undefined)).toEqual(
			platformCapsForHardware("generic"),
		);
	});
});

describe("videoSourceCapFromPipeline", () => {
	it("projects pipeline metadata onto the VideoSourceCap shape", () => {
		const cap = videoSourceCapFromPipeline("hdmi", makePipeline());
		expect(cap).toEqual({
			id: "hdmi",
			supports_audio: true,
			supports_resolution_override: true,
			supports_framerate_override: true,
			default_resolution: "1080p",
			default_framerate: 30,
		});
	});

	it("falls back to 1080p/30 when the pipeline omits defaults", () => {
		const cap = videoSourceCapFromPipeline(
			"hdmi",
			makePipeline({
				defaultResolution: undefined,
				defaultFramerate: undefined,
			}),
		);
		expect(cap.default_resolution).toBe("1080p");
		expect(cap.default_framerate).toBe(30);
	});
});

describe("offeredEncoderCaps", () => {
	it("offers the platform ladder up to the board ceiling for an override-capable source", () => {
		const offered = offeredEncoderCaps("generic", "hdmi", makePipeline());
		expect(offered.resolutions).toEqual(["480p", "720p", "1080p"]);
		expect(offered.framerates).toEqual([25, 29.97, 30, 50, 59.94, 60]);
	});

	it("extends the ladder to 4K on a hardware board", () => {
		const offered = offeredEncoderCaps("rk3588", "hdmi", makePipeline());
		expect(offered.resolutions).toContain("2160p");
	});

	it("collapses to the source default when the source forbids overrides", () => {
		const offered = offeredEncoderCaps(
			"rk3588",
			"libuvch264",
			makePipeline({
				supportsResolutionOverride: false,
				supportsFramerateOverride: false,
			}),
		);
		expect(offered.resolutions).toEqual(["1080p"]);
		expect(offered.framerates).toEqual([30]);
	});

	it("is permissive when no pipeline is selected (full platform ladder)", () => {
		const offered = offeredEncoderCaps("generic", undefined, undefined);
		expect(offered.resolutions).toEqual(["480p", "720p", "1080p"]);
		expect(offered.supportsResolutionOverride).toBe(true);
	});
});

describe("resolutionOptions", () => {
	it("marks above-ceiling rungs unsupported with a platform reason and keeps them in the list", () => {
		const offered = offeredEncoderCaps("generic", "hdmi", makePipeline());
		const options = resolutionOptions(offered);
		const values = options.map((o) => o.value);
		expect(values).toEqual(["480p", "720p", "1080p", "1440p", "2160p"]);

		const uhd = options.find((o) => o.value === "2160p");
		expect(uhd?.supported).toBe(false);
		expect(uhd?.reason).toBe(OPTION_UNSUPPORTED_ON_PLATFORM);
		expect(uhd?.reason).toBe("live.education.reason.unsupportedPlatform");
	});

	it("leaves a compatible rung selectable with no reason", () => {
		const offered = offeredEncoderCaps("generic", "hdmi", makePipeline());
		const fhd = resolutionOptions(offered).find((o) => o.value === "1080p");
		expect(fhd?.supported).toBe(true);
		expect(fhd?.reason).toBeUndefined();
	});

	it("attributes a fixed-source reason when the source forbids overrides", () => {
		const offered = offeredEncoderCaps(
			"rk3588",
			"libuvch264",
			makePipeline({ supportsResolutionOverride: false }),
		);
		const sd = resolutionOptions(offered).find((o) => o.value === "480p");
		expect(sd?.supported).toBe(false);
		expect(sd?.reason).toBe(OPTION_FIXED_BY_SOURCE);
	});
});

describe("framerateOptions", () => {
	it("disables every non-default rate with a fixed-source reason when the source pins framerate", () => {
		const offered = offeredEncoderCaps(
			"rk3588",
			"libuvch264",
			makePipeline({ supportsFramerateOverride: false, defaultFramerate: 30 }),
		);
		const options = framerateOptions(offered);
		expect(options.find((o) => o.value === 30)?.supported).toBe(true);
		const sixty = options.find((o) => o.value === 60);
		expect(sixty?.supported).toBe(false);
		expect(sixty?.reason).toBe(OPTION_FIXED_BY_SOURCE);
	});
});
