import type {
	CaptureStreamSource,
	CoarseStreamSource,
	DeviceMode,
	DeviceModeGroup,
	Pipeline,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	activeMediaTypeForModes,
	axisCeiling,
	framerateAvailableAt,
	framerateOptions,
	framerateOptionsForResolution,
	type OfferedAxes,
	OPTION_FIXED_BY_SOURCE,
	OPTION_UNSUPPORTED_AT_RESOLUTION,
	OPTION_UNSUPPORTED_ON_PLATFORM,
	offeredAxes,
	offeredEncoderCaps,
	resolutionOptions,
	resolveActiveMediaType,
	resolveDeviceModes,
	scopeModesToMediaType,
	seededAxisSelection,
	singleModeSourceCeiling,
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
	it("reports the ACHIEVABLE pair (2160p / 30) for the hdmi device — NOT 2160p/60", () => {
		// hdmi drives 1080p@[30,60] + 2160p@[30]. The highest rung is 2160p and it
		// runs at 30 ONLY, so the truthful device-max is 2160p/30 — never the
		// independent-axes lie 2160p/60 (60 lives at 1080p, not at 4K).
		const axes = offeredAxes(
			"rk3588",
			"hdmi",
			makePipeline(),
			DEVICE_MODES,
			undefined,
		);
		expect(axisCeiling(axes)).toEqual({ resolution: "2160p", framerate: 30 });
	});

	it("reports the achievable pair (1080p / 30) for a 1080p@[30] + 720p@[30,60] device", () => {
		// The multi-rate-divergence fixture (mirrors fixture-factory usb): the top
		// rung 1080p runs at 30 only, so the device-max is 1080p/30 — not 1080p/60.
		const axes = offeredAxes(
			"rk3588",
			"libuvch264",
			makePipeline(),
			DEVICE_MODES,
			"/dev/video1",
		);
		expect(axisCeiling(axes)).toEqual({ resolution: "1080p", framerate: 30 });
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

describe("framerateAvailableAt — per-option available-elsewhere hint", () => {
	// The 1080p@[30] + 720p@[30,60] fixture: 60 is offered ONLY at 720p, 50 nowhere.
	const usbAxes = offeredAxes(
		"rk3588",
		"libuvch264",
		makePipeline(),
		DEVICE_MODES,
		"/dev/video1",
	);

	it("finds the other rung that drives a rate disabled at the current one (60 → 720p)", () => {
		expect(framerateAvailableAt(usbAxes, 60, "1080p")).toBe("720p");
	});

	it("returns undefined for a rate available nowhere in the fixture (50, no hint)", () => {
		expect(framerateAvailableAt(usbAxes, 50, "1080p")).toBeUndefined();
	});

	it("returns undefined on the coarse path (no device modes to hint at)", () => {
		const coarse = offeredAxes(
			"rk3588",
			"hdmi",
			makePipeline(),
			undefined,
			undefined,
		);
		expect(framerateAvailableAt(coarse, 60, "1080p")).toBeUndefined();
	});
});

describe("framerateOptionsForResolution — per-option hint attachment", () => {
	// 1080p@[30] + 720p@[30,60]: at 1080p, 60 is disabled (offered elsewhere) and
	// 50 is disabled (offered nowhere). Only 60 carries a hint.
	const usbAxes = offeredAxes(
		"rk3588",
		"libuvch264",
		makePipeline(),
		DEVICE_MODES,
		"/dev/video1",
	);

	it("attaches a 720p hint to 60 disabled at 1080p (offered elsewhere)", () => {
		const sixty = framerateOptionsForResolution(usbAxes, "1080p").find(
			(o) => o.value === 60,
		);
		expect(sixty?.supported).toBe(false);
		expect(sixty?.reason).toBe(OPTION_UNSUPPORTED_AT_RESOLUTION);
		expect(sixty?.hint).toEqual({ fps: 60, resolution: "720p" });
	});

	it("attaches NO hint to 50 disabled everywhere (plain platform reason)", () => {
		const fifty = framerateOptionsForResolution(usbAxes, "1080p").find(
			(o) => o.value === 50,
		);
		expect(fifty?.supported).toBe(false);
		expect(fifty?.reason).toBe(OPTION_UNSUPPORTED_ON_PLATFORM);
		expect(fifty?.hint).toBeUndefined();
	});

	it("attaches NO hint to a supported rate (30 at 1080p)", () => {
		const thirty = framerateOptionsForResolution(usbAxes, "1080p").find(
			(o) => o.value === 30,
		);
		expect(thirty?.supported).toBe(true);
		expect(thirty?.hint).toBeUndefined();
	});
});

// A coarse StreamSource whose facets mirror the makePipeline() fixture but with an
// EMPTY modes list — the modes-absent (coarse) path the golden test locks.
const COARSE_HDMI_SOURCE: CoarseStreamSource = {
	origin: "coarse",
	id: "hdmi",
	pipelineId: "hdmi",
	labelKey: "settings.sources.hdmi",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "selectable",
	available: true,
};

// The RØDE capture source with its OWN enumerated modes (720p@[30,60] + 1080p@[30]),
// so the source-keyed lookup narrows the axes to exactly these — no union hack.
const RODE_CAPTURE_SOURCE: CaptureStreamSource = {
	origin: "capture",
	id: "usb",
	pipelineId: "libuvch264",
	kind: "uvc_h264",
	displayName: "RØDE HDMI to USB-C: RØDE HDMI",
	devicePath: "/dev/video1",
	modes: [
		{ width: 1280, height: 720, framerates: [30, 60] },
		{ width: 1920, height: 1080, framerates: [30] },
	],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "selectable",
	available: true,
};

// GOLDEN fixture: the pre-change coarse OfferedSet for rk3588 ∩ an override-capable
// hdmi source. A frozen literal so any drift (in intersectCaps OR the source→cap
// projection) fails BYTE-IDENTITY, not merely structural equality.
const FROZEN_COARSE_OFFERED = {
	resolutions: ["480p", "720p", "1080p", "1440p", "2160p"],
	framerates: [25, 29.97, 30, 50, 59.94, 60],
	codecs: ["video/x-h264", "video/x-h265"],
	bitrateRange: { min: 500, max: 50000, unit: "kbps" },
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
};

describe("offeredAxes — source-keyed (StreamSource) form", () => {
	it("GOLDEN: a modes-absent source yields axes byte-identical to the coarse snapshot", () => {
		// The unchanged legacy coarse path still equals the frozen snapshot ...
		expect(offeredEncoderCaps("rk3588", "hdmi", makePipeline())).toEqual(
			FROZEN_COARSE_OFFERED,
		);
		// ... and the refactored source-keyed offeredAxes reproduces it identically.
		const axes = offeredAxes("rk3588", COARSE_HDMI_SOURCE);
		expect(axes.offered).toEqual(FROZEN_COARSE_OFFERED);
		expect(axes.deviceModes).toBeUndefined();
	});

	it("narrows the axes to the source's OWN modes (single lookup, no union hack)", () => {
		const axes = offeredAxes("rk3588", RODE_CAPTURE_SOURCE);
		expect(axes.offered.resolutions).toEqual(["720p", "1080p"]);
		expect(axes.offered.framerates).toEqual([30, 60]);
		expect(axes.deviceModes).toBe(RODE_CAPTURE_SOURCE.modes);
	});

	it("an empty modes list falls back to coarse (never collapses an axis to nothing)", () => {
		const axes = offeredAxes("rk3588", COARSE_HDMI_SOURCE);
		expect(axes.offered.resolutions.length).toBeGreaterThan(0);
		expect(axes.deviceModes).toBeUndefined();
	});

	it("an undefined source is permissive — identical to the coarse no-source offering", () => {
		const axes = offeredAxes("rk3588", undefined);
		expect(axes.offered).toEqual(
			offeredEncoderCaps("rk3588", undefined, undefined),
		);
		expect(axes.deviceModes).toBeUndefined();
	});
});

describe("resolveDeviceModes — source-keyed (StreamSource) form", () => {
	it("reads the source's own modes directly (the single lookup)", () => {
		expect(resolveDeviceModes(RODE_CAPTURE_SOURCE)).toBe(
			RODE_CAPTURE_SOURCE.modes,
		);
	});

	it("returns undefined for an empty modes list (coarse fallback)", () => {
		expect(resolveDeviceModes(COARSE_HDMI_SOURCE)).toBeUndefined();
	});

	it("returns undefined for an undefined source", () => {
		expect(resolveDeviceModes(undefined)).toBeUndefined();
	});
});

// The RK3588 SoC HDMI-RX carrying a live 1080p59.94 signal — the shape the engine
// reports once it resolves a receiver's v4l2 range bounds into the mode actually on
// the cable. ONE resolution, ONE frame rate, and that rate is not the 30 fps a
// fresh config defaults to.
const SOC_HDMIRX_SOURCE: CaptureStreamSource = {
	origin: "capture",
	id: "/dev/video0",
	pipelineId: "hdmi",
	kind: "hdmi",
	displayName: "rk_hdmirx",
	devicePath: "/dev/video0",
	modes: [{ width: 1920, height: 1080, framerates: [59.94] }],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "selectable",
	available: true,
};

describe("offeredAxes — a reported signal is a CEILING, not an enumeration", () => {
	const axes = offeredAxes("rk3588", SOC_HDMIRX_SOURCE);

	it("offers every encode target at or below the signal", () => {
		// The defect: the receiver's single mode was intersected with the encode
		// target, so 1080p59.94 was the ONLY selectable pair and every lower rung
		// rendered disabled — even though the capture leg downscales/rate-converts.
		expect(axes.offered.resolutions).toEqual(["480p", "720p", "1080p"]);
		expect(axes.offered.framerates).toEqual([25, 29.97, 30, 50, 59.94]);
		// One mode applies uniformly, so there is no per-resolution divergence left
		// to refine — hence no device-mode list on the axes.
		expect(axes.deviceModes).toBeUndefined();
	});

	it("keeps every rung ABOVE the signal disabled (no upscaling what isn't there)", () => {
		const resolutions = resolutionOptions(axes.offered);
		for (const rung of ["1440p", "2160p"] as const) {
			const option = resolutions.find((o) => o.value === rung);
			expect(option?.supported).toBe(false);
			expect(option?.reason).toBe(OPTION_UNSUPPORTED_ON_PLATFORM);
		}
		const sixty = framerateOptions(axes.offered).find((o) => o.value === 60);
		expect(sixty?.supported).toBe(false);
		expect(sixty?.reason).toBe(OPTION_UNSUPPORTED_ON_PLATFORM);
	});

	it("keeps the rates selectable at a LOWER target resolution too", () => {
		// The second half of the defect: the per-resolution gate asked which rates
		// the source drives AT 720p — a rung the receiver never reports — so every
		// rate went disabled the moment a lower resolution was picked.
		const at720 = framerateOptionsForResolution(axes, "720p");
		expect(at720.find((o) => o.value === 30)?.supported).toBe(true);
		expect(at720.find((o) => o.value === 25)?.supported).toBe(true);
		expect(at720.find((o) => o.value === 60)?.supported).toBe(false);
	});

	it("still reports the signal itself as the informational device-max", () => {
		expect(axisCeiling(axes)).toEqual({
			resolution: "1080p",
			framerate: 59.94,
		});
	});

	it("leaves an ENUMERATED multi-mode source on the exact per-mode narrowing", () => {
		expect(singleModeSourceCeiling(RODE_CAPTURE_SOURCE.modes)).toBeUndefined();
		const enumerated = offeredAxes("rk3588", RODE_CAPTURE_SOURCE);
		expect(enumerated.offered.resolutions).toEqual(["720p", "1080p"]);
		expect(enumerated.offered.framerates).toEqual([30, 60]);
		expect(enumerated.deviceModes).toBe(RODE_CAPTURE_SOURCE.modes);
	});
});

describe("singleModeSourceCeiling", () => {
	it("collapses one mode repeated per media type into a single ceiling", () => {
		expect(
			singleModeSourceCeiling([
				{
					width: 1920,
					height: 1080,
					framerates: [59.94],
					media_type: "video/x-raw",
				},
				{
					width: 1920,
					height: 1080,
					framerates: [59.94],
					media_type: "video/x-h264",
				},
			]),
		).toEqual({ resolution: "1080p", framerate: 59.94 });
	});

	it("is fail-closed on a modeless source and on rungs that do not normalize", () => {
		expect(singleModeSourceCeiling(undefined)).toBeUndefined();
		expect(singleModeSourceCeiling([])).toBeUndefined();
		// A pre-DV-timings receiver reporting raw v4l2 range bounds: the rate snaps
		// to no rung, so nothing is widened.
		expect(
			singleModeSourceCeiling([
				{ width: 32768, height: 32768, framerates: [0] },
			]),
		).toBeUndefined();
	});
});

// A receiver whose reported signal sits BELOW the hardcoded 1080p/30 fallback on
// both axes — the case that still needs the seed reconciled downward.
const SD_HDMIRX_SOURCE: CaptureStreamSource = {
	...SOC_HDMIRX_SOURCE,
	modes: [{ width: 720, height: 480, framerates: [25] }],
};

describe("seededAxisSelection — reconciling a saved draft onto the active source", () => {
	it("keeps the 30 fps fallback on a 59.94 receiver — a lower target is genuinely offered", () => {
		// The signal is a ceiling, not an enumeration, so the hardcoded fallback is
		// drivable (the capture leg rate-converts 59.94 → 30) and stands untouched.
		const axes = offeredAxes("rk3588", SOC_HDMIRX_SOURCE);
		const seeded = seededAxisSelection(axes, {
			resolution: undefined,
			framerate: undefined,
		});
		expect(seeded).toEqual({ resolution: "1080p", framerate: 30 });
		// The invariant this case protects: the dialog opens VALID, never red.
		expect(axes.offered.resolutions).toContain(seeded.resolution);
		expect(
			framerateOptionsForResolution(axes, seeded.resolution).find(
				(option) => option.value === seeded.framerate,
			)?.supported,
		).toBe(true);
	});

	it("still reconciles DOWN when the signal sits below the fallback (480p25)", () => {
		// 30 fps and 1080p are both above this signal, so neither can be encoded and
		// the seed must move — otherwise the dialog opens aria-invalid with save
		// blocked before the operator has touched anything.
		const axes = offeredAxes("rk3588", SD_HDMIRX_SOURCE);
		expect(
			seededAxisSelection(axes, {
				resolution: undefined,
				framerate: undefined,
			}),
		).toEqual({ resolution: "480p", framerate: 25 });
	});

	it("NEVER rewrites a framerate the operator actually stored, offered or not", () => {
		// A stale explicit choice must keep surfacing as a flagged control and a
		// blocked save — the operator re-decides it, the UI does not decide for them.
		const axes = offeredAxes("rk3588", SOC_HDMIRX_SOURCE);
		expect(
			seededAxisSelection(axes, { resolution: "2160p", framerate: 30 }),
		).toEqual({ resolution: "2160p", framerate: 30 });
	});

	it("leaves the fallback alone when the source can already deliver it", () => {
		const axes = offeredAxes("rk3588", RODE_CAPTURE_SOURCE);
		expect(
			seededAxisSelection(axes, {
				resolution: undefined,
				framerate: undefined,
			}),
		).toEqual({ resolution: "1080p", framerate: 30 });
	});

	it("resolves the fallback rate AT the resolution the fallback landed on", () => {
		// RØDE drives 1080p at 30 and 720p at 30/60; the 1080p fallback stands and 30
		// is drivable there, so neither axis moves.
		const axes = offeredAxes("rk3588", RODE_CAPTURE_SOURCE);
		const seeded = seededAxisSelection(axes, {
			resolution: undefined,
			framerate: undefined,
		});
		expect(
			framerateOptionsForResolution(axes, seeded.resolution).find(
				(option) => option.value === seeded.framerate,
			)?.supported,
		).toBe(true);
	});

	it("keeps the fallback when nothing at all is offered", () => {
		const axes: OfferedAxes = {
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
		};
		expect(
			seededAxisSelection(axes, {
				resolution: undefined,
				framerate: undefined,
			}),
		).toEqual({ resolution: "1080p", framerate: 30 });
	});
});

// A camera advertising TWO disjoint hardware ladders under two media types — the
// shape `groupDeviceCaps()` already emits (it keys on width × height × media_type):
//   image/jpeg   → 1080p@[30,60] + 2160p@[30]
//   video/x-h264 →  720p@[30,60] + 1080p@[30]
// 1080p exists in BOTH and its rate lists DIFFER, which is exactly the overlap
// the union could not represent: 60 at 1080p is an MJPEG-only capability.
const DUAL_FORMAT_MODES: readonly DeviceMode[] = [
	{
		width: 1920,
		height: 1080,
		framerates: [30, 60],
		media_type: "image/jpeg",
	},
	{ width: 3840, height: 2160, framerates: [30], media_type: "image/jpeg" },
	{
		width: 1280,
		height: 720,
		framerates: [30, 60],
		media_type: "video/x-h264",
	},
	{ width: 1920, height: 1080, framerates: [30], media_type: "video/x-h264" },
];

function makeDualFormatSource(
	kind: CaptureStreamSource["kind"],
	modes: readonly DeviceMode[] = DUAL_FORMAT_MODES,
): CaptureStreamSource {
	return {
		...RODE_CAPTURE_SOURCE,
		id: `usb-${kind}`,
		kind,
		modes: [...modes],
	};
}

describe("activeMediaTypeForModes — which ladder the source kind commands", () => {
	it("resolves each UVC codec kind to its own media type", () => {
		expect(activeMediaTypeForModes(DUAL_FORMAT_MODES, "uvc_h264")).toBe(
			"video/x-h264",
		);
		expect(activeMediaTypeForModes(DUAL_FORMAT_MODES, "mjpeg")).toBe(
			"image/jpeg",
		);
	});

	it("resolves a raw-capture kind to video/x-raw, camlink included", () => {
		const rawAndJpeg: DeviceMode[] = [
			{
				width: 1920,
				height: 1080,
				framerates: [30],
				media_type: "video/x-raw",
			},
			{
				width: 1920,
				height: 1080,
				framerates: [60],
				media_type: "image/jpeg",
			},
		];
		expect(activeMediaTypeForModes(rawAndJpeg, "hdmi")).toBe("video/x-raw");
		expect(activeMediaTypeForModes(rawAndJpeg, "camlink")).toBe("video/x-raw");
	});

	it("narrows nothing when there is no ambiguity to resolve", () => {
		// Untagged modes (the shape every pre-media_type fixture carries) and a
		// single advertised media type both leave the offering exactly as it was.
		expect(
			activeMediaTypeForModes(RODE_CAPTURE_SOURCE.modes, "uvc_h264"),
		).toBeUndefined();
		expect(
			activeMediaTypeForModes(
				[
					{
						width: 1920,
						height: 1080,
						framerates: [30],
						media_type: "video/x-h264",
					},
				],
				"uvc_h264",
			),
		).toBeUndefined();
	});

	it("is fail-open for a kind that names none of the advertised media types", () => {
		// Never narrow on a guess: an unclassified kind keeps the permissive union.
		expect(
			activeMediaTypeForModes(DUAL_FORMAT_MODES, "uvc_h265"),
		).toBeUndefined();
		expect(
			activeMediaTypeForModes(DUAL_FORMAT_MODES, "mystery-kind"),
		).toBeUndefined();
		expect(
			activeMediaTypeForModes(DUAL_FORMAT_MODES, undefined),
		).toBeUndefined();
		expect(activeMediaTypeForModes(undefined, "uvc_h264")).toBeUndefined();
	});
});

describe("scopeModesToMediaType", () => {
	it("keeps only the named format's modes, plus every untagged one", () => {
		const mixed: DeviceMode[] = [
			...DUAL_FORMAT_MODES,
			{ width: 640, height: 480, framerates: [30] },
		];
		const scoped = scopeModesToMediaType(mixed, "video/x-h264");
		expect(scoped?.map((m) => m.media_type)).toEqual([
			"video/x-h264",
			"video/x-h264",
			undefined,
		]);
	});

	it("returns the input UNCHANGED when nothing is dropped", () => {
		expect(
			scopeModesToMediaType(RODE_CAPTURE_SOURCE.modes, "video/x-h264"),
		).toBe(RODE_CAPTURE_SOURCE.modes);
		expect(scopeModesToMediaType(DUAL_FORMAT_MODES, undefined)).toBe(
			DUAL_FORMAT_MODES,
		);
		expect(scopeModesToMediaType(undefined, "video/x-h264")).toBeUndefined();
	});

	it("falls back to the full list rather than emptying it", () => {
		expect(scopeModesToMediaType(DUAL_FORMAT_MODES, "video/x-vp9")).toBe(
			DUAL_FORMAT_MODES,
		);
	});
});

describe("offeredAxes — disjoint per-media-type ladders stay disjoint", () => {
	const h264Axes = offeredAxes("rk3588", makeDualFormatSource("uvc_h264"));
	const mjpegAxes = offeredAxes("rk3588", makeDualFormatSource("mjpeg"));

	it("records the media type each source actually negotiates", () => {
		expect(h264Axes.activeMediaType).toBe("video/x-h264");
		expect(mjpegAxes.activeMediaType).toBe("image/jpeg");
	});

	it("offers only the resolutions the active format reaches", () => {
		// 2160p is MJPEG-only and 720p is H.264-only; the union offered all three
		// rungs to both sources.
		expect(h264Axes.offered.resolutions).toEqual(["720p", "1080p"]);
		expect(mjpegAxes.offered.resolutions).toEqual(["1080p", "2160p"]);
	});

	it("THE BUG: 60 fps at 1080p belongs to MJPEG alone, never to H.264", () => {
		const h264At1080 = framerateOptionsForResolution(h264Axes, "1080p");
		expect(h264At1080.find((o) => o.value === 30)?.supported).toBe(true);
		const h264Sixty = h264At1080.find((o) => o.value === 60);
		expect(h264Sixty?.supported).toBe(false);
		expect(h264Sixty?.reason).toBe(OPTION_UNSUPPORTED_AT_RESOLUTION);

		// The same resolution on the same hardware, under the format that DOES
		// enumerate it — proof the two ladders are isolated, not globally clamped.
		const mjpegAt1080 = framerateOptionsForResolution(mjpegAxes, "1080p");
		expect(mjpegAt1080.find((o) => o.value === 60)?.supported).toBe(true);
		expect(mjpegAt1080.find((o) => o.value === 30)?.supported).toBe(true);
	});

	it("keeps each format's own per-resolution divergence", () => {
		const h264At720 = framerateOptionsForResolution(h264Axes, "720p");
		expect(h264At720.find((o) => o.value === 60)?.supported).toBe(true);

		const mjpegAt2160 = framerateOptionsForResolution(mjpegAxes, "2160p");
		expect(mjpegAt2160.find((o) => o.value === 30)?.supported).toBe(true);
		expect(mjpegAt2160.find((o) => o.value === 60)?.supported).toBe(false);
	});

	it("reports an achievable device-max within the active format", () => {
		expect(axisCeiling(h264Axes)).toEqual({
			resolution: "1080p",
			framerate: 30,
		});
		expect(axisCeiling(mjpegAxes)).toEqual({
			resolution: "2160p",
			framerate: 30,
		});
	});

	it("points the available-elsewhere hint at a rung the SAME format reaches", () => {
		// H.264 drives 60 at 720p only, so that is where the hint sends the
		// operator — never 1080p, which only MJPEG drives at 60.
		expect(framerateAvailableAt(h264Axes, 60, "1080p")).toBe("720p");
		expect(
			framerateOptionsForResolution(h264Axes, "1080p").find(
				(o) => o.value === 60,
			)?.hint,
		).toEqual({ fps: 60, resolution: "720p" });
		expect(framerateAvailableAt(mjpegAxes, 60, "2160p")).toBe("1080p");
	});

	it("stays permissive for a kind that matches no advertised format", () => {
		// uvc_h265 names a media type this camera never advertises: the offering
		// falls back to the union rather than collapsing to nothing.
		const unmatched = offeredAxes("rk3588", makeDualFormatSource("uvc_h265"));
		expect(unmatched.activeMediaType).toBeUndefined();
		expect(unmatched.offered.resolutions).toEqual(["720p", "1080p", "2160p"]);
	});

	it("leaves an UNTAGGED mode list byte-identical (old-engine payload)", () => {
		const untagged = offeredAxes("rk3588", RODE_CAPTURE_SOURCE);
		expect(untagged.activeMediaType).toBeUndefined();
		expect(untagged.deviceModes).toBe(RODE_CAPTURE_SOURCE.modes);
		expect(untagged.offered.resolutions).toEqual(["720p", "1080p"]);
		expect(untagged.offered.framerates).toEqual([30, 60]);
	});
});

describe("resolveActiveMediaType — legacy device_modes form", () => {
	const DUAL_FORMAT_GROUPS: Record<string, DeviceModeGroup> = {
		"/dev/video0": { kind: "mjpeg", modes: [...DUAL_FORMAT_MODES] },
		"/dev/video1": { kind: "uvc_h264", modes: [...DUAL_FORMAT_MODES] },
		"/dev/video2": { kind: "uvc_h265", modes: [...DUAL_FORMAT_MODES] },
	};

	it("follows the PINNED device's own kind", () => {
		expect(
			resolveActiveMediaType(DUAL_FORMAT_GROUPS, "hdmi", "/dev/video1"),
		).toBe("video/x-h264");
		expect(
			resolveActiveMediaType(DUAL_FORMAT_GROUPS, "hdmi", "/dev/video0"),
		).toBe("image/jpeg");
	});

	it("narrows nothing for a pipeline that bridges two kinds at once", () => {
		// `libuvch264` bridges BOTH uvc_h264 and uvc_h265, so the kind-matched
		// union has no single governing format — the permissive union stands.
		expect(
			resolveActiveMediaType(DUAL_FORMAT_GROUPS, "libuvch264", undefined),
		).toBeUndefined();
	});

	it("narrows nothing with no device_modes, no pipeline, or an unknown pin", () => {
		expect(
			resolveActiveMediaType(undefined, "hdmi", undefined),
		).toBeUndefined();
		expect(
			resolveActiveMediaType(DUAL_FORMAT_GROUPS, undefined, undefined),
		).toBeUndefined();
		expect(
			resolveActiveMediaType(DUAL_FORMAT_GROUPS, "hdmi", "/dev/nope"),
		).toBeUndefined();
	});

	it("reads a StreamSource's own kind in the source-keyed form", () => {
		expect(resolveActiveMediaType(makeDualFormatSource("mjpeg"))).toBe(
			"image/jpeg",
		);
		expect(resolveActiveMediaType(RODE_CAPTURE_SOURCE)).toBeUndefined();
		expect(resolveActiveMediaType(COARSE_HDMI_SOURCE)).toBeUndefined();
		expect(resolveActiveMediaType(undefined)).toBeUndefined();
	});

	it("gates the legacy axes path on the pinned device's format", () => {
		const pinned = offeredAxes(
			"rk3588",
			"hdmi",
			makePipeline(),
			DUAL_FORMAT_GROUPS,
			"/dev/video1",
		);
		expect(pinned.activeMediaType).toBe("video/x-h264");
		expect(pinned.offered.resolutions).toEqual(["720p", "1080p"]);
		expect(
			framerateOptionsForResolution(pinned, "1080p").find((o) => o.value === 60)
				?.supported,
		).toBe(false);
	});
});
