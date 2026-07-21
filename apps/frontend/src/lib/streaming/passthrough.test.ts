import { describe, expect, it } from "vitest";
import {
	type PassthroughInputs,
	resolvePassthroughMode,
	sourceOffersCodec,
} from "./passthrough.ts";

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
});
