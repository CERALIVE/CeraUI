/*
 * One row per physical camera + per-device mode selection (wave-4 todo 21).
 *
 * Four contracts, all of which were reachable defects before this todo:
 *
 *   (a) the coarse USB-capture placeholder rows ("USB MJPEG" and friends) are a
 *       pipeline, not a device — they render permanently, they cannot be acted
 *       on, and ONE dual-format camera answers to TWO of them. They are gone in
 *       every state; HDMI / network ingest / test pattern are untouched.
 *   (b) the concrete row carries every format the device advertises, and the
 *       operator's pick persists per DEVICE and reaches the engine.
 *   (c) save-time validation intersects the SELECTED mode's ladder only.
 *   (d) a degraded SELECTED capture leg is a persistent snapshot on the source
 *       surface, cleared by the ONE existing recovery seam.
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
import type { RuntimeErrorEvent } from "@ceralive/cerastream";
import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type {
	CaptureCap,
	CaptureDevice,
	CaptureMode,
	DeviceKind,
	NetworkIngest,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import {
	clearSelectedCaptureDegraded,
	getSelectedCaptureDegraded,
	noteSelectedCaptureDegraded,
	setCaptureDegradedPublisherForTest,
} from "../modules/streaming/capture-degraded.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import { fromEngineDevice } from "../modules/streaming/devices.ts";
import {
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import {
	applyObservedEngineDevices,
	buildSources,
	deriveEngineRouting,
	getSourcesMessage,
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

// Both USB pipelines are offered by the engine, which is what makes the MJPEG
// mode routable at all — and what makes the suppression a real assertion rather
// than an artefact of a capability set that never carried the row.
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
		source("libuvch264"),
		source("usb_mjpeg"),
		source("rtmp"),
		source("test"),
	],
};

const CAP_SOURCES: SourceCap[] = CAPS.sources;

function provide() {
	return {
		fetchEngineCapabilities: async () => ({
			caps: CAPS,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	};
}

const NO_INGEST: NetworkIngest = { rtmp: null, srt: null };

function cap(
	width: number,
	height: number,
	framerate: string,
	media_type: string,
): CaptureCap {
	return { width, height, framerate, media_type };
}

const H264 = "video/x-h264";
const MJPEG = "image/jpeg";

/**
 * The board's running example: a DJI Osmo Pocket 3. Its H.264 ladder tops out at
 * 1080p30 while its MJPEG ladder reaches 1080p60 and 2160p30 — so the two
 * genuinely disagree and a union is observably wrong in both directions.
 */
const OSMO_MODES: CaptureMode[] = [
	{
		media_type: H264,
		pipeline_kind: "uvc_h264",
		caps: [
			cap(1920, 1080, "30/1", H264),
			cap(1280, 720, "60/1", H264),
			cap(1280, 720, "30/1", H264),
		],
	},
	{
		media_type: MJPEG,
		pipeline_kind: "mjpeg",
		caps: [
			cap(1920, 1080, "60/1", MJPEG),
			cap(1920, 1080, "30/1", MJPEG),
			cap(3840, 2160, "30/1", MJPEG),
		],
	},
];

/** The RØDE HDMI-to-USB-C: H.264 only. The negative control throughout. */
const RODE_MODES: CaptureMode[] = [
	{
		media_type: H264,
		pipeline_kind: "uvc_h264",
		caps: [cap(1920, 1080, "30/1", H264), cap(1280, 720, "60/1", H264)],
	},
];

function engineDevice(
	input_id: string,
	kind: DeviceKind,
	modes: CaptureMode[],
	displayName: string,
	stableId: string,
): CaptureDevice {
	return fromEngineDevice({
		input_id,
		device_path: `/dev/${input_id}`,
		display_name: displayName,
		media_class: "video",
		kind,
		caps: modes.flatMap((mode) => mode.caps),
		modes,
		stable_id: stableId,
	});
}

const OSMO_STABLE = "usb:2ca3:0023:OSMO";
const RODE_STABLE = "usb:19f7:0003:RODE";

function osmo(inputId = "video1"): CaptureDevice {
	return engineDevice(
		inputId,
		"uvc_h264",
		OSMO_MODES,
		"DJIPocket3: OsmoPocket3",
		OSMO_STABLE,
	);
}

function rode(inputId = "video2"): CaptureDevice {
	return engineDevice(
		inputId,
		"uvc_h264",
		RODE_MODES,
		"RØDE HDMI to USB-C",
		RODE_STABLE,
	);
}

