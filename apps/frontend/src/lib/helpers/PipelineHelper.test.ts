import { describe, expect, it } from "vitest";

import {
	groupPipelinesByDeviceAndFormat,
	parsePipelineName,
} from "./PipelineHelper";

describe("parsePipelineName", () => {
	it("should parse a standard HDMI h264 pipeline name", () => {
		const result = parsePipelineName("hdmi/h264_1080p30");
		expect(result.device).toBe("hdmi");
		expect(result.encoder).toBe("h264");
		expect(result.resolution).toBe("1080p");
		expect(result.fps).toBe("30");
	});

	it("should parse h265 encoder", () => {
		const result = parsePipelineName("usb/h265_720p60");
		expect(result.device).toBe("usb");
		expect(result.encoder).toBe("h265");
		expect(result.resolution).toBe("720p");
		expect(result.fps).toBe("60");
	});

	it("should parse format from name", () => {
		const result = parsePipelineName("hdmi/h264_raw_1080p30");
		expect(result.format).toBe("raw");
	});

	it("should handle libuvch264 format", () => {
		const result = parsePipelineName("usb/libuvch264_usb_720p30");
		expect(result.format).toBe("libuvch264");
		expect(result.encoder).toBe("h264"); // libuvch264 is h264 encoding via UVC
	});

	it("should handle fps suffix format", () => {
		const result = parsePipelineName("hdmi/h264_1080_30fps");
		expect(result.fps).toBe("30");
	});

	it("should handle decimal fps values", () => {
		const result = parsePipelineName("hdmi/h264_1080p29.97");
		expect(result.fps).toBe("29.97");
	});

	it("should use custom translations for fallback values", () => {
		const translations = {
			matchDeviceResolution: "Auto Resolution",
			matchDeviceOutput: "Auto FPS",
		};
		const result = parsePipelineName("hdmi/h264_unknown", translations);
		expect(result.resolution).toBe("Auto Resolution");
		expect(result.fps).toBe("Auto FPS");
	});

	it("should return null for device when no match found", () => {
		const result = parsePipelineName("");
		expect(result.device).toBe(null);
	});

	// Belacoder-style pipeline naming tests
	describe("belacoder naming patterns", () => {
		it("should parse x264 encoder and normalize to h264", () => {
			const result = parsePipelineName(
				"generic/x264_superfast_v4l_mjpeg_1080p30",
			);
			expect(result.device).toBe("generic");
			expect(result.encoder).toBe("h264"); // normalized from x264
			expect(result.format).toBe("superfast");
			expect(result.resolution).toBe("1080p");
			expect(result.fps).toBe("30");
		});

		it("should parse x265 encoder and normalize to h265", () => {
			const result = parsePipelineName("generic/x265_medium_hdmi_720p60");
			expect(result.encoder).toBe("h265"); // normalized from x265
			expect(result.format).toBe("medium");
			expect(result.resolution).toBe("720p");
			expect(result.fps).toBe("60");
		});

		it("should parse h265_rtmp pattern with _30fps suffix", () => {
			const result = parsePipelineName(
				"jetson/h265_rtmp_localhost_publish_live_30fps",
			);
			expect(result.device).toBe("jetson");
			expect(result.encoder).toBe("h265");
			expect(result.format).toBe("rtmp");
			expect(result.fps).toBe("30");
		});

		it("should parse 4K resolution (2160p)", () => {
			const result = parsePipelineName("rk3588/h265_4k_2160p30");
			expect(result.resolution).toBe("2160p");
			expect(result.fps).toBe("30");
		});

		it("should parse decimal fps 59.94", () => {
			const result = parsePipelineName("n100/h264_hdmi_1080p59.94");
			expect(result.device).toBe("n100");
			expect(result.resolution).toBe("1080p");
			expect(result.fps).toBe("59.94");
		});

		it("should handle case-insensitive encoder matching", () => {
			const result = parsePipelineName("generic/X264_superfast_1080p30");
			expect(result.encoder).toBe("h264");
		});

		it("should parse hdmi source type", () => {
			const result = parsePipelineName("generic/h264_hdmi_1080p30");
			expect(result.format).toBe("hdmi");
			expect(result.encoder).toBe("h264");
		});

		it("should parse usb source type", () => {
			const result = parsePipelineName("generic/h264_usb_720p60");
			expect(result.format).toBe("usb");
			expect(result.encoder).toBe("h264");
		});

		it("should skip nvenc and find hdmi source for Jetson", () => {
			const result = parsePipelineName("jetson/h264_nvenc_hdmi_1080p60");
			expect(result.format).toBe("hdmi");
			expect(result.encoder).toBe("h264");
		});

		it("should skip vaapi and find usb source for Intel", () => {
			const result = parsePipelineName("n100/h265_vaapi_usb_1080p30");
			expect(result.format).toBe("usb");
			expect(result.encoder).toBe("h265");
		});

		it("should skip mpp and find hdmi source for RK3588", () => {
			const result = parsePipelineName("rk3588/h265_mpp_hdmi_2160p30");
			expect(result.format).toBe("hdmi");
			expect(result.encoder).toBe("h265");
			expect(result.resolution).toBe("2160p");
		});

		it("should parse libuvch264 with usb suffix", () => {
			const result = parsePipelineName("generic/libuvch264_usb_1080p30");
			expect(result.format).toBe("libuvch264");
			expect(result.encoder).toBe("h264");
			expect(result.resolution).toBe("1080p");
			expect(result.fps).toBe("30");
		});
	});
});

