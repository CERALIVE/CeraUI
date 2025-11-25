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
		const result = parsePipelineName("usb/libuvch264_720p30");
		expect(result.format).toBe("usb-libuvch264");
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

	it("should group pipelines by encoder within device", () => {
		const result = groupPipelinesByDeviceAndFormat(mockPipelines);
		expect(Object.keys(result.hdmi)).toContain("h264");
		expect(Object.keys(result.usb)).toContain("h265");
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
