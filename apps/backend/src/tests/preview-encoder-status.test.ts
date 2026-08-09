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
import { isPreviewHardwareEncodeCapable } from "@ceraui/rpc";
import {
	capabilitiesMessageSchema,
	type PreviewEncoderRealized,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import type WebSocket from "ws";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { setup } from "../modules/setup.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
	extractPreviewEncoderRealized,
} from "../modules/streaming/cerastream-backend.ts";
import {
	getPreviewEncoderRealizedStatus,
	setMockPreviewEncoderRealizedProvider,
} from "../modules/streaming/preview-encoder-status.ts";
import { sendStatus } from "../modules/ui/status.ts";
import {
	buildInitialStatus,
	getStatusProcedure,
} from "../rpc/procedures/status.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// The preview IPC triple (cerastream 2026.7.6) splits one operator question —
// "is this preview running on the hardware encoder?" — across two channels that
// are live at different times: capability is a PLATFORM fact readable while idle,
// realized is a SESSION fact that only exists while streaming. These tests pin
// each channel to its own surface, pin the four-readings rule that forbids
// collapsing "absent" into "software" or "not capable", and pin that a realized
// reading dies with its session.

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

type PreviewTelemetry = { preview_encoder_realized?: PreviewEncoderRealized };

function makeBackend(): CerastreamBackend {
	const bridge: CerastreamBackendDeps["bridge"] = {
		notify: () => {},
		notificationExists: () => false,
		removeNotification: () => {},
		broadcastStatus: () => {},
		broadcastBuffering: () => {},
	};
	return new CerastreamBackend({
		connect: async () => {
			throw new Error("connect unused in handleEvent tests");
		},
		connectOptions: {},
		getConfig: () => ({}) as RuntimeConfig,
		saveConfig: () => {},
		bridge,
		execPath: "cerastream",
		configPath: "/tmp/cerastream-preview-encoder.json",
		logger: silentLogger,
	});
}

const realizedOf = (backend: CerastreamBackend) =>
	(backend.getTelemetry() as PreviewTelemetry | null)?.preview_encoder_realized;

type StatusEvent = Parameters<CerastreamBackend["handleEvent"]>[0];

const hardwareRealized: PreviewEncoderRealized = {
	selected_element: "hwpreviewenc",
	realized_element: "hwpreviewenc",
	mode: "hardware",
};

const fallbackRealized: PreviewEncoderRealized = {
	selected_element: "hwpreviewenc",
	realized_element: "x264enc",
	mode: "software",
	fallback_reason: { code: "property-failure", property: "bps" },
};

function streamingFrame(realized?: PreviewEncoderRealized): StatusEvent {
	return {
		type: "status",
		seq: 0,
		state: "streaming",
		streaming: true,
		...(realized ? { preview_encoder_realized: realized } : {}),
	} as StatusEvent;
}

const idleFrame = {
	type: "status",
	seq: 9,
	state: "idle",
	streaming: false,
} as StatusEvent;

// ─── (a) live capability — the IDLE-safe channel ────────────────────────────

function makeCaps(
	preview?: GetCapabilitiesResult["preview"],
): GetCapabilitiesResult {
	return {
		platform: {
			supports_h265: true,
			hardware_accelerated: true,
			max_resolution: "3840x2160",
		},
		encoder: {
			codecs: ["H264"],
			bitrate_range: { min: 1000, max: 12000, unit: "kbps" },
		},
		sources: [],
		...(preview ? { preview } : {}),
	};
}

async function fetchCaps(preview?: GetCapabilitiesResult["preview"]) {
	return getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps: makeCaps(preview),
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
		logger: silentLogger,
	});
}

describe("preview_hw_capability rides the idle-safe capability channel", () => {
	beforeEach(() => {
		clearCapabilitiesCache();
	});

	test("a capable board's flag survives the fetch AND the broadcast parse", async () => {
		const resolved = await fetchCaps({
			enabled: true,
			port: 9997,
			bound: true,
			preview_hw_capability: true,
		});

		expect(resolved.preview?.preview_hw_capability).toBe(true);

		const broadcast = capabilitiesMessageSchema.parse(resolved);
		expect(broadcast.preview?.preview_hw_capability).toBe(true);
		expect(isPreviewHardwareEncodeCapable(broadcast)).toBe(true);
	});

	test("a board that publishes no preview encoder reports false, not absence", async () => {
		const resolved = await fetchCaps({
			enabled: true,
			port: 9997,
			bound: true,
			preview_hw_capability: false,
		});

		const broadcast = capabilitiesMessageSchema.parse(resolved);
		expect(broadcast.preview?.preview_hw_capability).toBe(false);
		expect(isPreviewHardwareEncodeCapable(broadcast)).toBe(false);
	});
});

// ─── (b) live realized / fallback — the SESSION-scoped channel ───────────────

