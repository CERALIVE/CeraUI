import { describe, expect, it } from "vitest";

import { autoSelectNextOption } from "./StreamingAutoSelection";

// Mock data for testing
const createMockGroupedPipelines = () => ({
	hdmi: {
		h264: {
			"1080p": [
				{
					name: "hdmi/h264_1080p30",
					asrc: true,
					acodec: true,
					identifier: "hdmi_h264_1080p30",
					extraction: {
						device: "hdmi",
						encoder: "h264",
						format: null,
						resolution: "1080p",
						fps: "30",
					},
				},
				{
					name: "hdmi/h264_1080p60",
					asrc: true,
					acodec: true,
					identifier: "hdmi_h264_1080p60",
					extraction: {
						device: "hdmi",
						encoder: "h264",
						format: null,
						resolution: "1080p",
						fps: "60",
					},
				},
			],
			"720p": [
				{
					name: "hdmi/h264_720p30",
					asrc: true,
					acodec: true,
					identifier: "hdmi_h264_720p30",
					extraction: {
						device: "hdmi",
						encoder: "h264",
						format: null,
						resolution: "720p",
						fps: "30",
					},
				},
			],
		},
		h265: {
			"1080p": [
				{
					name: "hdmi/h265_1080p30",
					asrc: true,
					acodec: true,
					identifier: "hdmi_h265_1080p30",
					extraction: {
						device: "hdmi",
						encoder: "h265",
						format: null,
						resolution: "1080p",
						fps: "30",
					},
				},
			],
		},
	},
});

// Simple mock with single option at each level for auto-selection tests
const createSingleOptionMock = () => ({
	usb: {
		h264: {
			"720p": [
				{
					name: "usb/h264_720p30",
					asrc: true,
					acodec: true,
					identifier: "usb_h264_720p30",
					extraction: {
						device: "usb",
						encoder: "h264",
						format: null,
						resolution: "720p",
						fps: "30",
					},
				},
			],
		},
	},
});

