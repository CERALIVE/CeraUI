import type {
	ActiveEncode,
	CapabilitiesMessage,
	ConfigMessage,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	type CapabilitySummary,
	deriveActiveSummary,
	deriveCapabilitySummary,
	formatCodec,
	resolveAudioSourceMode,
	resolveDisplayedAudioSource,
	resolveTransportToken,
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

describe("resolveTransportToken (Todo 23)", () => {
	it("defaults to SRTLA with no config or caps", () => {
		expect(resolveTransportToken(undefined, undefined)).toBe("SRTLA");
	});

	it("maps the configured protocol to its display token", () => {
		expect(resolveTransportToken({ relay_protocol: "srtla" }, undefined)).toBe(
			"SRTLA",
		);
		expect(resolveTransportToken({ relay_protocol: "rist" }, undefined)).toBe(
			"RIST",
		);
		expect(resolveTransportToken({ relay_protocol: "srt" }, undefined)).toBe(
			"SRT",
		);
	});

	it("falls back to SRTLA when the engine does not offer the selected protocol", () => {
		expect(
			resolveTransportToken(
				{ relay_protocol: "rist" },
				{ ...CAPS, transports: ["srtla"] },
			),
		).toBe("SRTLA");
	});

	it("honors the selected protocol when the engine offers it", () => {
		expect(
			resolveTransportToken(
				{ relay_protocol: "rist" },
				{ ...CAPS, transports: ["srtla", "rist"] },
			),
		).toBe("RIST");
	});
});

describe("deriveActiveSummary — capability vs active-config split (Todo 23)", () => {
	it("idle: derives from saved config incl. video_codec, not streaming", () => {
		const config: ConfigMessage = {
			selected_video_input: "hdmi",
			resolution: "1080p",
			framerate: 60,
			video_codec: "h264",
			relay_protocol: "srtla",
		};
		expect(deriveActiveSummary(config, null, CAPS)).toEqual({
			live: false,
			source: "hdmi",
			resolution: "1080p",
			framerate: 60,
			codec: "H.264",
			transport: "SRTLA",
		});
	});

	it("streaming: engine active_encode WINS over the requested config", () => {
		const config: ConfigMessage = {
			selected_video_input: "hdmi",
			resolution: "720p",
			framerate: 30,
			video_codec: "h264",
			relay_protocol: "srtla",
		};
		const activeEncode: ActiveEncode = {
			codec: "h265",
			resolution: "1920x1080",
			framerate: 60,
			active_input: "uvc_h265",
		};
		expect(deriveActiveSummary(config, activeEncode, CAPS)).toEqual({
			live: true,
			source: "uvc_h265",
			resolution: "1080p",
			framerate: 60,
			codec: "H.265",
			transport: "SRTLA",
		});
	});

	it("streaming: falls back to config source when active_input is absent", () => {
		const config: ConfigMessage = { selected_video_input: "hdmi" };
		const activeEncode: ActiveEncode = {
			codec: "h264",
			resolution: "1234x567",
			framerate: 30,
		};
		const summary = deriveActiveSummary(config, activeEncode, CAPS);
		expect(summary.live).toBe(true);
		expect(summary.source).toBe("hdmi");
		// Non-standard dimensions have no canonical token → show the raw WxH.
		expect(summary.resolution).toBe("1234x567");
	});

	it("missing caps + empty config → graceful fallback (no fabricated values)", () => {
		const summary = deriveActiveSummary(undefined, null, undefined);
		expect(summary).toEqual({
			live: false,
			source: undefined,
			resolution: undefined,
			framerate: undefined,
			codec: undefined,
			transport: "SRTLA",
		});
	});

	it("idle without a codec never invents one from capabilities", () => {
		const config: ConfigMessage = { selected_video_input: "hdmi" };
		expect(deriveActiveSummary(config, null, CAPS).codec).toBeUndefined();
	});
});
