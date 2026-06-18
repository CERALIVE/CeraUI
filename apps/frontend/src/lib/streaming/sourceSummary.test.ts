import type { CapabilitiesMessage } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	type CapabilitySummary,
	deriveCapabilitySummary,
	formatCodec,
	resolveAudioSourceMode,
	resolveDisplayedAudioSource,
} from "./sourceSummary";

const CAPS: CapabilitiesMessage = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "4k",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [
		{
			id: "hdmi",
			supports_audio: true,
			supports_resolution_override: true,
			supports_framerate_override: true,
			default_resolution: "1080p",
			default_framerate: 60,
		},
		{
			id: "uvc_h264",
			supports_audio: false,
			supports_resolution_override: false,
			supports_framerate_override: false,
			default_resolution: "720p",
			default_framerate: 30,
		},
	],
};

describe("resolveAudioSourceMode — single vs multiple (Task 8)", () => {
	it("returns 'none' for an empty source list", () => {
		expect(resolveAudioSourceMode([])).toBe("none");
	});

	it("returns 'single' for exactly one source (read-only, no false dropdown)", () => {
		expect(resolveAudioSourceMode(["alsa:usbaudio"])).toBe("single");
	});

	it("returns 'multiple' for two or more sources (selectable)", () => {
		expect(resolveAudioSourceMode(["a", "b"])).toBe("multiple");
		expect(resolveAudioSourceMode(["a", "b", "c"])).toBe("multiple");
	});
});

describe("resolveDisplayedAudioSource", () => {
	it("prefers an explicit selection still present in the source list", () => {
		expect(resolveDisplayedAudioSource("b", ["a", "b"])).toBe("b");
	});

	it("falls back to the lone source when single and nothing selected", () => {
		expect(resolveDisplayedAudioSource(undefined, ["only"])).toBe("only");
	});

	it("keeps a selection the pipeline no longer reports (stale, surfaced not hidden)", () => {
		expect(resolveDisplayedAudioSource("gone", ["a", "b"])).toBe("gone");
	});

	it("returns undefined when nothing is selected and multiple are available", () => {
		expect(resolveDisplayedAudioSource(undefined, ["a", "b"])).toBeUndefined();
	});
});

describe("deriveCapabilitySummary — res/fps/codec/audio (Task 8)", () => {
	it("returns undefined before any capabilities arrive", () => {
		expect(deriveCapabilitySummary(undefined)).toBeUndefined();
	});

	it("derives resolution, max framerate, codecs, hw-accel and audio support", () => {
		const summary = deriveCapabilitySummary(CAPS);
		expect(summary).toEqual<CapabilitySummary>({
			maxResolution: "4k",
			maxFramerate: 60,
			codecs: ["h264", "h265"],
			hardwareAccelerated: true,
			audioSupported: true,
		});
	});

	it("reports audioSupported=false when no source exposes audio", () => {
		const noAudio: CapabilitiesMessage = {
			...CAPS,
			sources: CAPS.sources.map((s) => ({ ...s, supports_audio: false })),
		};
		expect(deriveCapabilitySummary(noAudio)?.audioSupported).toBe(false);
	});

	it("leaves framerate undefined when no sources are reported", () => {
		const noSources: CapabilitiesMessage = { ...CAPS, sources: [] };
		const summary = deriveCapabilitySummary(noSources);
		expect(summary?.maxFramerate).toBeUndefined();
		expect(summary?.audioSupported).toBe(false);
	});

	it("treats an empty max_resolution string as undefined", () => {
		const blank: CapabilitiesMessage = {
			...CAPS,
			platform: { ...CAPS.platform, max_resolution: "" },
		};
		expect(deriveCapabilitySummary(blank)?.maxResolution).toBeUndefined();
	});
});

describe("formatCodec", () => {
	it("maps known codec tokens to human labels", () => {
		expect(formatCodec("h264")).toBe("H.264");
		expect(formatCodec("avc")).toBe("H.264");
		expect(formatCodec("h265")).toBe("H.265");
		expect(formatCodec("hevc")).toBe("H.265");
		expect(formatCodec("av1")).toBe("AV1");
	});

	it("is case-insensitive and trims whitespace", () => {
		expect(formatCodec(" H265 ")).toBe("H.265");
	});

	it("uppercases unknown tokens as a safe fallback", () => {
		expect(formatCodec("foo")).toBe("FOO");
	});
});
