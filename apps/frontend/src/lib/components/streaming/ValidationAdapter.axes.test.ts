import type { DeviceModeGroup, Pipeline } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	axisCeiling,
	framerateOptions,
	framerateOptionsForResolution,
	OPTION_FIXED_BY_SOURCE,
	OPTION_UNSUPPORTED_AT_RESOLUTION,
	OPTION_UNSUPPORTED_ON_PLATFORM,
	offeredAxes,
	offeredEncoderCaps,
	resolutionOptions,
	resolveDeviceModes,
} from "./ValidationAdapter";

// An override-capable HDMI-like source (mirrors the ValidationAdapter.capabilities
// fixture) so device modes are what narrows the axes, not the source.
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

// One HDMI device (1080p@[30,60] + 2160p@[30]) and one UVC-H.264 device
// (720p@[30,60] + 1080p@[30]). `kind` bridges each device id to a pipeline id:
// hdmi→"hdmi", uvc_h264→"libuvch264".
const DEVICE_MODES: Record<string, DeviceModeGroup> = {
	"/dev/video0": {
		kind: "hdmi",
		modes: [
			{ width: 1920, height: 1080, framerates: [30, 60] },
			{ width: 3840, height: 2160, framerates: [30] },
		],
	},
	"/dev/video1": {
		kind: "uvc_h264",
		modes: [
			{ width: 1280, height: 720, framerates: [30, 60] },
			{ width: 1920, height: 1080, framerates: [30] },
		],
	},
};

describe("resolveDeviceModes", () => {
	it("returns undefined when the engine broadcasts no device_modes (coarse)", () => {
		expect(resolveDeviceModes(undefined, "hdmi", undefined)).toBeUndefined();
	});

	it("narrows to the explicitly selected device's modes (device selection wins)", () => {
		const modes = resolveDeviceModes(DEVICE_MODES, "hdmi", "/dev/video1");
		// Selected video1 even though the pipeline is hdmi — the operator's device
		// choice overrides the kind→pipeline union.
		expect(modes).toBe(DEVICE_MODES["/dev/video1"].modes);
	});

	it("falls back to coarse when the selected device id is unknown (never empty)", () => {
		expect(
			resolveDeviceModes(DEVICE_MODES, "hdmi", "/dev/does-not-exist"),
		).toBeUndefined();
	});

	it("falls back to coarse when the selected device advertises no modes", () => {
		const modes: Record<string, DeviceModeGroup> = {
			"/dev/video0": { kind: "hdmi", modes: [] },
		};
		expect(resolveDeviceModes(modes, "hdmi", "/dev/video0")).toBeUndefined();
	});

	it("unions the modes of every kind-matched device when no device is selected", () => {
		expect(resolveDeviceModes(DEVICE_MODES, "hdmi", undefined)).toEqual(
			DEVICE_MODES["/dev/video0"].modes,
		);
		expect(resolveDeviceModes(DEVICE_MODES, "libuvch264", undefined)).toEqual(
			DEVICE_MODES["/dev/video1"].modes,
		);
	});

	it("unions modes across MULTIPLE devices of the same kind", () => {
		const modes: Record<string, DeviceModeGroup> = {
			a: {
				kind: "hdmi",
				modes: [{ width: 1920, height: 1080, framerates: [30] }],
			},
			b: {
				kind: "hdmi",
				modes: [{ width: 3840, height: 2160, framerates: [30] }],
			},
		};
		const union = resolveDeviceModes(modes, "hdmi", undefined);
		expect(union).toHaveLength(2);
	});

	it("returns coarse for a non-device pipeline (rtmp/srt/test) — zero kind-matched", () => {
		expect(resolveDeviceModes(DEVICE_MODES, "rtmp", undefined)).toBeUndefined();
		expect(resolveDeviceModes(DEVICE_MODES, "srt", undefined)).toBeUndefined();
		expect(resolveDeviceModes(DEVICE_MODES, "test", undefined)).toBeUndefined();
	});

	it("returns coarse when no pipeline is selected and no device is pinned", () => {
		expect(
			resolveDeviceModes(DEVICE_MODES, undefined, undefined),
		).toBeUndefined();
	});
});

describe("offeredAxes — device-mode narrowing", () => {
	it("narrows resolutions + framerates to the kind-matched device union", () => {
		// rk3588 (2160p, H.265, hw accel) + hdmi source; the hdmi device does
		// 1080p@[30,60] + 2160p@[30], so the offered set is that union.
		const axes = offeredAxes(
			"rk3588",
			"hdmi",
			makePipeline(),
			DEVICE_MODES,
			undefined,
		);
		expect(axes.offered.resolutions).toEqual(["1080p", "2160p"]);
		expect(axes.offered.framerates).toEqual([30, 60]);
		expect(axes.deviceModes).toEqual(DEVICE_MODES["/dev/video0"].modes);
	});

	it("narrows to the pinned device's modes when selected_video_input is set", () => {
		// Pin the UVC device while the pipeline is hdmi: axes follow the device.
		const axes = offeredAxes(
			"rk3588",
			"hdmi",
			makePipeline(),
			DEVICE_MODES,
			"/dev/video1",
		);
		expect(axes.offered.resolutions).toEqual(["720p", "1080p"]);
		expect(axes.offered.framerates).toEqual([30, 60]);
	});

	it("uses the coarse offering for a non-device pipeline even with device_modes present", () => {
		const axes = offeredAxes(
			"rk3588",
			"rtmp",
			makePipeline(),
			DEVICE_MODES,
			undefined,
		);
		const coarse = offeredEncoderCaps("rk3588", "rtmp", makePipeline());
		expect(axes.offered).toEqual(coarse);
		expect(axes.deviceModes).toBeUndefined();
	});
});

