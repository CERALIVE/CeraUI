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
import {
	GATEWAY_INACTIVE_ERROR,
	pipelinesMessageSchema,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { setMockGatewayActive } from "../mocks/providers/streaming.ts";
import { getConfig } from "../modules/config.ts";
import {
	getPipelinesMessage,
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { streamingStartProcedure } from "../rpc/procedures/streaming.procedure.ts";
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

// A capability contract that INCLUDES the network-ingest sources (rtmp/srt) so
// the derived registry carries them — the gate can only fire when the entry is
// present (disabled-with-reason, never removed).
const CAPS_WITH_INGEST: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "1080p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [
		source("hdmi"),
		source("rtmp", { supports_resolution_override: false }),
		source("srt", { supports_resolution_override: false }),
		source("test"),
	],
};

function provide(snapshot: GetCapabilitiesResult) {
	return {
		fetchEngineCapabilities: async () => ({
			caps: snapshot,
			schemaVersion: SCHEMA_VERSION,
		}),
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

describe("streaming.start — network-ingest gateway gate (Task 17)", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;
	let priorPipeline: string | undefined;

	beforeAll(async () => {
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setMockHardware("rk3588");
		await initPipelines(provide(CAPS_WITH_INGEST));
	});
	beforeEach(() => {
		priorPipeline = getConfig().pipeline;
		getConfig().pipeline = undefined;
	});
	afterEach(() => {
		getConfig().pipeline = priorPipeline;
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
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	test("the rejection code is the stable literal network_ingest_gateway_inactive", () => {
		expect(GATEWAY_INACTIVE_ERROR).toBe("network_ingest_gateway_inactive");
	});

	test("the gateway check precedes the mock early-success branch (fires under shouldUseMocks)", async () => {
		const result = await call(
			streamingStartProcedure,
			{ pipeline: "rtmp" },
			{ context: makeContext() },
		);
		expect(result).toEqual({
			success: false,
			is_streaming: false,
			error: "network_ingest_gateway_inactive",
		});
	});

	test("the derived registry keeps rtmp/srt and carries requires_gateway on exactly those", () => {
		const message = getPipelinesMessage();
		expect(pipelinesMessageSchema.safeParse(message).success).toBe(true);

		const ids = Object.keys(message.pipelines);
		expect(ids).toContain("rtmp");
		expect(ids).toContain("srt");
		expect(ids).toContain("hdmi");

		expect(message.pipelines.rtmp?.requires_gateway).toBe("rtmp");
		expect(message.pipelines.srt?.requires_gateway).toBe("srt");
		// A non-ingest source never carries the marker.
		expect(message.pipelines.hdmi?.requires_gateway).toBeUndefined();
		expect(message.pipelines.test?.requires_gateway).toBeUndefined();
	});

	test("starting an rtmp pipeline while the gateway is inactive returns the structured rejection", async () => {
		const result = await call(
			streamingStartProcedure,
			{ pipeline: "rtmp" },
			{ context: makeContext() },
		);

		expect(result).toEqual({
			success: false,
			is_streaming: false,
			error: GATEWAY_INACTIVE_ERROR,
		});
	});

	test("starting an srt pipeline while the gateway is inactive returns the structured rejection", async () => {
		const result = await call(
			streamingStartProcedure,
			{ pipeline: "srt" },
			{ context: makeContext() },
		);

		expect(result).toEqual({
			success: false,
			is_streaming: false,
			error: GATEWAY_INACTIVE_ERROR,
		});
	});

	test("with the rtmp gateway active (mock) the start proceeds to the backend seam", async () => {
		setMockGatewayActive("rtmp", true);

		const result = await call(
			streamingStartProcedure,
			{ pipeline: "rtmp" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.is_streaming).toBe(true);
		expect(result).not.toHaveProperty("error");
	});

	test("an active rtmp gateway does not unblock a still-inactive srt gateway (per-kind)", async () => {
		setMockGatewayActive("rtmp", true);

		const result = await call(
			streamingStartProcedure,
			{ pipeline: "srt" },
			{ context: makeContext() },
		);

		expect(result).toEqual({
			success: false,
			is_streaming: false,
			error: GATEWAY_INACTIVE_ERROR,
		});
	});

	test("a non-ingest pipeline (hdmi) is never gateway-gated", async () => {
		const result = await call(
			streamingStartProcedure,
			{ pipeline: "hdmi" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result).not.toHaveProperty("error");
	});
});
