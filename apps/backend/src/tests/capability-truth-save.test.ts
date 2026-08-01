/*
 * Save-time device-truth validation (device-quality-wave3 todo 11a).
 *
 * `streaming.setConfig` must refuse a resolution/framerate the SELECTED device
 * cannot deliver, per cerastream ADR-0008 §10: "the per-`media_type` mode ladder
 * is the ONLY truth … the UI and the save path may never invent or union."
 *
 * The class this kills is a PERSISTED 1080p60 on a device whose H.264 ladder tops
 * out at 30 — the config survives on disk, is re-sent on every start, and the leg
 * fails `not-negotiated` every time.
 *
 * These cases drive the REAL RPC procedure, not the dialog. That is the point:
 * the plan's failure scenario is "a save slipping past validation via direct
 * RPC", so the guarantee has to live at the procedure, where the dialog cannot
 * be the thing enforcing it.
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
import type {
	CaptureCap,
	CaptureDevice,
	DeviceKind,
} from "@ceraui/rpc/schemas";
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
	// `usb_mjpeg` is REQUIRED here, not decorative: `DEVICE_KIND_TO_PIPELINE_ID`
	// bridges an `mjpeg` device to that pipeline id, and `buildSources` drops any
	// device whose bridged pipeline the registry does not carry.
	sources: [
		source("hdmi"),
		source("libuvch264"),
		source("usb_mjpeg"),
		source("test"),
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

function cap(
	width: number,
	height: number,
	framerate: string,
	media_type?: string,
): CaptureCap {
	return {
		width,
		height,
		framerate,
		...(media_type !== undefined ? { media_type } : {}),
	};
}

function device(
	input_id: string,
	kind: DeviceKind,
	caps: CaptureCap[],
	displayName = input_id,
): CaptureDevice {
	return {
		input_id,
		device_path: `/dev/${input_id}`,
		display_name: displayName,
		media_class: "video",
		kind,
		caps,
	};
}

/**
 * The effort's running example. A DJI Osmo Pocket 3 whose H.264 ladder reaches
 * 1080p at 30 only, while its MJPEG ladder reaches 1080p60 and 2160p30. Unioning
 * the two is the #244 defect.
 */
const OSMO_H264 = device("video1", "uvc_h264", [
	cap(1920, 1080, "30/1", "video/x-h264"),
	cap(1280, 720, "30/1", "video/x-h264"),
	cap(1280, 720, "60/1", "video/x-h264"),
	cap(1920, 1080, "30/1", "image/jpeg"),
	cap(1920, 1080, "60/1", "image/jpeg"),
	cap(3840, 2160, "30/1", "image/jpeg"),
]);

/** The SAME hardware selected as its MJPEG ladder — 1080p60 is real there. */
const OSMO_MJPEG = device("video2", "mjpeg", [
	cap(1920, 1080, "30/1", "video/x-h264"),
	cap(1280, 720, "60/1", "video/x-h264"),
	cap(1920, 1080, "60/1", "image/jpeg"),
	cap(3840, 2160, "30/1", "image/jpeg"),
]);

/** An HDMI receiver reporting ONE mode — a ceiling, so downscale stays legal. */
const HDMI_RX = device("video0", "hdmi", [cap(1920, 1080, "60000/1001")]);

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