function build(devices: CaptureDevice[]): StreamSource[] {
	return buildSources({
		sources: CAP_SOURCES,
		devices,
		networkIngest: NO_INGEST,
	});
}

function captureRows(sources: StreamSource[]): StreamSource[] {
	return sources.filter((s) => s.origin === "capture");
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

// ── (a) ONE ROW PER PHYSICAL CAMERA ─────────────────────────────────────────

describe("(a) the coarse USB-capture placeholder is gone in every state", () => {
	test("a dual-mode camera produces EXACTLY one row, and no 'USB MJPEG' placeholder", () => {
		const sources = build([osmo()]);

		expect(captureRows(sources).map((s) => s.id)).toEqual(["video1"]);
		expect(sources.some((s) => s.id === "usb_mjpeg")).toBe(false);
		expect(sources.some((s) => s.id === "libuvch264")).toBe(false);
	});

	test("with NO devices at all the placeholders are still absent", () => {
		const sources = build([]);
		expect(sources.map((s) => s.id)).toEqual(["hdmi", "rtmp", "test"]);
	});

	test("a second H.264-only camera adds exactly one more row (RØDE negative control)", () => {
		const sources = build([osmo(), rode()]);
		expect(captureRows(sources).map((s) => s.id)).toEqual(["video1", "video2"]);
		expect(sources.some((s) => s.id === "usb_mjpeg")).toBe(false);
	});

	test("HDMI, network ingest and the test pattern keep their coarse behaviour", () => {
		const sources = build([]);
		const byId = new Map(sources.map((s) => [s.id, s]));
		expect(byId.get("hdmi")?.origin).toBe("coarse");
		expect(byId.get("rtmp")?.origin).toBe("network");
		expect(byId.get("test")?.origin).toBe("virtual");
	});

	test("the HDMI coarse row still survives beside a live USB camera", () => {
		const sources = build([osmo()]);
		expect(sources.some((s) => s.origin === "coarse" && s.id === "hdmi")).toBe(
			true,
		);
	});
});

// ── (b) MODES ON THE ROW + ROUTING ──────────────────────────────────────────

describe("(b) the concrete row carries the device's own mode ladders", () => {
	test("a dual-mode camera publishes BOTH families, each with its own ladder", () => {
		const row = captureRows(build([osmo()]))[0];
		if (row?.origin !== "capture") throw new Error("expected a capture row");

		expect(row.inputModes?.map((m) => m.inputMode)).toEqual([
			"uvc_h264",
			"mjpeg",
		]);

		const h264 = row.inputModes?.find((m) => m.inputMode === "uvc_h264");
		const mjpeg = row.inputModes?.find((m) => m.inputMode === "mjpeg");
		// 1080p60 is real under MJPEG and NOT under H.264 — the ladders are split,
		// never unioned.
		expect(h264?.modes.find((m) => m.width === 1920)?.framerates).not.toContain(
			60,
		);
		expect(mjpeg?.modes.find((m) => m.width === 1920)?.framerates).toContain(
			60,
		);
		expect(mjpeg?.modes.some((m) => m.width === 3840)).toBe(true);
	});

	test("the default selected mode is the engine's scalar kind — H.264", () => {
		const row = captureRows(build([osmo()]))[0];
		if (row?.origin !== "capture") throw new Error("expected a capture row");
		expect(row.selectedInputMode).toBe("uvc_h264");
	});

	test("an H.264-only camera publishes ONE family (no mode-selector clutter)", () => {
		const row = captureRows(build([rode()]))[0];
		if (row?.origin !== "capture") throw new Error("expected a capture row");
		expect(row.inputModes?.map((m) => m.inputMode)).toEqual(["uvc_h264"]);
		expect(row.selectedInputMode).toBe("uvc_h264");
	});

	test("a mode whose pipeline the engine does not offer is never published", () => {
		const sources = buildSources({
			// `usb_mjpeg` withdrawn from the capability set.
			sources: CAP_SOURCES.filter((s) => s.id !== "usb_mjpeg"),
			devices: [osmo()],
			networkIngest: NO_INGEST,
		});
		const row = captureRows(sources)[0];
		if (row?.origin !== "capture") throw new Error("expected a capture row");
		expect(row.inputModes?.map((m) => m.inputMode)).toEqual(["uvc_h264"]);
	});

	test("a pre-0.11.0 engine (no modes) publishes no ladder split at all", () => {
		const legacy = fromEngineDevice({
			input_id: "video1",
			device_path: "/dev/video1",
			display_name: "DJIPocket3: OsmoPocket3",
			media_class: "video",
			kind: "uvc_h264",
			caps: [cap(1920, 1080, "30/1", H264)],
		});
		const row = captureRows(build([legacy]))[0];
		if (row?.origin !== "capture") throw new Error("expected a capture row");
		expect(row.inputModes).toBeUndefined();
		expect(row.modes.length).toBeGreaterThan(0);
	});

	test("routing follows the SELECTED mode's pipeline, not the scalar kind's", () => {
		const sources = build([osmo()]);
		expect(deriveEngineRouting("video1", sources)?.pipeline).toBe("libuvch264");
		expect(deriveEngineRouting("video1", sources, "mjpeg")?.pipeline).toBe(
			"usb_mjpeg",
		);
		// The input_id is the same physical device either way.
		expect(
			deriveEngineRouting("video1", sources, "mjpeg")?.selected_video_input,
		).toBe("video1");
	});

	test("an H.264-only camera keeps routing to libuvch264 under any mode", () => {
		const sources = build([rode()]);
		expect(deriveEngineRouting("video2", sources, "mjpeg")?.pipeline).toBe(
			"libuvch264",
		);
	});
});

// ── (c) + (b) PERSISTENCE THROUGH THE REAL RPC ──────────────────────────────

describe("input_mode persistence + mode-aware validation (real setConfig)", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;
	let prior: ReturnType<typeof getConfig>;

	beforeAll(async () => {
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setMockHardware("rk3588");
		await initPipelines(provide());
	});
	beforeEach(() => {
		const config = getConfig();
		prior = { ...config };
		resetEngineDeviceCache();
		clearSelectedCaptureDegraded();
		config.source = undefined;
		config.source_stable_id = undefined;
		config.input_mode = undefined;
		config.pipeline = undefined;
		config.resolution = undefined;
		config.framerate = undefined;
		config.selected_video_input = undefined;
		config.last_seen_devices = undefined;
	});
	afterEach(() => {
		const config = getConfig();
		Object.assign(config, prior);
		// `{...config}` cannot carry a key that was ABSENT when it was captured, so
		// a field this suite INTRODUCED must be cleared by name — `bun test` shares
		// one config singleton across every file in the process.
		config.input_mode = prior.input_mode;
		config.source_stable_id = prior.source_stable_id;
		resetEngineDeviceCache();
		clearSelectedCaptureDegraded();
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

	async function save(input: Record<string, unknown>) {
		return call(setConfigProcedure, input, { context: makeContext() });
	}

	test("an unset mode persists nothing — the engine keeps its own precedence", async () => {
		applyObservedEngineDevices([osmo()]);
		const result = await save({ source: "video1" });
		expect(result.success).toBe(true);
		expect(getConfig().input_mode).toBeUndefined();
		expect(getConfig().pipeline).toBe("libuvch264");
	});

	test("a chosen mode persists AND moves the pipeline (round-trip)", async () => {
		applyObservedEngineDevices([osmo()]);
		await save({ source: "video1" });

		const result = await save({ input_mode: "mjpeg" });
		expect(result.success).toBe(true);
		expect(result.applied.input_mode).toBe("mjpeg");
		expect(getConfig().input_mode).toBe("mjpeg");
		expect(getConfig().pipeline).toBe("usb_mjpeg");

		// It survives a rebuild of the source list, and the row reports it.
		const row = getSourcesMessage().sources.find((s) => s.id === "video1");
		if (row?.origin !== "capture") throw new Error("expected a capture row");
		expect(row.selectedInputMode).toBe("mjpeg");
	});

	test("a mode the device does not advertise is REFUSED, disk untouched", async () => {
		applyObservedEngineDevices([rode()]);
		await save({ source: "video2" });

		const result = await save({ input_mode: "mjpeg" });
		expect(result.success).toBe(false);
		expect(result.error).toBe("input_mode_unsupported");
		expect(getConfig().input_mode).toBeUndefined();
		expect(getConfig().pipeline).toBe("libuvch264");
	});

	test("selecting DIFFERENT hardware clears the mode instead of inheriting it", async () => {
		applyObservedEngineDevices([osmo(), rode()]);
		await save({ source: "video1" });
		await save({ input_mode: "mjpeg" });
		expect(getConfig().input_mode).toBe("mjpeg");

		await save({ source: "video2" });
		expect(getConfig().input_mode).toBeUndefined();
		expect(getConfig().pipeline).toBe("libuvch264");
	});

	test("re-selecting the SAME hardware keeps the mode", async () => {
		applyObservedEngineDevices([osmo()]);
		await save({ source: "video1" });
		await save({ input_mode: "mjpeg" });

		await save({ source: "video1" });
		expect(getConfig().input_mode).toBe("mjpeg");
	});

	// ── (c) the validation table, per SELECTED mode ─────────────────────────

	test("1080p60 is REFUSED while H.264 is the selected mode", async () => {
		applyObservedEngineDevices([osmo()]);
		await save({ source: "video1" });
		const result = await save({ resolution: "1080p", framerate: 60 });
		expect(result.success).toBe(false);
		expect(result.error).toBe("device_mode_unsupported");
	});

	test("the SAME 1080p60 is ACCEPTED once MJPEG is the selected mode", async () => {
		applyObservedEngineDevices([osmo()]);
		await save({ source: "video1" });
		await save({ input_mode: "mjpeg" });

		const result = await save({ resolution: "1080p", framerate: 60 });
		expect(result.success).toBe(true);
		expect(getConfig().resolution).toBe("1080p");
		expect(getConfig().framerate).toBe(60);
	});

	test("2160p30 is MJPEG-only — refused under H.264, accepted under MJPEG", async () => {
		applyObservedEngineDevices([osmo()]);
		await save({ source: "video1" });
		expect((await save({ resolution: "2160p", framerate: 30 })).success).toBe(
			false,
		);

		await save({ input_mode: "mjpeg" });
		expect((await save({ resolution: "2160p", framerate: 30 })).success).toBe(
			true,
		);
	});

	test("switching INTO a mode that cannot deliver the persisted axes is refused", async () => {
		applyObservedEngineDevices([osmo()]);
		await save({ source: "video1" });
		await save({ input_mode: "mjpeg" });
		await save({ resolution: "2160p", framerate: 30 });

		// H.264 tops out at 1080p30, so the pending 2160p30 has nowhere to land.
		const result = await save({ input_mode: "uvc_h264" });
		expect(result.success).toBe(false);
		expect(result.error).toBe("device_mode_unsupported");
		expect(getConfig().input_mode).toBe("mjpeg");
	});

	test("the H.264-only camera's validation is unchanged (negative control)", async () => {
		applyObservedEngineDevices([rode()]);
		await save({ source: "video2" });
		expect((await save({ resolution: "1080p", framerate: 30 })).success).toBe(
			true,
		);
		expect((await save({ resolution: "1080p", framerate: 60 })).success).toBe(
			false,
		);
	});
});

// ── (d) THE DEGRADED-SELECTED SNAPSHOT ──────────────────────────────────────

describe("(d) the degraded-selected snapshot rides the sources payload", () => {
	beforeEach(() => {
		setCaptureDegradedPublisherForTest(() => {});
		clearSelectedCaptureDegraded();
	});
	afterEach(() => {
		clearSelectedCaptureDegraded();
		setCaptureDegradedPublisherForTest(undefined);
	});

	function degradedBuild(devices: CaptureDevice[]): StreamSource[] {
		return buildSources({
			sources: CAP_SOURCES,
			devices,
			networkIngest: NO_INGEST,
			...(getSelectedCaptureDegraded() !== undefined
				? { degraded: getSelectedCaptureDegraded() }
				: {}),
		});
	}

	test("it lands on the SELECTED row and nowhere else", () => {
		noteSelectedCaptureDegraded({
			sourceId: "video1",
			stableId: OSMO_STABLE,
			state: { code: "capture_video_error", reason: "no_frames" },
		});

		const rows = captureRows(degradedBuild([osmo(), rode()]));
		const [selected, other] = rows;
		if (selected?.origin !== "capture" || other?.origin !== "capture") {
			throw new Error("expected two capture rows");
		}
		expect(selected.degraded).toEqual({
			code: "capture_video_error",
			reason: "no_frames",
		});
		expect(other.degraded).toBeUndefined();
	});

	test("it follows the device across a renumber (stable identity, not node path)", () => {
		noteSelectedCaptureDegraded({
			sourceId: "video1",
			stableId: OSMO_STABLE,
			state: { code: "capture_video_error" },
		});
		// A libuvc camera renumbers on the very next release.
		const rows = captureRows(degradedBuild([osmo("video7")]));
		const row = rows[0];
		if (row?.origin !== "capture") throw new Error("expected a capture row");
		expect(row.degraded?.code).toBe("capture_video_error");
	});

	test("a device with no snapshot carries no degraded state", () => {
		const rows = captureRows(degradedBuild([osmo()]));
		const row = rows[0];
		if (row?.origin !== "capture") throw new Error("expected a capture row");
		expect(row.degraded).toBeUndefined();
	});

	test("clearing retracts it and reports whether anything was standing", () => {
		expect(clearSelectedCaptureDegraded()).toBe(false);
		noteSelectedCaptureDegraded({
			sourceId: "video1",
			stableId: OSMO_STABLE,
			state: { code: "capture_video_error" },
		});
		expect(clearSelectedCaptureDegraded()).toBe(true);
		expect(getSelectedCaptureDegraded()).toBeUndefined();
	});

	test("raising and retracting each re-publish the sources payload", () => {
		let published = 0;
		setCaptureDegradedPublisherForTest(() => {
			published += 1;
		});
		noteSelectedCaptureDegraded({
			sourceId: "video1",
			stableId: OSMO_STABLE,
			state: { code: "capture_video_error" },
		});
		expect(published).toBe(1);
		clearSelectedCaptureDegraded();
		expect(published).toBe(2);
		// A clear with nothing standing publishes nothing.
		clearSelectedCaptureDegraded();
		expect(published).toBe(2);
	});
});

// ── (d) THE BACKEND BRIDGE: raise + the ONE inherited clearing seam ──────────

const silentLogger: CerastreamBackendDeps["logger"] = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

/**
 * A control client just complete enough for `start()` to reach a confirmed
 * `streaming` session, so `stop()` acts on a REAL active session rather than
 * short-circuiting on `!this.active`. Only the surface `start`/`stop` touch is
 * implemented.
 */
function makeFakeClient() {
	return {
		hello: { schema_version: SCHEMA_VERSION },
		start: async () => ({ session_id: "s1", state: "streaming" }),
		stop: async () => ({ state: "idle" }),
		subscribeEvents: async () => ({
			result: { subscribed: ["status", "error"] },
			close: () => {},
		}),
		close: async () => {},
		rawRequest: async () => ({ session_id: "s1", state: "streaming" }),
	} as unknown as Awaited<ReturnType<CerastreamBackendDeps["connect"]>>;
}

function makeEngineHarness(opts: { live?: boolean } = {}): {
	backend: CerastreamBackend;
	removed: string[];
} {
	const removed: string[] = [];
	const client = makeFakeClient();
	const backend = new CerastreamBackend({
		connect:
			opts.live === true
				? async () => client
				: async () => {
						throw new Error("connect is unused on the event path");
					},
		connectOptions: {},
		getConfig: () =>
			({
				source: "video1",
				selected_video_input: "video1",
				source_stable_id: OSMO_STABLE,
			}) as RuntimeConfig,
		saveConfig: () => {},
		bridge: {
			notify: () => {},
			notificationExists: () => false,
			removeNotification: (name: string) => {
				removed.push(name);
			},
			broadcastStatus: () => {},
			broadcastBuffering: () => {},
		},
		execPath: "cerastream",
		configPath: "/tmp/cerastream-capture-degraded.json",
		logger: silentLogger,
	});
	return { backend, removed };
}

function engineError(
	code: string,
	extra: Record<string, unknown> = {},
): RuntimeErrorEvent {
	return {
		type: "error",
		seq: 0,
		code,
		source: "engine",
		...extra,
	} as unknown as RuntimeErrorEvent;
}

function statusEvent(
	state: string,
	streaming: boolean,
): Parameters<CerastreamBackend["handleEvent"]>[0] {
	return {
		type: "status",
		seq: 1,
		state,
		streaming,
	} as Parameters<CerastreamBackend["handleEvent"]>[0];
}

describe("(d) capture_video_error + selected:true is the degraded-selected signal", () => {
	beforeEach(() => {
		setCaptureDegradedPublisherForTest(() => {});
		clearSelectedCaptureDegraded();
	});
	afterEach(() => {
		clearSelectedCaptureDegraded();
		setCaptureDegradedPublisherForTest(undefined);
	});

	test("it raises a snapshot bound to the operator's own selection", () => {
		const { backend } = makeEngineHarness();
		backend.handleEvent(
			engineError("capture_video_error", {
				selected: true,
				reason: "no_frames",
			}),
		);

		expect(getSelectedCaptureDegraded()).toEqual({
			sourceId: "video1",
			stableId: OSMO_STABLE,
			state: { code: "capture_video_error", reason: "no_frames" },
		});
	});

	test("the SAME code WITHOUT selected:true raises no snapshot", () => {
		const { backend } = makeEngineHarness();
		backend.handleEvent(engineError("capture_video_error"));
		expect(getSelectedCaptureDegraded()).toBeUndefined();
		backend.handleEvent(
			engineError("capture_video_error", { selected: false }),
		);
		expect(getSelectedCaptureDegraded()).toBeUndefined();
	});

	test("another selected-flagged code raises no snapshot — the pair is the signal", () => {
		const { backend } = makeEngineHarness();
		for (const code of [
			"capture_audio_error",
			"pipeline_stall",
			"capture_unrecoverable",
		]) {
			backend.handleEvent(engineError(code, { selected: true }));
			expect(getSelectedCaptureDegraded()).toBeUndefined();
		}
	});

	// ── the three clearing paths, all through the ONE inherited seam ─────────

	test("CLEAR 1 — rejoin: a concordant streaming status frame retracts it", () => {
		const { backend, removed } = makeEngineHarness();
		backend.handleEvent(engineError("capture_video_error", { selected: true }));
		expect(getSelectedCaptureDegraded()).toBeDefined();

		backend.handleEvent(statusEvent("streaming", true));

		expect(getSelectedCaptureDegraded()).toBeUndefined();
		// the SAME seam retracted the notification — one path, not two.
		expect(removed).toEqual(["cerastream"]);
	});

	test("CLEAR 2 — stop: ending a LIVE session retracts it", async () => {
		const { backend } = makeEngineHarness({ live: true });
		await backend.start(
			{ pipeline: "libuvch264" } as RuntimeConfig,
			{
				host: "127.0.0.1",
				port: 9000,
				pipeline: "libuvch264",
			} as never,
		);
		// Raised AFTER the start, so the start's own clear cannot be what passes.
		backend.handleEvent(engineError("capture_video_error", { selected: true }));
		expect(getSelectedCaptureDegraded()).toBeDefined();

		expect(backend.stop(() => {})).toBe(true);

		expect(getSelectedCaptureDegraded()).toBeUndefined();
	});

	test("CLEAR 3 — new session: a start never inherits the previous failure", async () => {
		const { backend } = makeEngineHarness();
		backend.handleEvent(engineError("capture_video_error", { selected: true }));
		expect(getSelectedCaptureDegraded()).toBeDefined();

		await backend
			.start({} as RuntimeConfig, {} as never)
			.catch(() => undefined);

		expect(getSelectedCaptureDegraded()).toBeUndefined();
	});

	test("an IDLE status frame is not proof — the snapshot stands", () => {
		const { backend } = makeEngineHarness();
		backend.handleEvent(engineError("capture_video_error", { selected: true }));

		backend.handleEvent(statusEvent("idle", false));
		backend.handleEvent(statusEvent("starting", false));

		expect(getSelectedCaptureDegraded()).toBeDefined();
	});

	test("a later error taking the SHARED notification slot cannot latch the snapshot", () => {
		const { backend, removed } = makeEngineHarness();
		backend.handleEvent(engineError("capture_video_error", { selected: true }));
		// `srt_connection_lost` now occupies the shared `cerastream` slot, so the
		// notification correctly stays; the capture claim must NOT ride along.
		backend.handleEvent(engineError("srt_connection_lost"));

		backend.handleEvent(statusEvent("streaming", true));

		expect(removed).toEqual([]);
		expect(getSelectedCaptureDegraded()).toBeUndefined();
	});

	test("the snapshot reaches the sources payload's top level too", () => {
		const { backend } = makeEngineHarness();
		backend.handleEvent(
			engineError("capture_video_error", {
				selected: true,
				reason: "no_frames",
			}),
		);
		const snapshot = getSelectedCaptureDegraded();
		const message = {
			...buildSourcesMessageFor([osmo()], snapshot),
		};
		expect(message.degradedSelected).toEqual({
			code: "capture_video_error",
			reason: "no_frames",
		});
	});
});

function buildSourcesMessageFor(
	devices: CaptureDevice[],
	degraded: ReturnType<typeof getSelectedCaptureDegraded>,
): { sources: StreamSource[]; degradedSelected?: unknown } {
	const sources = buildSources({
		sources: CAP_SOURCES,
		devices,
		networkIngest: NO_INGEST,
		...(degraded !== undefined ? { degraded } : {}),
	});
	return {
		sources,
		...(degraded !== undefined ? { degradedSelected: degraded.state } : {}),
	};
}
