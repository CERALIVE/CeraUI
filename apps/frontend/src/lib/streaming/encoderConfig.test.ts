import type { Pipeline } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import type { EncoderConfig } from "$main/dialogs/EncoderDialog.svelte";

import { buildEncoderSetConfig, getOverrideGate } from "./encoderConfig";

// Minimal Pipeline fixtures — only the override-capability flags matter here.
function makePipeline(
	supportsResolutionOverride: boolean,
	supportsFramerateOverride: boolean,
): Pipeline {
	return {
		name: "Test Pipeline",
		description: "fixture",
		supportsAudio: true,
		supportsResolutionOverride,
		supportsFramerateOverride,
	};
}

const bothOverrides = makePipeline(true, true);
const noOverrides = makePipeline(false, false);
const resolutionOnly = makePipeline(true, false);
const framerateOnly = makePipeline(false, true);

// A fully-populated draft, as EncoderDialog writes it back to LiveView.
function makeDraft(overrides: Partial<EncoderConfig> = {}): EncoderConfig {
	return {
		source: "hdmi",
		resolution: "1080p",
		framerate: 30,
		bitrate: 7000,
		bitrateOverlay: true,
		...overrides,
	};
}

describe("buildEncoderSetConfig", () => {
	describe("base field mapping (draft → setConfig)", () => {
		it("maps source → pipeline", () => {
			const out = buildEncoderSetConfig(makeDraft(), bothOverrides);
			expect(out.pipeline).toBe("hdmi");
		});

		it("maps bitrateOverlay → bitrate_overlay", () => {
			const out = buildEncoderSetConfig(makeDraft(), bothOverrides);
			expect(out.bitrate_overlay).toBe(true);
		});

		it("maps bitrate → max_br", () => {
			const out = buildEncoderSetConfig(makeDraft(), bothOverrides);
			expect(out.max_br).toBe(7000);
		});

		it("forwards bitrate_overlay=false explicitly (not dropped as falsy)", () => {
			const out = buildEncoderSetConfig(
				makeDraft({ bitrateOverlay: false }),
				bothOverrides,
			);
			expect(out.bitrate_overlay).toBe(false);
			expect("bitrate_overlay" in out).toBe(true);
		});

		it("omits undefined base fields", () => {
			const out = buildEncoderSetConfig(
				{
					source: undefined,
					resolution: undefined,
					framerate: undefined,
					bitrate: undefined,
					bitrateOverlay: undefined,
				},
				bothOverrides,
			);
			expect(out).toEqual({});
		});
	});

	describe("resolution capability gating", () => {
		it("includes resolution when supportsResolutionOverride === true", () => {
			const out = buildEncoderSetConfig(makeDraft(), resolutionOnly);
			expect(out.resolution).toBe("1080p");
		});

		it("excludes resolution when supportsResolutionOverride === false", () => {
			const out = buildEncoderSetConfig(makeDraft(), framerateOnly);
			expect(out.resolution).toBeUndefined();
			expect("resolution" in out).toBe(false);
		});

		it("excludes resolution when no pipeline metadata is available", () => {
			const out = buildEncoderSetConfig(makeDraft(), undefined);
			expect("resolution" in out).toBe(false);
		});

		it("excludes resolution when supported but draft value is undefined", () => {
			const out = buildEncoderSetConfig(
				makeDraft({ resolution: undefined }),
				bothOverrides,
			);
			expect("resolution" in out).toBe(false);
		});
	});

	describe("framerate capability gating", () => {
		it("includes framerate when supportsFramerateOverride === true", () => {
			const out = buildEncoderSetConfig(makeDraft(), framerateOnly);
			expect(out.framerate).toBe(30);
		});

		it("excludes framerate when supportsFramerateOverride === false", () => {
			const out = buildEncoderSetConfig(makeDraft(), resolutionOnly);
			expect(out.framerate).toBeUndefined();
			expect("framerate" in out).toBe(false);
		});

		it("excludes framerate when no pipeline metadata is available", () => {
			const out = buildEncoderSetConfig(makeDraft(), undefined);
			expect("framerate" in out).toBe(false);
		});

		it("excludes framerate when supported but draft value is undefined", () => {
			const out = buildEncoderSetConfig(
				makeDraft({ framerate: undefined }),
				bothOverrides,
			);
			expect("framerate" in out).toBe(false);
		});
	});

	describe("end-to-end shape", () => {
		it("a fully-supported pipeline forwards all five fields", () => {
			const out = buildEncoderSetConfig(makeDraft(), bothOverrides);
			expect(out).toEqual({
				pipeline: "hdmi",
				bitrate_overlay: true,
				max_br: 7000,
				resolution: "1080p",
				framerate: 30,
			});
		});

		it("a no-override pipeline forwards only pipeline/overlay/bitrate", () => {
			const out = buildEncoderSetConfig(makeDraft(), noOverrides);
			expect(out).toEqual({
				pipeline: "hdmi",
				bitrate_overlay: true,
				max_br: 7000,
			});
		});
	});
});

describe("getOverrideGate — capability gating (Task 28)", () => {
	it("allows both overrides when the pipeline supports both", () => {
		expect(getOverrideGate(bothOverrides)).toEqual({
			resolution: true,
			framerate: true,
		});
	});

	it("blocks both overrides when the pipeline supports neither", () => {
		expect(getOverrideGate(noOverrides)).toEqual({
			resolution: false,
			framerate: false,
		});
	});

	it("blocks framerate while allowing resolution", () => {
		expect(getOverrideGate(resolutionOnly)).toEqual({
			resolution: true,
			framerate: false,
		});
	});

	it("blocks resolution while allowing framerate", () => {
		expect(getOverrideGate(framerateOnly)).toEqual({
			resolution: false,
			framerate: true,
		});
	});

	it("blocks both overrides when no pipeline metadata is available", () => {
		expect(getOverrideGate(undefined)).toEqual({
			resolution: false,
			framerate: false,
		});
	});

	it("agrees with buildEncoderSetConfig: a blocked field is dropped from the payload", () => {
		const gate = getOverrideGate(noOverrides);
		const out = buildEncoderSetConfig(makeDraft(), noOverrides);
		expect(gate.resolution).toBe(false);
		expect(gate.framerate).toBe(false);
		expect("resolution" in out).toBe(false);
		expect("framerate" in out).toBe(false);
	});
});