describe("streaming.setConfig — device-truth validation (todo 11a)", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;
	let priorSource: string | undefined;
	let priorPipeline: string | undefined;
	let priorResolution: ReturnType<typeof getConfig>["resolution"];
	let priorFramerate: ReturnType<typeof getConfig>["framerate"];
	let priorSelected: string | undefined;

	beforeAll(async () => {
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setMockHardware("rk3588");
		await initPipelines(provide());
	});
	beforeEach(() => {
		const config = getConfig();
		priorSource = config.source;
		priorPipeline = config.pipeline;
		priorResolution = config.resolution;
		priorFramerate = config.framerate;
		priorSelected = config.selected_video_input;
		resetEngineDeviceCache();
		config.source = undefined;
		config.pipeline = undefined;
		config.resolution = undefined;
		config.framerate = undefined;
		config.selected_video_input = undefined;
		config.input_mode = undefined;
	});
	afterEach(() => {
		const config = getConfig();
		config.source = priorSource;
		config.pipeline = priorPipeline;
		config.resolution = priorResolution;
		config.framerate = priorFramerate;
		config.selected_video_input = priorSelected;
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

	// ── The rejection table, per media_type ────────────────────────────────────
	describe("rejection table — the ladder that governs is the SELECTED source's", () => {
		test("1080p60 on the Osmo's H.264 ladder is REFUSED", async () => {
			applyObservedEngineDevices([OSMO_H264]);
			const result = await call(
				setConfigProcedure,
				{ source: "video1", resolution: "1080p", framerate: 60 },
				{ context: makeContext() },
			);
			expect(result.success).toBe(false);
			expect(result.error).toBe("device_mode_unsupported");
		});

		test("1080p30 on the SAME device+ladder is ACCEPTED", async () => {
			applyObservedEngineDevices([OSMO_H264]);
			const result = await call(
				setConfigProcedure,
				{ source: "video1", resolution: "1080p", framerate: 30 },
				{ context: makeContext() },
			);
			expect(result.success).toBe(true);
			expect(result.applied.resolution).toBe("1080p");
			expect(result.applied.framerate).toBe(30);
		});

		test("720p60 on the H.264 ladder is ACCEPTED — the rate is real at THAT rung", async () => {
			applyObservedEngineDevices([OSMO_H264]);
			const result = await call(
				setConfigProcedure,
				{ source: "video1", resolution: "720p", framerate: 60 },
				{ context: makeContext() },
			);
			expect(result.success).toBe(true);
		});

		test("1080p60 IS accepted on the same hardware selected as MJPEG", async () => {
			applyObservedEngineDevices([OSMO_MJPEG]);
			const result = await call(
				setConfigProcedure,
				{ source: "video2", resolution: "1080p", framerate: 60 },
				{ context: makeContext() },
			);
			expect(result.success).toBe(true);
		});

		test("2160p is refused on H.264 and accepted on MJPEG", async () => {
			applyObservedEngineDevices([OSMO_H264, OSMO_MJPEG]);
			const refused = await call(
				setConfigProcedure,
				{ source: "video1", resolution: "2160p", framerate: 30 },
				{ context: makeContext() },
			);
			expect(refused.success).toBe(false);
			expect(refused.error).toBe("device_mode_unsupported");

			const accepted = await call(
				setConfigProcedure,
				{ source: "video2", resolution: "2160p", framerate: 30 },
				{ context: makeContext() },
			);
			expect(accepted.success).toBe(true);
		});

		test("a single-signal HDMI receiver still allows DOWNSCALE (ceiling, not menu)", async () => {
			applyObservedEngineDevices([HDMI_RX]);
			const down = await call(
				setConfigProcedure,
				{ source: "video0", resolution: "720p", framerate: 30 },
				{ context: makeContext() },
			);
			expect(down.success).toBe(true);

			const up = await call(
				setConfigProcedure,
				{ source: "video0", resolution: "2160p", framerate: 30 },
				{ context: makeContext() },
			);
			expect(up.success).toBe(false);
			expect(up.error).toBe("device_mode_unsupported");
		});
	});

	// ── The persistence guarantee ──────────────────────────────────────────────
	describe("the persistence write NEVER happens for an invalid combo", () => {
		test("a refused save leaves resolution/framerate untouched on disk", async () => {
			applyObservedEngineDevices([OSMO_H264]);
			const config = getConfig();
			config.source = "video1";
			config.resolution = "1080p";
			config.framerate = 30;

			const result = await call(
				setConfigProcedure,
				{ resolution: "1080p", framerate: 60 },
				{ context: makeContext() },
			);

			expect(result.success).toBe(false);
			expect(config.resolution).toBe("1080p");
			expect(config.framerate).toBe(30);
		});

		test("a refused save does not partially apply UNRELATED fields either", async () => {
			applyObservedEngineDevices([OSMO_H264]);
			const config = getConfig();
			config.source = "video1";
			const priorBitrate = config.max_br;

			const result = await call(
				setConfigProcedure,
				{ resolution: "1080p", framerate: 60, max_br: 7777 },
				{ context: makeContext() },
			);

			expect(result.success).toBe(false);
			expect(config.max_br).toBe(priorBitrate);
			// Not `toEqual({})`: the output schema fills `relay_protocol`'s own
			// default on every response, refused or not. The guarantee under test is
			// that NOTHING the caller asked for was echoed back as applied.
			expect(result.applied.max_br).toBeUndefined();
			expect(result.applied.resolution).toBeUndefined();
			expect(result.applied.framerate).toBeUndefined();
		});

		test("the check reads the source being SAVED, not the one already persisted", async () => {
			applyObservedEngineDevices([OSMO_H264, OSMO_MJPEG]);
			const config = getConfig();
			// Persisted source is the MJPEG ladder (1080p60 legal there) …
			config.source = "video2";

			// … but this save switches to the H.264 ladder in the SAME call, so the
			// H.264 ladder is what must govern. Validating against the persisted
			// source would wrongly accept it.
			const result = await call(
				setConfigProcedure,
				{ source: "video1", resolution: "1080p", framerate: 60 },
				{ context: makeContext() },
			);
			expect(result.success).toBe(false);
			expect(result.error).toBe("device_mode_unsupported");
			expect(config.source).toBe("video2");
		});
	});

	// ── Fail-open: an unknown must never subtract ─────────────────────────────
	describe("fail-open — no reported ladder means no refusal", () => {
		test("a device the engine reports no caps for accepts anything", async () => {
			applyObservedEngineDevices([device("video3", "uvc_h264", [])]);
			const result = await call(
				setConfigProcedure,
				{ source: "video3", resolution: "2160p", framerate: 60 },
				{ context: makeContext() },
			);
			expect(result.success).toBe(true);
		});

		test("a coarse/virtual source (no device behind it) accepts anything", async () => {
			applyObservedEngineDevices([]);
			const result = await call(
				setConfigProcedure,
				{ source: "test", resolution: "2160p", framerate: 60 },
				{ context: makeContext() },
			);
			expect(result.success).toBe(true);
		});

		test("a save touching neither axis is never gated", async () => {
			applyObservedEngineDevices([OSMO_H264]);
			getConfig().source = "video1";
			getConfig().resolution = "1080p";
			getConfig().framerate = 60;

			const result = await call(
				setConfigProcedure,
				{ max_br: 6000 },
				{ context: makeContext() },
			);
			expect(result.success).toBe(true);
		});
	});

	// ── The half-save case ────────────────────────────────────────────────────
	test("a framerate-only save is checked against the PERSISTED resolution", async () => {
		applyObservedEngineDevices([OSMO_H264]);
		const config = getConfig();
		config.source = "video1";
		config.resolution = "1080p";
		config.framerate = 30;

		// 60 is real on this device — but at 720p, not at the persisted 1080p.
		const result = await call(
			setConfigProcedure,
			{ framerate: 60 },
			{ context: makeContext() },
		);
		expect(result.success).toBe(false);
		expect(result.error).toBe("device_mode_unsupported");
		expect(config.framerate).toBe(30);
	});
});
