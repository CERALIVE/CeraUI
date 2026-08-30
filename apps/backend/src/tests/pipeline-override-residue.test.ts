/*
 * A geometry override the selected pipeline cannot honor is RESIDUE, not intent.
 *
 * Board-measured on a Rock 5B+ (2026-08-30): a `config.json` carrying
 * `resolution: "720p"` + `framerate: 30` from an earlier HDMI session, with an
 * RTMP ingest source selected, failed EVERY start:
 *
 *   PipelineOverrideError: Pipeline does not support resolution override
 *   start_invalid  phase=params  retry=not_retriable
 *
 * The operator could not clear it: `intersectCaps` collapses a non-override
 * source's offering to its own default, so the Encoder dialog never renders the
 * axis for an ingest row — the start failed naming a field their own source row
 * does not display, with no affordance anywhere to unset it.
 *
 * Two seams, one shared rule (`@ceraui/rpc` `unsupportedPipelineOverrides`):
 * the start DROPS the residue rather than dying on it, and the save CLEARS it
 * from disk so the config self-heals. An EXPLICIT override for such a pipeline
 * is still refused — that one is an operator action worth answering.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";

import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { call } from "@orpc/server";

import {
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import {
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import { resetEngineDeviceCache } from "../modules/streaming/sources.ts";
import {
	updateStatus,
	validateConfig,
} from "../modules/streaming/streaming.ts";
import { setConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

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

const CAPS: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [
		source("hdmi"),
		// The board's own shape: an ingest pipeline honors NEITHER axis, because
		// the geometry is whatever the publisher sends.
		source("rtmp", {
			supports_resolution_override: false,
			supports_framerate_override: false,
		}),
	],
};

function provide() {
	return {
		fetchEngineCapabilities: async () => ({
			caps: CAPS,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	};
}

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

describe("a geometry override the pipeline cannot honor is residue", () => {
	const savedMockMode = process.env.MOCK_MODE;
	let priorPipeline: string | undefined;
	let priorResolution: ReturnType<typeof getConfig>["resolution"];
	let priorFramerate: ReturnType<typeof getConfig>["framerate"];

	beforeAll(async () => {
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setMockHardware("rk3588");
		await initPipelines(provide());
	});
	beforeEach(() => {
		const config = getConfig();
		priorPipeline = config.pipeline;
		priorResolution = config.resolution;
		priorFramerate = config.framerate;
		resetEngineDeviceCache();
	});
	afterEach(() => {
		const config = getConfig();
		config.pipeline = priorPipeline;
		config.resolution = priorResolution;
		config.framerate = priorFramerate;
		resetEngineDeviceCache();
		setStreamingState(false);
		updateStatus(false);
		resetMockState();
	});
	afterAll(async () => {
		stopMockService();
		setMockHardware("rk3588");
		await initPipelines();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
	});

	// ── The start path: the operator-visible half ──────────────────────────────
	describe("the start drops it instead of dying on it", () => {
		test("the board's exact config no longer dies on the override", async () => {
			const params: Record<string, unknown> = {
				delay: 0,
				pipeline: "rtmp",
				resolution: "1080p",
				framerate: 30,
			};

			await expect(validateConfig(params)).rejects.not.toThrow(
				"Pipeline does not support",
			);
			expect(params).not.toHaveProperty("resolution");
			expect(params).not.toHaveProperty("framerate");
		});

		test("a pipeline that DOES honor the axes keeps them", async () => {
			const params: Record<string, unknown> = {
				delay: 0,
				pipeline: "hdmi",
				resolution: "1080p",
				framerate: 30,
			};

			await expect(validateConfig(params)).rejects.not.toThrow(
				"Pipeline does not support",
			);
			expect(params.resolution).toBe("1080p");
			expect(params.framerate).toBe(30);
		});
	});

	// ── The save path: the self-heal ───────────────────────────────────────────
	describe("the save clears it from disk", () => {
		test("switching the pipeline to an ingest one clears the stale overrides", async () => {
			const config = getConfig();
			config.pipeline = "hdmi";
			config.resolution = "720p";
			config.framerate = 30;

			const result = await call(
				setConfigProcedure,
				{ pipeline: "rtmp" },
				{ context: makeContext() },
			);

			expect(result.success).toBe(true);
			expect(config.resolution).toBeUndefined();
			expect(config.framerate).toBeUndefined();
		});

		test("a save on an ALREADY-ingest config heals it too", async () => {
			const config = getConfig();
			config.pipeline = "rtmp";
			config.resolution = "720p";
			config.framerate = 30;

			const result = await call(
				setConfigProcedure,
				{ delay: 0 },
				{ context: makeContext() },
			);

			expect(result.success).toBe(true);
			expect(config.resolution).toBeUndefined();
			expect(config.framerate).toBeUndefined();
		});

		test("a pipeline that honors the axes keeps the persisted values", async () => {
			const config = getConfig();
			config.pipeline = "hdmi";
			config.resolution = "720p";
			config.framerate = 30;

			const result = await call(
				setConfigProcedure,
				{ delay: 0 },
				{ context: makeContext() },
			);

			expect(result.success).toBe(true);
			expect(config.resolution).toBe("720p");
			expect(config.framerate).toBe(30);
		});
	});

	// ── The operator's own action is still answered ────────────────────────────
	test("an EXPLICIT override for such a pipeline is still REFUSED, not silently dropped", async () => {
		const config = getConfig();
		config.pipeline = "rtmp";
		config.resolution = undefined;

		const result = await call(
			setConfigProcedure,
			{ pipeline: "rtmp", resolution: "1080p" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("Pipeline does not support resolution override");
	});
});
