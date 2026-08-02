import type {
	CaptureStreamSource,
	CoarseStreamSource,
	DeviceMode,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	captureModeOptions,
	governingInputMode,
	inputModeLabelKey,
	ladderForInputMode,
} from "./capture-modes";

const H264_LADDER: DeviceMode[] = [
	{
		width: 1280,
		height: 720,
		framerates: [30, 60],
		media_type: "video/x-h264",
	},
	{ width: 1920, height: 1080, framerates: [30], media_type: "video/x-h264" },
];
// Deliberately REACHES HIGHER than the H.264 ladder on both axes: the whole point
// of scoping is that a consumer must never be able to pair 1080p with 60 fps by
// borrowing the rung from the other format.
const MJPEG_LADDER: DeviceMode[] = [
	{ width: 1920, height: 1080, framerates: [30, 60], media_type: "image/jpeg" },
	{ width: 3840, height: 2160, framerates: [30], media_type: "image/jpeg" },
];

function dualFormat(
	overrides: Partial<CaptureStreamSource> = {},
): CaptureStreamSource {
	return {
		origin: "capture",
		id: "usb",
		pipelineId: "libuvch264",
		kind: "uvc_h264",
		displayName: "DJIPocket3: OsmoPocket3",
		devicePath: "/dev/video2",
		modes: [...H264_LADDER, ...MJPEG_LADDER],
		inputModes: [
			{
				inputMode: "uvc_h264",
				mediaType: "video/x-h264",
				pipelineId: "libuvch264",
				modes: H264_LADDER,
			},
			{
				inputMode: "mjpeg",
				mediaType: "image/jpeg",
				pipelineId: "usb_mjpeg",
				modes: MJPEG_LADDER,
			},
		],
		selectedInputMode: "uvc_h264",
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "selectable",
		available: true,
		...overrides,
	};
}

const COARSE: CoarseStreamSource = {
	origin: "coarse",
	id: "hdmi",
	pipelineId: "hdmi",
	labelKey: "settings.sources.hdmi",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: "selectable",
	available: true,
};

describe("inputModeLabelKey", () => {
	it("resolves into the EXISTING per-kind key family, not a new one", () => {
		expect(inputModeLabelKey("mjpeg")).toBe("live.inputPicker.groups.mjpeg");
		expect(inputModeLabelKey("uvc_h264")).toBe(
			"live.inputPicker.groups.uvc_h264",
		);
	});
});

describe("captureModeOptions", () => {
	it("offers every advertised family for a genuinely multi-format device", () => {
		expect(captureModeOptions(dualFormat()).map((m) => m.inputMode)).toEqual([
			"uvc_h264",
			"mjpeg",
		]);
	});

	it("offers NOTHING for a single-format device — one option is not a choice", () => {
		const single = dualFormat({
			inputModes: [
				{
					inputMode: "uvc_h264",
					mediaType: "video/x-h264",
					pipelineId: "libuvch264",
					modes: H264_LADDER,
				},
			],
		});
		expect(captureModeOptions(single)).toEqual([]);
	});

	it("offers nothing for a pre-0.11.0 engine that reported no split", () => {
		const legacy = dualFormat();
		delete legacy.inputModes;
		expect(captureModeOptions(legacy)).toEqual([]);
	});

	it("offers nothing for a non-capture origin or an absent source", () => {
		expect(captureModeOptions(COARSE)).toEqual([]);
		expect(captureModeOptions(undefined)).toEqual([]);
	});
});

describe("governingInputMode", () => {
	it("honours a draft pick the device ADVERTISES", () => {
		expect(governingInputMode(dualFormat(), "mjpeg")).toBe("mjpeg");
	});

	it("REFUSES a draft the device does not advertise, keeping the engine's answer", () => {
		expect(governingInputMode(dualFormat(), "camlink")).toBe("uvc_h264");
	});

	it("falls back to the engine's own selectedInputMode with no draft", () => {
		expect(governingInputMode(dualFormat())).toBe("uvc_h264");
		expect(governingInputMode(dualFormat({ selectedInputMode: "mjpeg" }))).toBe(
			"mjpeg",
		);
	});

	it("answers undefined when nothing names a format — nothing narrows", () => {
		const bare = dualFormat();
		delete bare.inputModes;
		delete bare.selectedInputMode;
		expect(governingInputMode(bare)).toBeUndefined();
		expect(governingInputMode(COARSE)).toBeUndefined();
	});
});

describe("ladderForInputMode", () => {
	it("returns the SELECTED family's ladder alone — never the union", () => {
		expect(ladderForInputMode(dualFormat())).toEqual(H264_LADDER);
		expect(ladderForInputMode(dualFormat(), "mjpeg")).toEqual(MJPEG_LADDER);
	});

	it("never lets one format borrow the other's rungs", () => {
		const h264 = ladderForInputMode(dualFormat(), "uvc_h264") ?? [];
		// 1080p60 and 4K exist on this DEVICE, but only under MJPEG. An H.264 leg
		// offered either would fail `not-negotiated` at the capture leg.
		expect(
			h264.some((m) => m.height === 1080 && m.framerates.includes(60)),
		).toBe(false);
		expect(h264.some((m) => m.height === 2160)).toBe(false);

		const mjpeg = ladderForInputMode(dualFormat(), "mjpeg") ?? [];
		expect(
			mjpeg.some((m) => m.height === 1080 && m.framerates.includes(60)),
		).toBe(true);
		expect(mjpeg.some((m) => m.height === 2160)).toBe(true);
	});

	it("fails OPEN on an empty family ladder — an unknown never subtracts", () => {
		const emptyFamily = dualFormat({
			inputModes: [
				{
					inputMode: "uvc_h264",
					mediaType: "video/x-h264",
					pipelineId: "libuvch264",
					modes: [],
				},
				{
					inputMode: "mjpeg",
					mediaType: "image/jpeg",
					pipelineId: "usb_mjpeg",
					modes: MJPEG_LADDER,
				},
			],
		});
		expect(ladderForInputMode(emptyFamily, "uvc_h264")).toBeUndefined();
	});

	it("returns undefined for a device that reported no split (legacy path intact)", () => {
		const legacy = dualFormat();
		delete legacy.inputModes;
		expect(ladderForInputMode(legacy)).toBeUndefined();
		expect(ladderForInputMode(COARSE)).toBeUndefined();
	});
});
