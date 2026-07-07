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
import { refreshNetworkIngestInfo } from "../modules/network/network-ingest.ts";
import {
	getPipelinesMessage,
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	setConfigProcedure,
	streamingStartProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
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

describe("streaming.start — network-ingest gateway gate (Task 17)", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;
	let priorPipeline: string | undefined;
	let priorSource: string | undefined;
	let priorNetworkIngest: ReturnType<typeof getConfig>["network_ingest"];

	beforeAll(async () => {
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setMockHardware("rk3588");
		await initPipelines(provide(CAPS_WITH_INGEST));
	});
	beforeEach(() => {
		priorPipeline = getConfig().pipeline;
		priorSource = getConfig().source;
		priorNetworkIngest = getConfig().network_ingest;
		getConfig().pipeline = undefined;
		getConfig().source = undefined;
		getConfig().network_ingest = undefined;
	});
	afterEach(() => {
		getConfig().pipeline = priorPipeline;
		getConfig().source = priorSource;
		getConfig().network_ingest = priorNetworkIngest;
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

	describe("operator-disabled desired-state parity (Task 7)", () => {
		test("config.source=rtmp while rtmp is unavailable → the device-first availability check rejects with source_unavailable (C7 precedes the gateway gate), NOT unknown_source (source stays visible)", async () => {
			getConfig().source = "rtmp";
			getConfig().network_ingest = { rtmp_enabled: false, srt_enabled: true };
			setMockGatewayActive("rtmp", true);
			// getSourcesMessage() reads the CACHED network-ingest snapshot; refresh it
			// after mutating config + mock gateway so the rtmp row reflects
			// operator_disabled (else a stale ambient cache leaves service_active:true
			// without operator_disabled → available:true → the gate falls through to
			// network_ingest_gateway_inactive under CI test ordering).
			await refreshNetworkIngestInfo();

			const result = await call(
				streamingStartProcedure,
				{},
				{ context: makeContext() },
			);

			// The config.source path resolves through getSourcesMessage, where the
			// operator-disabled rtmp row is available:false — so resolveSourceRouting
			// (C7) rejects with source_unavailable before the pipeline gateway gate is
			// reached. Still a refusal, still not unknown_source (Metis #7).
			expect(result).toEqual({
				success: false,
				is_streaming: false,
				error: "source_unavailable",
				reason: "source_unavailable",
			});
		});

		test("the gateway gate's three-mirror parity still holds on the pipeline path: {pipeline:rtmp} + rtmp disabled-in-Settings + unit flag ON → GATEWAY_INACTIVE_ERROR", async () => {
			getConfig().network_ingest = { rtmp_enabled: false, srt_enabled: true };
			// Flip the mock UNIT flag ON: desired-state must still override it, so the
			// mock gate can never diverge from the real probe (buildGatewayProbe). The
			// pipeline path carries no config.source, so resolveSourceRouting is
			// skipped and the gateway gate is the one that fires.
			setMockGatewayActive("rtmp", true);

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

		test("setConfig({max_br}) succeeds while config.source is a disabled ingest (no source in input → no routing/gate)", async () => {
			getConfig().source = "rtmp";
			getConfig().network_ingest = { rtmp_enabled: false, srt_enabled: true };

			const result = await call(
				setConfigProcedure,
				{ max_br: 5000 },
				{ context: makeContext() },
			);

			expect(result.success).toBe(true);
			expect(result.applied?.max_br).toBe(5000);
		});
	});
});
