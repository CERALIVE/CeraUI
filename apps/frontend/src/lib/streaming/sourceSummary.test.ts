import type {
	ActiveEncode,
	AudioSource,
	CapabilitiesMessage,
	CaptureStreamSource,
	CoarseStreamSource,
	ConfigMessage,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	AUTO_AUDIO_SOURCE_ENTRY,
	audioSourceLabel,
	type CapabilitySummary,
	deriveActiveSummary,
	deriveCapabilitySummary,
	formatCodec,
	groupAudioSources,
	resolveAudioSourceList,
	resolveAudioSourceMode,
	resolveDisplayedAudioSource,
	resolvedAudioLabel,
	resolveTransportToken,
	withAutoAudioEntry,
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

describe("deriveCapabilitySummary — active-source truthfulness (Todo 11)", () => {
	const CAPS_4K_USB: CapabilitiesMessage = {
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
				id: "usb",
				supports_audio: false,
				supports_resolution_override: true,
				supports_framerate_override: true,
				default_resolution: "1080p",
				default_framerate: 60,
			},
		],
		device_modes: {
			"/dev/video0": {
				kind: "uvc_h264",
				modes: [{ width: 1920, height: 1080, framerates: [30, 60] }],
			},
		},
	};

	it("shows the ACTIVE source's real ceiling (usb 1080p@60 on a 4K platform → 1080p/60, not 2160p)", () => {
		const config: ConfigMessage = {
			pipeline: "usb",
			selected_video_input: "/dev/video0",
		};
		const summary = deriveCapabilitySummary(CAPS_4K_USB, config);
		expect(summary?.maxResolution).toBe("1080p");
		expect(summary?.maxFramerate).toBe(60);
		expect(summary?.audioSupported).toBe(false);
	});

	it("normalizes an override-capable active source to the platform ceiling (hdmi on 4K → 2160p)", () => {
		const config: ConfigMessage = { selected_video_input: "hdmi" };
		const summary = deriveCapabilitySummary(CAPS, config);
		expect(summary?.maxResolution).toBe("2160p");
		expect(summary?.maxFramerate).toBe(60);
		expect(summary?.audioSupported).toBe(true);
	});

	it("audioSupported reflects the ACTIVE source (uvc_h264 no-audio), never 'any source' (hdmi has audio)", () => {
		const config: ConfigMessage = { selected_video_input: "uvc_h264" };
		const summary = deriveCapabilitySummary(CAPS, config);
		expect(summary?.audioSupported).toBe(false);
		expect(summary?.maxResolution).toBe("720p");
		expect(summary?.maxFramerate).toBe(30);
	});

	it("falls back to platform maxima when the config resolves no reported source", () => {
		const config: ConfigMessage = { selected_video_input: "not-a-source" };
		const summary = deriveCapabilitySummary(CAPS, config);
		expect(summary?.maxResolution).toBe("4k");
		expect(summary?.maxFramerate).toBe(60);
		expect(summary?.audioSupported).toBe(true);
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

describe("deriveActiveSummary — source name resolved from the sources list (Todo 16)", () => {
	const base = {
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "selectable" as const,
		available: true,
	};

	const RODE_CAPTURE: CaptureStreamSource = {
		...base,
		origin: "capture",
		id: "usb",
		pipelineId: "libuvch264",
		kind: "uvc_h264",
		displayName: "RØDE HDMI to USB-C: RØDE HDMI",
		devicePath: "/dev/video1",
	};

	const HDMI_COARSE: CoarseStreamSource = {
		...base,
		origin: "coarse",
		id: "hdmi",
		pipelineId: "hdmi",
		labelKey: "settings.sources.hdmi",
	};

	const SOURCES: StreamSource[] = [RODE_CAPTURE, HDMI_COARSE];

	it("idle: resolves the selected capture id to its REAL device name", () => {
		const config: ConfigMessage = { selected_video_input: "usb" };
		expect(deriveActiveSummary(config, null, CAPS, SOURCES).source).toBe(
			"RØDE HDMI to USB-C: RØDE HDMI",
		);
	});

	it("streaming: resolves the engine active_input to the capture device name", () => {
		const config: ConfigMessage = { selected_video_input: "hdmi" };
		const activeEncode: ActiveEncode = {
			codec: "h264",
			resolution: "1920x1080",
			framerate: 30,
			active_input: "usb",
		};
		expect(
			deriveActiveSummary(config, activeEncode, CAPS, SOURCES).source,
		).toBe("RØDE HDMI to USB-C: RØDE HDMI");
	});

	it("keeps the raw id for a non-capture (coarse) source — no translator here", () => {
		const config: ConfigMessage = { pipeline: "hdmi" };
		expect(deriveActiveSummary(config, null, CAPS, SOURCES).source).toBe(
			"hdmi",
		);
	});

	it("keeps the raw id when the id is absent from the sources list", () => {
		const config: ConfigMessage = { selected_video_input: "unknown-input" };
		expect(deriveActiveSummary(config, null, CAPS, SOURCES).source).toBe(
			"unknown-input",
		);
	});

	it("byte-identical fallback: with no sources list the raw id passes through", () => {
		const config: ConfigMessage = { selected_video_input: "usb" };
		expect(deriveActiveSummary(config, null, CAPS).source).toBe("usb");
	});
});

describe("resolveAudioSourceList — typed model with legacy asrcs fallback (Task 13)", () => {
	it("passes the typed audio_sources through verbatim when present", () => {
		const typed: AudioSource[] = [
			{ id: "USB audio", kind: "device" },
			{ id: "No audio", kind: "none", labelKey: "audio.sources.noAudio" },
		];
		expect(resolveAudioSourceList(typed, ["ignored"])).toEqual(typed);
	});

	it("derives the typed model from a legacy asrcs list (older backend)", () => {
		const derived = resolveAudioSourceList(undefined, [
			"USB audio",
			"No audio",
			"Pipeline default",
		]);
		expect(derived).toEqual([
			{ id: "USB audio", kind: "device" },
			{ id: "No audio", kind: "none", labelKey: "audio.sources.noAudio" },
			{
				id: "Pipeline default",
				kind: "pipeline_default",
				labelKey: "audio.sources.pipelineDefault",
			},
		]);
	});

	it("falls back to asrcs when audio_sources is an empty array", () => {
		expect(resolveAudioSourceList([], ["USB audio"])).toEqual([
			{ id: "USB audio", kind: "device" },
		]);
	});
});

describe("groupAudioSources — devices first (order kept), pseudo grouped last (Task 13)", () => {
	it("keeps device order and moves the pseudo-sources to the end", () => {
		const list: AudioSource[] = [
			{ id: "No audio", kind: "none", labelKey: "audio.sources.noAudio" },
			{ id: "USB audio", kind: "device" },
			{
				id: "Pipeline default",
				kind: "pipeline_default",
				labelKey: "audio.sources.pipelineDefault",
			},
			{ id: "HDMI", kind: "device" },
		];
		const { devices, pseudo } = groupAudioSources(list);
		expect(devices.map((e) => e.id)).toEqual(["USB audio", "HDMI"]);
		expect(pseudo.map((e) => e.id)).toEqual(["No audio", "Pipeline default"]);
	});
});

describe("audioSourceLabel — translate pseudo, never translate hardware (Task 13)", () => {
	const t = (key: string) =>
		key === "audio.sources.noAudio" ? "Ninguno" : key;

	it("resolves the labelKey for a pseudo-source", () => {
		expect(
			audioSourceLabel(
				{ id: "No audio", kind: "none", labelKey: "audio.sources.noAudio" },
				t,
			),
		).toBe("Ninguno");
	});

	it("renders a hardware device name verbatim (never translated)", () => {
		expect(audioSourceLabel({ id: "USB audio", kind: "device" }, t)).toBe(
			"USB audio",
		);
	});

	it("prefers the verbatim hardware label over labelKey and id (T6/T4)", () => {
		expect(
			audioSourceLabel(
				{ id: "hw:1", kind: "device", label: "Rockchip HDMI-in" },
				t,
			),
		).toBe("Rockchip HDMI-in");
	});
});

describe("withAutoAudioEntry — Auto injected FIRST (T6)", () => {
	it("prepends the Auto entry above every device entry", () => {
		const list: AudioSource[] = [{ id: "USB audio", kind: "device" }];
		const out = withAutoAudioEntry(list);
		expect(out[0]).toEqual(AUTO_AUDIO_SOURCE_ENTRY);
		expect(out.map((e) => e.id)).toEqual([AUDIO_SOURCE_AUTO, "USB audio"]);
	});

	it("dedupes any pre-existing Auto entry (backend never emits one)", () => {
		const list: AudioSource[] = [
			{ id: AUDIO_SOURCE_AUTO, kind: "auto" },
			{ id: "USB audio", kind: "device" },
		];
		const out = withAutoAudioEntry(list);
		expect(out.filter((e) => e.id === AUDIO_SOURCE_AUTO)).toHaveLength(1);
		expect(out[0]).toEqual(AUTO_AUDIO_SOURCE_ENTRY);
	});

	it("the injected Auto entry carries the auto kind + labelKey", () => {
		expect(AUTO_AUDIO_SOURCE_ENTRY).toEqual({
			id: AUDIO_SOURCE_AUTO,
			kind: "auto",
			labelKey: "audio.sources.auto",
		});
	});
});

describe("resolvedAudioLabel — single-owner resolved-audio display (T6)", () => {
	const t = (key: string) =>
		key === "audio.sources.pipelineDefault" ? "Pipeline default" : key;
	const ENTRIES: AudioSource[] = [
		{ id: "USB audio", kind: "device" },
		{ id: "HDMI", kind: "device", label: "Rockchip HDMI-in" },
	];

	it("renders 'Auto → {label}' when Auto is active and resolved (T4 label wins)", () => {
		const r = resolvedAudioLabel(
			{ asrc: AUDIO_SOURCE_AUTO },
			{ resolved_asrc: "HDMI", resolved_asrc_reason: "hdmi" },
			ENTRIES,
			t,
		);
		expect(r.current).toBe("Auto \u2192 Rockchip HDMI-in");
		expect(r.embedded).toBe(false);
		expect(r.pending).toBeUndefined();
	});

	it("falls back to the raw asrc key when no entry matches the resolved id", () => {
		const r = resolvedAudioLabel(
			{ asrc: AUDIO_SOURCE_AUTO },
			{ resolved_asrc: "Analog in" },
			ENTRIES,
			t,
		);
		expect(r.current).toBe("Auto \u2192 Analog in");
	});

	it("STALE-VALUE GATE: an explicit pick never renders a leftover resolved_asrc", () => {
		// config.asrc = explicit "USB audio"; status still carries a stale "HDMI".
		const r = resolvedAudioLabel(
			{ asrc: "USB audio" },
			{ resolved_asrc: "HDMI", resolved_asrc_reason: "hdmi" },
			ENTRIES,
			t,
		);
		expect(r.current).toBeUndefined();
	});

	it("embedded null case: reason 'embedded' → embedded true, current undefined", () => {
		const r = resolvedAudioLabel(
			{ asrc: AUDIO_SOURCE_AUTO },
			{ resolved_asrc: null, resolved_asrc_reason: "embedded" },
			ENTRIES,
			t,
		);
		expect(r.embedded).toBe(true);
		expect(r.current).toBeUndefined();
	});

	it("genuinely-unresolved null case (old backend): current undefined, embedded false", () => {
		const r = resolvedAudioLabel(
			{ asrc: AUDIO_SOURCE_AUTO },
			{ resolved_asrc: null, resolved_asrc_reason: null },
			ENTRIES,
			t,
		);
		expect(r.embedded).toBe(false);
		expect(r.current).toBeUndefined();
	});

	it("old backend that omits the fields entirely → current undefined, embedded false", () => {
		const r = resolvedAudioLabel({ asrc: AUDIO_SOURCE_AUTO }, {}, ENTRIES, t);
		expect(r.current).toBeUndefined();
		expect(r.embedded).toBe(false);
	});

	it("no status at all (undefined) → all-quiet (no throw)", () => {
		const r = resolvedAudioLabel(
			{ asrc: AUDIO_SOURCE_AUTO },
			undefined,
			ENTRIES,
			t,
		);
		expect(r).toEqual({
			current: undefined,
			pending: undefined,
			embedded: false,
		});
	});

	it("surfaces the pending live-follow label whenever present (T7 slot)", () => {
		const r = resolvedAudioLabel(
			{ asrc: AUDIO_SOURCE_AUTO },
			{ resolved_asrc: "USB audio", pending_audio_follow_asrc: "HDMI" },
			ENTRIES,
			t,
		);
		expect(r.pending).toBe("Rockchip HDMI-in");
	});

	it("pending is independent of the stale gate (renders on an explicit pick too)", () => {
		const r = resolvedAudioLabel(
			{ asrc: "USB audio" },
			{ pending_audio_follow_asrc: "USB audio" },
			ENTRIES,
			t,
		);
		expect(r.current).toBeUndefined();
		expect(r.pending).toBe("USB audio");
	});
});
