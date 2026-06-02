import type { ConfigMessage, Pipelines } from "@ceraui/rpc/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildStartConfig, canStartStream, hasServerTarget } from "./startStreaming";

// ── rpc client mock (for start/stop dispatch) ──────────────────────────────
const startMock = vi.fn().mockResolvedValue({ success: true, is_streaming: true });
const stopMock = vi.fn().mockResolvedValue({ success: true });

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		streaming: {
			start: (input: unknown) => startMock(input),
			stop: () => stopMock(),
		},
	},
}));

// A fully-populated saved config, as getConfig hydrates it.
function makeConfig(overrides: Partial<ConfigMessage> = {}): ConfigMessage {
	return {
		pipeline: "hdmi",
		max_br: 7000,
		acodec: "aac",
		delay: 0,
		asrc: "C4K",
		srt_latency: 2000,
		bitrate_overlay: true,
		srtla_addr: "srt.example.tv",
		srtla_port: 5000,
		srt_streamid: "publish/live",
		...overrides,
	};
}

// A pipeline registry record, as getPipelines().pipelines hydrates it.
function makePipelines(): Pipelines {
	return {
		hdmi: {
			name: "HDMI Capture",
			description: "HDMI capture pipeline",
			supportsAudio: true,
			supportsResolutionOverride: true,
			supportsFramerateOverride: true,
		},
		libuvch264: {
			name: "UVC H264 Camera",
			description: "UVC H264 pipeline",
			supportsAudio: true,
			supportsResolutionOverride: false,
			supportsFramerateOverride: false,
		},
	};
}

describe("hasServerTarget", () => {
	it("is false for undefined config", () => {
		expect(hasServerTarget(undefined)).toBe(false);
	});

	it("is false when neither srtla_addr nor relay_server is set", () => {
		expect(hasServerTarget(makeConfig({ srtla_addr: undefined }))).toBe(false);
	});

	it("is true with a direct srtla_addr", () => {
		expect(hasServerTarget(makeConfig())).toBe(true);
	});

	it("is true with a relay_server (no srtla_addr)", () => {
		expect(
			hasServerTarget(makeConfig({ srtla_addr: undefined, relay_server: "relay-eu" })),
		).toBe(true);
	});
});

describe("buildStartConfig — validation gates", () => {
	it("refuses with missingPipeline when no pipeline is set", () => {
		const result = buildStartConfig(makeConfig({ pipeline: undefined }), null);
		expect(result).toEqual({ ok: false, error: "missingPipeline" });
	});

	it("refuses with missingPipeline for undefined config", () => {
		expect(buildStartConfig(undefined, null)).toEqual({
			ok: false,
			error: "missingPipeline",
		});
	});

	it("refuses with missingServer when no server target is set", () => {
		const result = buildStartConfig(
			makeConfig({ srtla_addr: undefined, relay_server: undefined }),
			null,
		);
		expect(result).toEqual({ ok: false, error: "missingServer" });
	});

	it("checks pipeline before server", () => {
		const result = buildStartConfig(
			makeConfig({ pipeline: undefined, srtla_addr: undefined }),
			null,
		);
		expect(result).toEqual({ ok: false, error: "missingPipeline" });
	});
});

describe("buildStartConfig — pipeline recognition gate", () => {
	it("still returns ok for a recognized pipeline + server when pipelines is supplied", () => {
		const result = buildStartConfig(makeConfig(), null, makePipelines());
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.config.pipeline).toBe("hdmi");
	});

	it("refuses with unknownPipeline when the pipeline is absent from supplied pipelines", () => {
		const result = buildStartConfig(
			makeConfig({ pipeline: "aa5813aa21487de31570a888272bace773d556e0" }),
			null,
			makePipelines(),
		);
		expect(result).toEqual({ ok: false, error: "unknownPipeline" });
	});

	it("checks pipeline presence before recognition", () => {
		const result = buildStartConfig(makeConfig({ pipeline: undefined }), null, makePipelines());
		expect(result).toEqual({ ok: false, error: "missingPipeline" });
	});

	it("checks server before recognition", () => {
		const result = buildStartConfig(
			makeConfig({ pipeline: "stale-id", srtla_addr: undefined, relay_server: undefined }),
			null,
			makePipelines(),
		);
		expect(result).toEqual({ ok: false, error: "missingServer" });
	});

	it("behaves exactly as today when pipelines is omitted (backward compatible)", () => {
		const result = buildStartConfig(makeConfig({ pipeline: "stale-id" }), null);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.config.pipeline).toBe("stale-id");
	});
});

