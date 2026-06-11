import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import {
	PipelineOverrideError,
	searchPipelines,
	validatePipelineOverrides,
} from "../modules/streaming/pipelines.ts";

describe("QW-I: Pipeline Override Validation at Save Time", () => {
	describe("validatePipelineOverrides", () => {
		it("should throw PipelineOverrideError with field name for unsupported resolution", () => {
			const pipeline = {
				supportsResolutionOverride: false,
				supportsFramerateOverride: true,
			};

			expect(() => {
				validatePipelineOverrides(pipeline, { resolution: "1920x1080" });
			}).toThrow(PipelineOverrideError);

			try {
				validatePipelineOverrides(pipeline, { resolution: "1920x1080" });
			} catch (err) {
				if (err instanceof PipelineOverrideError) {
					expect(err.field).toBe("resolution");
					expect(err.message).toContain("resolution override");
				} else {
					throw err;
				}
			}
		});

		it("should throw PipelineOverrideError with field name for unsupported framerate", () => {
			const pipeline = {
				supportsResolutionOverride: true,
				supportsFramerateOverride: false,
			};

			expect(() => {
				validatePipelineOverrides(pipeline, { framerate: "30" });
			}).toThrow(PipelineOverrideError);

			try {
				validatePipelineOverrides(pipeline, { framerate: "30" });
			} catch (err) {
				if (err instanceof PipelineOverrideError) {
					expect(err.field).toBe("framerate");
					expect(err.message).toContain("framerate override");
				} else {
					throw err;
				}
			}
		});

		it("should not throw when overrides are supported", () => {
			const pipeline = {
				supportsResolutionOverride: true,
				supportsFramerateOverride: true,
			};

			expect(() => {
				validatePipelineOverrides(pipeline, {
					resolution: "1920x1080",
					framerate: "30",
				});
			}).not.toThrow();
		});

		it("should not throw when no overrides are provided", () => {
			const pipeline = {
				supportsResolutionOverride: false,
				supportsFramerateOverride: false,
			};

			expect(() => {
				validatePipelineOverrides(pipeline, {});
			}).not.toThrow();
		});

		it("should not throw when only supported overrides are provided", () => {
			const pipeline = {
				supportsResolutionOverride: true,
				supportsFramerateOverride: false,
			};

			expect(() => {
				validatePipelineOverrides(pipeline, { resolution: "1920x1080" });
			}).not.toThrow();
		});
	});

	describe("PipelineOverrideError", () => {
		it("should have correct error name and properties", () => {
			const err = new PipelineOverrideError("resolution", "Test message");

			expect(err.name).toBe("PipelineOverrideError");
			expect(err.field).toBe("resolution");
			expect(err.message).toBe("Test message");
			expect(err instanceof Error).toBe(true);
		});

		it("should preserve field name for framerate errors", () => {
			const err = new PipelineOverrideError(
				"framerate",
				"Framerate not supported",
			);

			expect(err.field).toBe("framerate");
		});
	});
});
