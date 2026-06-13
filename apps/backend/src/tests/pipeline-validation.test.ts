import { afterAll, beforeEach, describe, expect, it } from "bun:test";

import {
	getPipelineList,
	initPipelines,
	searchPipelines,
	setMockHardware,
	validatePipelineOverrides,
} from "../modules/streaming/pipelines.ts";
import { validateConfig } from "../modules/streaming/streaming.ts";

// jetson source capability flags (pipeline-sources.ts tables):
//   camlink : resolution=true,  framerate=true,  audio=true
//   rtmp    : resolution=false, framerate=true,  audio=true
//   srt     : resolution=false, framerate=true,  audio=true
// rtmp/srt are the resolution-override discriminators.

const RES_OK = {
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
};
const RES_BLOCKED = {
	supportsResolutionOverride: false,
	supportsFramerateOverride: true,
};
const FPS_BLOCKED = {
	supportsResolutionOverride: true,
	supportsFramerateOverride: false,
};

describe("pipeline init + lookup", () => {
	beforeEach(async () => {
		setMockHardware("jetson");
		await initPipelines();
	});

	afterAll(async () => {
		setMockHardware("rk3588");
		await initPipelines();
	});

	it("populates a non-empty registry after initPipelines()", () => {
		const list = getPipelineList();
		expect(Object.keys(list).length).toBeGreaterThan(0);
		expect(searchPipelines("camlink")).not.toBeNull();
	});

	it("returns the pipeline for a valid id", () => {
		const pipeline = searchPipelines("camlink");
		expect(pipeline).not.toBeNull();
		expect(pipeline?.source).toBe("camlink");
	});

	it("returns null for an unknown id", () => {
		expect(searchPipelines("does-not-exist")).toBeNull();
	});
});

describe("validatePipelineOverrides gating", () => {
	it("rejects a resolution override when the pipeline lacks the capability", () => {
		expect(() =>
			validatePipelineOverrides(RES_BLOCKED, { resolution: "1080p" }),
		).toThrow("Pipeline does not support resolution override");
	});

	it("accepts a resolution override when the pipeline supports it", () => {
		expect(() =>
			validatePipelineOverrides(RES_OK, { resolution: "1080p" }),
		).not.toThrow();
	});

	it("rejects a framerate override when the pipeline lacks the capability", () => {
		expect(() =>
			validatePipelineOverrides(FPS_BLOCKED, { framerate: 60 }),
		).toThrow("Pipeline does not support framerate override");
	});

	it("accepts a framerate override when the pipeline supports it", () => {
		expect(() =>
			validatePipelineOverrides(RES_OK, { framerate: 60 }),
		).not.toThrow();
	});

	it("accepts an empty override set on any pipeline", () => {
		expect(() => validatePipelineOverrides(RES_BLOCKED, {})).not.toThrow();
	});
});

describe("validateConfig capability + override rejection", () => {
	beforeEach(async () => {
		setMockHardware("jetson");
		await initPipelines();
	});

	afterAll(async () => {
		setMockHardware("rk3588");
		await initPipelines();
	});

	it("rejects an unknown pipeline id", async () => {
		await expect(
			validateConfig({ delay: 0, pipeline: "nope" }),
		).rejects.toThrow("Pipeline not found");
	});

	it("rejects a resolution override on a pipeline that does not support it", async () => {
		await expect(
			validateConfig({ delay: 0, pipeline: "rtmp", resolution: "1080p" }),
		).rejects.toThrow("Pipeline does not support resolution override");
	});

	it("rejects an unknown audio codec", async () => {
		await expect(
			validateConfig({ delay: 0, pipeline: "camlink", acodec: "pcm" }),
		).rejects.toThrow("Audio codec not found");
	});
});