describe("preview_encoder_realized rides the live status channel", () => {
	test("a hardware-realized session folds the engine's own pair into telemetry", () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame(hardwareRealized));

		expect(realizedOf(backend)).toEqual(hardwareRealized);
	});

	test("a fallback keeps its reason AND the refused property", () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame(fallbackRealized));

		const realized = realizedOf(backend);
		expect(realized?.mode).toBe("software");
		expect(realized?.selected_element).toBe("hwpreviewenc");
		expect(realized?.realized_element).toBe("x264enc");
		expect(realized?.fallback_reason).toEqual({
			code: "property-failure",
			property: "bps",
		});
	});

	test("a partial frame WHILE streaming retains the last known pair", () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame(fallbackRealized));
		backend.handleEvent(streamingFrame());

		expect(realizedOf(backend)).toEqual(fallbackRealized);
	});

	test("the realized pair rides every status snapshot builder", async () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame(fallbackRealized));
		setMockPreviewEncoderRealizedProvider(() => realizedOf(backend) ?? null);

		expect(getPreviewEncoderRealizedStatus()).toEqual(fallbackRealized);
		expect(statusFrameRealized()).toEqual(fallbackRealized);

		const pulled = await call(getStatusProcedure, undefined, {
			context: makeContext(),
		});
		expect(pulled.preview_encoder_realized).toEqual(fallbackRealized);
		expect(buildInitialStatus().status.preview_encoder_realized).toEqual(
			fallbackRealized,
		);
	});
});

// ─── (c) an OLD engine payload — absence is its own reading ──────────────────

describe("a pre-triple engine payload stays parseable", () => {
	beforeEach(() => {
		clearCapabilitiesCache();
	});

	test("capabilities without preview_hw_capability parse — capability UNKNOWN, toggle hidden", async () => {
		const resolved = await fetchCaps({
			enabled: true,
			port: 9997,
			bound: true,
		});

		const broadcast = capabilitiesMessageSchema.parse(resolved);
		expect(broadcast.preview?.preview_hw_capability).toBeUndefined();
		// Unknown is NOT `false` on the wire, but it hides the control just the same.
		expect(isPreviewHardwareEncodeCapable(broadcast)).toBe(false);
	});

	test("a capability snapshot with no preview block at all parses", async () => {
		const resolved = await fetchCaps();

		const broadcast = capabilitiesMessageSchema.parse(resolved);
		expect(broadcast.preview).toBeUndefined();
		expect(isPreviewHardwareEncodeCapable(broadcast)).toBe(false);
	});

	test("a status frame without preview_encoder_realized never throws and reports nothing", () => {
		const backend = makeBackend();
		expect(() => backend.handleEvent(streamingFrame())).not.toThrow();

		expect(realizedOf(backend)).toBeUndefined();
		expect(extractPreviewEncoderRealized(streamingFrame())).toBeNull();
	});

	test("a malformed pair is refused rather than half-read into a wrong mode", () => {
		expect(extractPreviewEncoderRealized(null)).toBeNull();
		expect(
			extractPreviewEncoderRealized({ preview_encoder_realized: {} }),
		).toBeNull();
		expect(
			extractPreviewEncoderRealized({
				preview_encoder_realized: { realized_element: "x264enc" },
			}),
		).toBeNull();
		expect(
			extractPreviewEncoderRealized({
				preview_encoder_realized: { realized_element: "x264enc", mode: "gpu" },
			}),
		).toBeNull();
	});

	test("absence is NOT software and NOT missing capability", async () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame());
		const legacy = capabilitiesMessageSchema.parse(
			await fetchCaps({ enabled: true, bound: true }),
		);

		expect(realizedOf(backend)).toBeUndefined();
		expect(realizedOf(backend)?.mode).not.toBe("software");
		expect(legacy.preview?.preview_hw_capability).not.toBe(false);
	});
});

// ─── (d) the session boundary — a realized reading cannot outlive its stream ──

describe("stopping a stream clears preview_encoder_realized", () => {
	test("an engine-authored idle frame retires the pair", () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame(fallbackRealized));
		expect(realizedOf(backend)).toBeDefined();

		backend.handleEvent(idleFrame);

		expect(realizedOf(backend)).toBeUndefined();
	});

	test("a stopped session publishes an explicit null, never an omission", () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame(fallbackRealized));
		backend.handleEvent(idleFrame);
		setMockPreviewEncoderRealizedProvider(() => realizedOf(backend) ?? null);

		// An omitted field is PRESERVED by the frontend status merge, so the stale
		// fallback text would survive the stop. Only an explicit null retracts it.
		expect(statusFrameRealized()).toBeNull();
	});
});

// sendStatus/buildInitialStatus fire getSshStatus, which rejects on a stray
// setup.ssh_user a sibling test file may have left behind.
let savedSshUser: string | undefined;
beforeAll(() => {
	savedSshUser = (setup as { ssh_user?: string }).ssh_user;
	(setup as { ssh_user?: string }).ssh_user = undefined;
});
afterAll(() => {
	(setup as { ssh_user?: string }).ssh_user = savedSshUser;
});
afterEach(() => {
	setMockPreviewEncoderRealizedProvider(null);
});

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now(), senderId: "test" },
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

function statusFrameRealized(): PreviewEncoderRealized | null | undefined {
	const sent: string[] = [];
	sendStatus({ send: (f: string) => sent.push(f) } as unknown as WebSocket);
	return (
		JSON.parse(sent[0] as string).status as {
			preview_encoder_realized?: PreviewEncoderRealized | null;
		}
	).preview_encoder_realized;
}
