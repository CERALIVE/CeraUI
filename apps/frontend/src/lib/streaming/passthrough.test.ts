import type { DeviceMode } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";
import {
	captureModeCodecs,
	type PassthroughInputs,
	resolvePassthroughMode,
	sourceOffersCodec,
} from "./passthrough.ts";

const mode = (media_type: string): DeviceMode => ({
	width: 1920,
	height: 1080,
	framerates: [30],
	media_type,
});

const base: PassthroughInputs = {
	setting: "auto",
	sourceOffersOutputCodec: true,
	adaptiveActive: true,
};

describe("resolvePassthroughMode", () => {
	it("off always transcodes, even on a passthrough-capable source", () => {
		expect(resolvePassthroughMode({ ...base, setting: "off" })).toBe(
			"transcode",
		);
	});

	it("auto transcodes under active adaptive bitrate even when the source matches", () => {
		expect(
			resolvePassthroughMode({
				...base,
				setting: "auto",
				adaptiveActive: true,
			}),
		).toBe("transcode");
	});

	it("auto passes through on a matching source when adaptive is inactive", () => {
		expect(
			resolvePassthroughMode({
				...base,
				setting: "auto",
				adaptiveActive: false,
			}),
		).toBe("passthrough");
	});

	it("auto transcodes when the source cannot offer the output codec", () => {
		expect(
			resolvePassthroughMode({
				...base,
				setting: "auto",
				adaptiveActive: false,
				sourceOffersOutputCodec: false,
			}),
		).toBe("transcode");
	});

	it("force passes through on a matching source regardless of adaptive", () => {
		expect(
			resolvePassthroughMode({
				...base,
				setting: "force",
				adaptiveActive: true,
			}),
		).toBe("passthrough");
	});

	it("force on a non-matching source is forceUnavailable (start would fail typed)", () => {
		expect(
			resolvePassthroughMode({
				...base,
				setting: "force",
				sourceOffersOutputCodec: false,
			}),
		).toBe("forceUnavailable");
	});
});

describe("sourceOffersCodec", () => {
	it("uvc_h264 and coarse libuvch264 offer h264 only", () => {
		expect(sourceOffersCodec("uvc_h264", "h264")).toBe(true);
		expect(sourceOffersCodec("uvc_h264", "h265")).toBe(false);
		expect(sourceOffersCodec("libuvch264", "h264")).toBe(true);
	});

	it("uvc_h265 offers h265 only", () => {
		expect(sourceOffersCodec("uvc_h265", "h265")).toBe(true);
		expect(sourceOffersCodec("uvc_h265", "h264")).toBe(false);
	});

	it("mjpeg, camlink, hdmi, network and unknown never passthrough", () => {
		for (const kind of ["mjpeg", "camlink", "hdmi", "network", undefined]) {
			expect(sourceOffersCodec(kind, "h264")).toBe(false);
			expect(sourceOffersCodec(kind, "h265")).toBe(false);
		}
	});

	it("modes-derived offeredCodecs win over the collapsed kind: a dual device passes through BOTH", () => {
		const dual = ["h264", "h265"] as const;
		// The engine collapsed this device's kind to uvc_h265, but its modes
		// advertise both — so h264 passthrough must be eligible, not rejected.
		expect(sourceOffersCodec("uvc_h265", "h264", dual)).toBe(true);
		expect(sourceOffersCodec("uvc_h265", "h265", dual)).toBe(true);
	});

	it("an empty offeredCodecs falls back to the scalar-kind branch (old engine)", () => {
		expect(sourceOffersCodec("uvc_h264", "h264", [])).toBe(true);
		expect(sourceOffersCodec("uvc_h264", "h265", [])).toBe(false);
	});
});

describe("captureModeCodecs", () => {
	it("returns both codecs h264→h265 for a dual-capable device's modes", () => {
		expect(
			captureModeCodecs([mode("video/x-h265"), mode("video/x-h264")]),
		).toEqual(["h264", "h265"]);
	});

	it("returns the single codec for a single-codec device", () => {
		expect(captureModeCodecs([mode("video/x-h264")])).toEqual(["h264"]);
		expect(captureModeCodecs([mode("video/x-h265")])).toEqual(["h265"]);
	});

	it("returns [] for raw/MJPEG/empty/undefined modes", () => {
		expect(
			captureModeCodecs([mode("image/jpeg"), mode("video/x-raw")]),
		).toEqual([]);
		expect(captureModeCodecs([])).toEqual([]);
		expect(captureModeCodecs(undefined)).toEqual([]);
	});
});