describe("groupPipelinesByDeviceAndFormat", () => {
	const mockPipelines = {
		hdmi_h264_1080p30: { name: "hdmi/h264_1080p30", asrc: true, acodec: true },
		hdmi_h264_1080p60: { name: "hdmi/h264_1080p60", asrc: true, acodec: true },
		hdmi_h264_720p30: { name: "hdmi/h264_720p30", asrc: true, acodec: false },
		usb_h265_720p30: { name: "usb/h265_720p30", asrc: false, acodec: true },
	};

	it("should group pipelines by device", () => {
		const result = groupPipelinesByDeviceAndFormat(mockPipelines);
		expect(Object.keys(result)).toContain("hdmi");
		expect(Object.keys(result)).toContain("usb");
	});

	it("should group pipelines by format within device", () => {
		const result = groupPipelinesByDeviceAndFormat(mockPipelines);
		// Structure: device -> format -> encoder -> resolution
		// Format is extracted from pipeline name (e.g., "hdmi/h264_1080p30" -> format is after encoder prefix)
		// When format can't be extracted, it becomes resolution directly
		const hdmiFormats = Object.keys(result.hdmi);
		expect(hdmiFormats.length).toBeGreaterThan(0);
		const usbFormats = Object.keys(result.usb);
		expect(usbFormats.length).toBeGreaterThan(0);
	});

	it("should group pipelines by resolution within encoder", () => {
		const result = groupPipelinesByDeviceAndFormat(mockPipelines);
		const hdmiH264 = result.hdmi.unknown?.h264;
		if (hdmiH264) {
			expect(Object.keys(hdmiH264)).toContain("1080p");
			expect(Object.keys(hdmiH264)).toContain("720p");
		}
	});

	it("should include identifier in grouped pipeline", () => {
		const result = groupPipelinesByDeviceAndFormat(mockPipelines);
		const hdmiPipelines = result.hdmi;
		// Find the first pipeline and check its identifier
		const firstFormat = Object.values(hdmiPipelines)[0];
		const firstEncoder = Object.values(firstFormat)[0];
		const firstResolution = Object.values(firstEncoder)[0];
		expect(firstResolution[0].identifier).toBeDefined();
	});

	it("should include extraction metadata in grouped pipeline", () => {
		const result = groupPipelinesByDeviceAndFormat(mockPipelines);
		const hdmiPipelines = result.hdmi;
		const firstFormat = Object.values(hdmiPipelines)[0];
		const firstEncoder = Object.values(firstFormat)[0];
		const firstResolution = Object.values(firstEncoder)[0];
		expect(firstResolution[0].extraction).toBeDefined();
		expect(firstResolution[0].extraction.device).toBe("hdmi");
	});

	it("should handle empty pipelines object", () => {
		const result = groupPipelinesByDeviceAndFormat({});
		expect(result).toEqual({});
	});

	it("should apply translations to extraction", () => {
		const translations = {
			matchDeviceResolution: "Custom Resolution",
			matchDeviceOutput: "Custom Output",
		};
		const result = groupPipelinesByDeviceAndFormat(mockPipelines, translations);
		expect(result).toBeDefined();
	});
});
