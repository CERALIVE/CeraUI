/*
 * C7 — start/setConfig reject a lost or unavailable source, config never wiped.
 *
 * `resolveSourceRouting` (the seam BOTH streaming.start and streaming.setConfig
 * call before any config mutation or engine dispatch) refuses a source whose
 * CURRENT snapshot row is `lost:true` (→ source_lost) or `available:false`
 * (→ source_unavailable), while an absent id keeps `unknown_source`. The refusal
 * NEVER mutates or clears `config.source`.
 *
 * NOTE: source_lost / source_unavailable are PRE-DISPATCH validation codes minted
 * by resolveSourceRouting — NOT engine Tier-2 codes. They are deliberately absent
 * from cerastream-error-mapping.ts (which only maps a live RuntimeErrorEvent from
 * the engine); mixing the two taxonomies would be a category error.
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
import type { CaptureDevice, DeviceKind } from "@ceraui/rpc/schemas";
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
import {
	applyObservedEngineDevices,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
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

function captureDevice(
	input_id: string,
	kind: DeviceKind,
	displayName = input_id,
): CaptureDevice {
	return {
		input_id,
		device_path: `/dev/${input_id}`,
		display_name: displayName,
		media_class: "video",
		kind,
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

describe("streaming source availability rejection (C7)", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;
	let priorSource: string | undefined;
	let priorPipeline: string | undefined;
	let priorLastSeen: ReturnType<typeof getConfig>["last_seen_devices"];

	beforeAll(async () => {
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setMockHardware("rk3588");
		await initPipelines(provide(CAPS_WITH_INGEST));
	});
	beforeEach(() => {
		priorSource = getConfig().source;
		priorPipeline = getConfig().pipeline;
		priorLastSeen = getConfig().last_seen_devices;
		resetEngineDeviceCache();
		getConfig().pipeline = undefined;
		getConfig().source = undefined;
		getConfig().last_seen_devices = [];
	});
	afterEach(() => {
		getConfig().source = priorSource;
		getConfig().pipeline = priorPipeline;
		getConfig().last_seen_devices = priorLastSeen;
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
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	/** Observe a device then unplug it, so its CURRENT row is a `lost` capture. */
	function makeSourceLost(inputId: string): void {
		applyObservedEngineDevices([captureDevice(inputId, "hdmi", "Studio HDMI")]);
		applyObservedEngineDevices([]);
	}

	test("start with a lost-listed source → source_lost error, config.source unchanged", async () => {
		getConfig().source = "video0";
		makeSourceLost("video0");

		const result = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);

		expect(result).toEqual({
			success: false,
			is_streaming: false,
			error: "source_lost",
		});
		expect(getConfig().source).toBe("video0");
	});

	test("setConfig({source: lostId}) → refused with source_lost, config.source unchanged", async () => {
		getConfig().source = "test";
		makeSourceLost("video0");

		const result = await call(
			setConfigProcedure,
			{ source: "video0" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("source_lost");
		expect(getConfig().source).toBe("test");
	});

	test("start with an available:false network source (gateway down) → source_unavailable error", async () => {
		const result = await call(
			streamingStartProcedure,
			{ source: "rtmp" },
			{ context: makeContext() },
		);

		expect(result).toMatchObject({
			success: false,
			is_streaming: false,
			error: "source_unavailable",
		});
	});

	test("a recovered (re-listed) source → start succeeds (the check reads the CURRENT snapshot)", async () => {
		getConfig().source = "video0";
		makeSourceLost("video0");
		applyObservedEngineDevices([
			captureDevice("video0", "hdmi", "Studio HDMI"),
		]);

		const result = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.is_streaming).toBe(true);
		expect(result).not.toHaveProperty("error");
		expect(result).not.toHaveProperty("reason");
	});
});