describe("canStartStream", () => {
	it("is true for a server-backed, recognized pipeline that is not starting", () => {
		expect(canStartStream({ hasServer: true, pipelineRecognized: true, starting: false })).toBe(
			true,
		);
	});

	it("is false with no server", () => {
		expect(canStartStream({ hasServer: false, pipelineRecognized: true, starting: false })).toBe(
			false,
		);
	});

	it("is false when the pipeline is unrecognized", () => {
		expect(canStartStream({ hasServer: true, pipelineRecognized: false, starting: false })).toBe(
			false,
		);
	});

	it("is false while a start is in flight", () => {
		expect(canStartStream({ hasServer: true, pipelineRecognized: true, starting: true })).toBe(
			false,
		);
	});
});

describe("buildStartConfig — assembly", () => {
	it("returns the saved config when valid and no audio override", () => {
		const config = makeConfig();
		const result = buildStartConfig(config, null);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.pipeline).toBe("hdmi");
			expect(result.config.srtla_addr).toBe("srt.example.tv");
			expect(result.config.srtla_port).toBe(5000);
			expect(result.config.max_br).toBe(7000);
			expect(result.config.asrc).toBe("C4K");
			expect(result.config.acodec).toBe("aac");
		}
	});

	it("accepts a relay_server target (no direct srtla_addr)", () => {
		const result = buildStartConfig(
			makeConfig({ srtla_addr: undefined, relay_server: "relay-eu" }),
			null,
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.config.relay_server).toBe("relay-eu");
	});

	it("folds the audio override over the saved config", () => {
		const result = buildStartConfig(makeConfig(), {
			asrc: "USB Mic",
			acodec: "opus",
			delay: 250,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.asrc).toBe("USB Mic");
			expect(result.config.acodec).toBe("opus");
			expect(result.config.delay).toBe(250);
			// untouched fields survive
			expect(result.config.pipeline).toBe("hdmi");
		}
	});

	it("keeps saved audio when the override omits a field", () => {
		const result = buildStartConfig(makeConfig(), { delay: 100 });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.delay).toBe(100);
			expect(result.config.asrc).toBe("C4K");
			expect(result.config.acodec).toBe("aac");
		}
	});
});

describe("start/stop dispatch (mocked rpc client)", () => {
	beforeEach(() => {
		startMock.mockClear();
		stopMock.mockClear();
	});

	it("startStreaming maps the assembled config and calls rpc.streaming.start", async () => {
		const { startStreaming } = await import("$lib/helpers/SystemHelper");
		const result = buildStartConfig(makeConfig(), null);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		await startStreaming(result.config);

		expect(startMock).toHaveBeenCalledTimes(1);
		const input = startMock.mock.calls[0][0] as Record<string, unknown>;
		expect(input.pipeline).toBe("hdmi");
		expect(input.srtla_addr).toBe("srt.example.tv");
		expect(input.srtla_port).toBe(5000);
		expect(input.max_br).toBe(7000);
		expect(input.acodec).toBe("aac");
	});

	it("stopStreaming calls rpc.streaming.stop", async () => {
		const { stopStreaming } = await import("$lib/helpers/SystemHelper");
		await stopStreaming();
		expect(stopMock).toHaveBeenCalledTimes(1);
	});
});