describe("autoSelectNextOption", () => {
	describe("when groupedPipelines is undefined", () => {
		it("should return empty object", () => {
			const result = autoSelectNextOption(
				"encoder",
				{
					inputMode: "hdmi",
					encoder: undefined,
					resolution: undefined,
					framerate: undefined,
					pipeline: undefined,
				},
				undefined,
			);
			expect(result).toEqual({});
		});
	});

	describe("when inputMode is undefined", () => {
		it("should return all fields as undefined", () => {
			const result = autoSelectNextOption(
				"encoder",
				{
					inputMode: undefined,
					encoder: "h264",
					resolution: "1080p",
					framerate: "30",
					pipeline: "test",
				},
				createMockGroupedPipelines(),
			);
			expect(result).toEqual({
				encoder: undefined,
				resolution: undefined,
				framerate: undefined,
				pipeline: undefined,
			});
		});
	});

	describe("encoder selection", () => {
		it("should auto-select encoder when only one option exists", () => {
			const result = autoSelectNextOption(
				"encoder",
				{
					inputMode: "usb",
					encoder: undefined,
					resolution: undefined,
					framerate: undefined,
					pipeline: undefined,
				},
				createSingleOptionMock(),
			);
			expect(result.encoder).toBe("h264");
		});

		it("should clear all dependents when encoder is invalid for inputMode", () => {
			const result = autoSelectNextOption(
				"encoder",
				{
					inputMode: "hdmi",
					encoder: "invalid",
					resolution: "1080p",
					framerate: "30",
					pipeline: "test",
				},
				createMockGroupedPipelines(),
			);
			expect(result.encoder).toBe(undefined);
			expect(result.resolution).toBe(undefined);
			expect(result.framerate).toBe(undefined);
			expect(result.pipeline).toBe(undefined);
		});

		it("should preserve encoder and dependents when encoder is valid", () => {
			const result = autoSelectNextOption(
				"encoder",
				{
					inputMode: "hdmi",
					encoder: "h264",
					resolution: "1080p",
					framerate: "30",
					pipeline: "test",
				},
				createMockGroupedPipelines(),
			);
			expect(result.encoder).toBe("h264");
		});

		it("should clear dependents when multiple encoder options and none selected", () => {
			const result = autoSelectNextOption(
				"encoder",
				{
					inputMode: "hdmi",
					encoder: undefined,
					resolution: "1080p",
					framerate: "30",
					pipeline: "test",
				},
				createMockGroupedPipelines(),
			);
			expect(result.encoder).toBe(undefined);
			expect(result.resolution).toBe(undefined);
			expect(result.framerate).toBe(undefined);
			expect(result.pipeline).toBe(undefined);
		});
	});

	describe("resolution selection", () => {
		it("should auto-select resolution when only one option exists", () => {
			const result = autoSelectNextOption(
				"resolution",
				{
					inputMode: "usb",
					encoder: "h264",
					resolution: undefined,
					framerate: undefined,
					pipeline: undefined,
				},
				createSingleOptionMock(),
			);
			expect(result.resolution).toBe("720p");
		});

		it("should clear dependents when resolution is invalid for encoder", () => {
			const result = autoSelectNextOption(
				"resolution",
				{
					inputMode: "hdmi",
					encoder: "h264",
					resolution: "4k",
					framerate: "30",
					pipeline: "test",
				},
				createMockGroupedPipelines(),
			);
			expect(result.resolution).toBe(undefined);
			expect(result.framerate).toBe(undefined);
			expect(result.pipeline).toBe(undefined);
		});
	});

	describe("framerate selection", () => {
		it("should auto-select framerate when only one option exists", () => {
			const result = autoSelectNextOption(
				"framerate",
				{
					inputMode: "usb",
					encoder: "h264",
					resolution: "720p",
					framerate: undefined,
					pipeline: undefined,
				},
				createSingleOptionMock(),
			);
			expect(result.framerate).toBe("30");
		});

		it("should clear pipeline when framerate is invalid", () => {
			const result = autoSelectNextOption(
				"framerate",
				{
					inputMode: "hdmi",
					encoder: "h264",
					resolution: "720p",
					framerate: "120",
					pipeline: "test",
				},
				createMockGroupedPipelines(),
			);
			expect(result.framerate).toBe(undefined);
			expect(result.pipeline).toBe(undefined);
		});
	});

	describe("pipeline building", () => {
		it("should build pipeline when all fields are valid", () => {
			const result = autoSelectNextOption(
				"framerate",
				{
					inputMode: "hdmi",
					encoder: "h264",
					resolution: "1080p",
					framerate: "30",
					pipeline: undefined,
				},
				createMockGroupedPipelines(),
			);
			expect(result.pipeline).toBe("hdmi_h264_1080p30");
		});

		it("should auto-select all fields and build pipeline for single-option chain", () => {
			const result = autoSelectNextOption(
				"inputMode",
				{
					inputMode: "usb",
					encoder: undefined,
					resolution: undefined,
					framerate: undefined,
					pipeline: undefined,
				},
				createSingleOptionMock(),
			);
			expect(result.encoder).toBe("h264");
			expect(result.resolution).toBe("720p");
			expect(result.framerate).toBe("30");
			expect(result.pipeline).toBe("usb_h264_720p30");
		});
	});

	describe("edge cases", () => {
		it("should handle inputMode with no available encoders", () => {
			const result = autoSelectNextOption(
				"encoder",
				{
					inputMode: "nonexistent",
					encoder: undefined,
					resolution: undefined,
					framerate: undefined,
					pipeline: undefined,
				},
				createMockGroupedPipelines(),
			);
			expect(result).toEqual({
				encoder: undefined,
				resolution: undefined,
				framerate: undefined,
				pipeline: undefined,
			});
		});
	});
});