describe("offeredAxes — no-caps fallback (byte-identical to today)", () => {
	it("is byte-identical to offeredEncoderCaps when device_modes is absent (with pipeline)", () => {
		const axes = offeredAxes(
			"rk3588",
			"hdmi",
			makePipeline(),
			undefined,
			undefined,
		);
		expect(axes.offered).toEqual(
			offeredEncoderCaps("rk3588", "hdmi", makePipeline()),
		);
		expect(axes.deviceModes).toBeUndefined();
	});

	it("is permissive (full ladder) with no pipeline AND no device_modes — minimal floor", () => {
		const axes = offeredAxes(
			"generic",
			undefined,
			undefined,
			undefined,
			undefined,
		);
		expect(axes.offered).toEqual(
			offeredEncoderCaps("generic", undefined, undefined),
		);
		// Every axis renders + gates coarsely: full candidate universe, 1080p ceiling.
		expect(resolutionOptions(axes.offered).map((o) => o.value)).toEqual([
			"480p",
			"720p",
			"1080p",
			"1440p",
			"2160p",
		]);
		expect(axes.offered.resolutions).toEqual(["480p", "720p", "1080p"]);
	});
});

describe("framerateOptionsForResolution — per-resolution gating", () => {
	it("keeps both rates at a resolution the device drives at 30 AND 60", () => {
		const axes = offeredAxes(
			"rk3588",
			"hdmi",
			makePipeline(),
			DEVICE_MODES,
			undefined,
		);
		const at1080 = framerateOptionsForResolution(axes, "1080p");
		expect(at1080.find((o) => o.value === 30)?.supported).toBe(true);
		expect(at1080.find((o) => o.value === 60)?.supported).toBe(true);
	});

	it("disables 60 at a resolution the device only drives at 30 — with the resolution reason", () => {
		const axes = offeredAxes(
			"rk3588",
			"hdmi",
			makePipeline(),
			DEVICE_MODES,
			undefined,
		);
		const at2160 = framerateOptionsForResolution(axes, "2160p");
		expect(at2160.find((o) => o.value === 30)?.supported).toBe(true);
		const sixty = at2160.find((o) => o.value === 60);
		expect(sixty?.supported).toBe(false);
		expect(sixty?.reason).toBe(OPTION_UNSUPPORTED_AT_RESOLUTION);
	});

	it("attributes a not-offered rate to the source/platform reason, not the resolution reason", () => {
		// A single 30-only device: 60 is not in the offered union at all, so the
		// reason is the coarse source/platform ceiling, NOT the per-resolution one.
		const modes: Record<string, DeviceModeGroup> = {
			"/dev/video0": {
				kind: "hdmi",
				modes: [{ width: 1920, height: 1080, framerates: [30] }],
			},
		};
		const axes = offeredAxes(
			"rk3588",
			"hdmi",
			makePipeline(),
			modes,
			undefined,
		);
		const sixty = framerateOptionsForResolution(axes, "1080p").find(
			(o) => o.value === 60,
		);
		expect(sixty?.supported).toBe(false);
		expect(sixty?.reason).toBe(OPTION_UNSUPPORTED_ON_PLATFORM);
	});

	it("falls back to coarse framerateOptions when there are no device modes", () => {
		const axes = offeredAxes(
			"rk3588",
			"hdmi",
			makePipeline(),
			undefined,
			undefined,
		);
		expect(framerateOptionsForResolution(axes, "1080p")).toEqual(
			framerateOptions(axes.offered),
		);
	});

	it("keeps a source-pinned framerate reason coarse (fixedBySource) with no device modes", () => {
		const axes = offeredAxes(
			"rk3588",
			"libuvch264",
			makePipeline({ supportsFramerateOverride: false, defaultFramerate: 30 }),
			undefined,
			undefined,
		);
		const sixty = framerateOptionsForResolution(axes, "1080p").find(
			(o) => o.value === 60,
		);
		expect(sixty?.supported).toBe(false);
		expect(sixty?.reason).toBe(OPTION_FIXED_BY_SOURCE);
	});
});

describe("axisCeiling — current-vs-device-max summary source", () => {
	it("reports the device union ceiling (2160p / 60) for the hdmi device", () => {
		const axes = offeredAxes(
			"rk3588",
			"hdmi",
			makePipeline(),
			DEVICE_MODES,
			undefined,
		);
		expect(axisCeiling(axes)).toEqual({ resolution: "2160p", framerate: 60 });
	});

	it("reports the coarse platform ceiling when no device modes narrow it", () => {
		const axes = offeredAxes(
			"generic",
			"hdmi",
			makePipeline(),
			undefined,
			undefined,
		);
		// generic tops out at 1080p; framerate ceiling is the full 60.
		expect(axisCeiling(axes)).toEqual({ resolution: "1080p", framerate: 60 });
	});

	it("returns undefined ceilings when the offered set is empty", () => {
		expect(
			axisCeiling({
				offered: {
					resolutions: [],
					framerates: [],
					codecs: [],
					bitrateRange: { min: 0, max: 0, unit: "kbps" },
					supportsAudio: true,
					supportsResolutionOverride: true,
					supportsFramerateOverride: true,
				},
				deviceModes: undefined,
			}),
		).toEqual({ resolution: undefined, framerate: undefined });
	});
});
