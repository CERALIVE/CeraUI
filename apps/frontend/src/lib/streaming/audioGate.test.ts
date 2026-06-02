import type { Pipeline } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	type PipelineMap,
	pipelineSupportsAudio,
	resolveAudioGateState,
	resolveAudioPipelineKey,
} from "./audioGate";

// Minimal valid Pipeline fixtures (only the audio flag matters to the gate).
function makePipeline(supportsAudio: boolean): Pipeline {
	return {
		name: "Test Pipeline",
		description: "fixture",
		supportsAudio,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
	};
}

const pipelines: PipelineMap = {
	hdmi: makePipeline(true), // audio-capable
	test: makePipeline(false), // audio-less
};

describe("audioGate", () => {
	describe("resolveAudioPipelineKey (draft-first, saved fallback)", () => {
		it("prefers the drafted encoder pipeline over the saved config", () => {
			expect(resolveAudioPipelineKey("hdmi", "test")).toBe("hdmi");
		});

		it("falls back to the saved config pipeline when no draft", () => {
			expect(resolveAudioPipelineKey(undefined, "test")).toBe("test");
		});

		it("treats empty strings as unset on both sides", () => {
			expect(resolveAudioPipelineKey("", "")).toBeUndefined();
			expect(resolveAudioPipelineKey("", "hdmi")).toBe("hdmi");
		});

		it("returns undefined when nothing is drafted or saved", () => {
			expect(resolveAudioPipelineKey(undefined, undefined)).toBeUndefined();
		});
	});

	describe("pipelineSupportsAudio", () => {
		it("is true for an audio-capable pipeline", () => {
			expect(pipelineSupportsAudio("hdmi", pipelines)).toBe(true);
		});

		it("is false for an audio-less pipeline", () => {
			expect(pipelineSupportsAudio("test", pipelines)).toBe(false);
		});

		it("is false for an unknown key or missing map", () => {
			expect(pipelineSupportsAudio("ghost", pipelines)).toBe(false);
			expect(pipelineSupportsAudio("hdmi", undefined)).toBe(false);
			expect(pipelineSupportsAudio(undefined, pipelines)).toBe(false);
		});
	});

	describe("resolveAudioGateState — three gate states", () => {
		it("no pipeline drafted/saved → 'no-pipeline'", () => {
			expect(resolveAudioGateState(undefined, pipelines)).toBe("no-pipeline");
		});

		it("pipeline with supportsAudio=false → 'no-audio-support'", () => {
			expect(resolveAudioGateState("test", pipelines)).toBe("no-audio-support");
		});

		it("pipeline with audio support → 'enabled'", () => {
			expect(resolveAudioGateState("hdmi", pipelines)).toBe("enabled");
		});

		it("end-to-end: drafted audio-capable pipeline clears a saved audio-less one", () => {
			// The bug this fixes: saved config is audio-less ('test') but the operator
			// just drafted an audio-capable pipeline ('hdmi') in the Encoder dialog.
			const key = resolveAudioPipelineKey("hdmi", "test");
			expect(resolveAudioGateState(key, pipelines)).toBe("enabled");
		});

		it("end-to-end: drafted audio-less pipeline gates a saved audio-capable one", () => {
			const key = resolveAudioPipelineKey("test", "hdmi");
			expect(resolveAudioGateState(key, pipelines)).toBe("no-audio-support");
		});
	});
});
