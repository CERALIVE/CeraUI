import { afterEach, describe, expect, it, mock } from "bun:test";

import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { embeddedAudioActive } from "../modules/streaming/embedded-audio.ts";
import {
	getPipelineList,
	initPipelines,
	type Pipeline,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import { maybeProbeAudioSource } from "../modules/streaming/streamloop/start-stream.ts";

// Task 13 embedded-audio gate: the pure predicate, the registry audio_kind
// values, and the start-stream asrcProbe-skip seam. The engine only routes an
// rtmp/srt pipeline's muxed audio when it advertises network_embedded_audio; only
// then does CeraUI skip the ALSA probe (and omit audio.device — covered in
// cerastream-start-assembly.test.ts).

describe("embeddedAudioActive — the pure gate", () => {
	it("is true ONLY when the pipeline is embedded AND the capability is on", () => {
		expect(embeddedAudioActive("embedded", true)).toBe(true);
		expect(embeddedAudioActive("embedded", false)).toBe(false);
		expect(embeddedAudioActive("embedded", undefined)).toBe(false);
		expect(embeddedAudioActive("selectable", true)).toBe(false);
		expect(embeddedAudioActive("none", true)).toBe(false);
		expect(embeddedAudioActive(undefined, true)).toBe(false);
		expect(embeddedAudioActive(undefined, undefined)).toBe(false);
	});
});

type SourceCap = GetCapabilitiesResult["sources"][number];

function source(id: string, overrides: Partial<SourceCap> = {}): SourceCap {
	return {
		id,
		supports_audio: true,
		supports_resolution_override: true,
		supports_framerate_override: true,
		default_resolution: "1080p",
		default_framerate: 30,
		...overrides,
	};
}

function provide(sources: SourceCap[]) {
	return {
		fetchEngineCapabilities: async () => ({
			caps: {
				platform: {
					supports_h265: true,
					hardware_accelerated: true,
					max_resolution: "1080p",
				},
				encoder: {
					codecs: ["h264"],
					bitrate_range: { min: 500, max: 20000, unit: "kbps" },
				},
				sources,
			} satisfies GetCapabilitiesResult,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	};
}

describe("pipelines registry — audio_kind derivation (Task 13)", () => {
	afterEach(async () => {
		setMockHardware("rk3588");
		await initPipelines();
	});

	it("rtmp/srt are embedded; an audio-capable capture is selectable; a no-audio source is none", async () => {
		setMockHardware("rk3588");
		await initPipelines(
			provide([
				source("rtmp", { supports_resolution_override: false }),
				source("srt", { supports_resolution_override: false }),
				source("hdmi"),
				source("test", { supports_audio: false }),
			]),
		);

		const list = getPipelineList();
		expect(list.rtmp?.audio_kind).toBe("embedded");
		expect(list.srt?.audio_kind).toBe("embedded");
		expect(list.hdmi?.audio_kind).toBe("selectable");
		expect(list.test?.audio_kind).toBe("none");
	});
});

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
	return {
		source: "srt",
		name: "srt",
		hardware: "rk3588",
		description: "",
		supportsAudio: true,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audio_kind: "embedded",
		...overrides,
	};
}

const CONFIG = { pipeline: "srt", asrc: "USB audio" } as RuntimeConfig;

describe("maybeProbeAudioSource — asrcProbe skip seam (Task 13)", () => {
	it("SKIPS the probe when the pipeline is embedded AND the capability is on", async () => {
		const probe = mock(async (_asrc: string) => "");
		const proceed = await maybeProbeAudioSource(pipeline(), CONFIG, {
			probe,
			networkEmbeddedAudio: true,
		});
		expect(proceed).toBe(true);
		expect(probe).not.toHaveBeenCalled();
	});

	it("PROBES an embedded pipeline WITHOUT the capability (legacy ALSA path)", async () => {
		const probe = mock(async (_asrc: string) => "");
		await maybeProbeAudioSource(pipeline(), CONFIG, {
			probe,
			networkEmbeddedAudio: false,
		});
		expect(probe).toHaveBeenCalledTimes(1);
		expect(probe).toHaveBeenCalledWith("USB audio");
	});

	it("PROBES a selectable pipeline even with the capability on", async () => {
		const probe = mock(async (_asrc: string) => "");
		await maybeProbeAudioSource(
			pipeline({ audio_kind: "selectable" }),
			CONFIG,
			{ probe, networkEmbeddedAudio: true },
		);
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("does not probe when the pipeline has no audio support or no asrc", async () => {
		const probe = mock(async (_asrc: string) => "");
		await maybeProbeAudioSource(
			pipeline({ supportsAudio: false, audio_kind: "none" }),
			CONFIG,
			{ probe },
		);
		await maybeProbeAudioSource(
			pipeline({ audio_kind: "selectable" }),
			{ pipeline: "srt" } as RuntimeConfig,
			{ probe },
		);
		expect(probe).not.toHaveBeenCalled();
	});

	it("returns false (abort) when the probe rejects", async () => {
		const probe = mock(async (_asrc: string) => {
			throw new Error("stopped");
		});
		const proceed = await maybeProbeAudioSource(
			pipeline({ audio_kind: "selectable" }),
			CONFIG,
			{ probe, networkEmbeddedAudio: false },
		);
		expect(proceed).toBe(false);
	});
});
