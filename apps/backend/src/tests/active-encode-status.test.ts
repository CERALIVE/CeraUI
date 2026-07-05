import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import type { ActiveEncode } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import type WebSocket from "ws";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { setup } from "../modules/setup.ts";
import {
	getActiveEncodeStatus,
	setMockActiveEncodeProvider,
} from "../modules/streaming/active-encode-status.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
	extractActiveEncode,
} from "../modules/streaming/cerastream-backend.ts";
import { sendStatus } from "../modules/ui/status.ts";
import {
	buildInitialStatus,
	getStatusProcedure,
} from "../rpc/procedures/status.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// Todo 19: the backend forwards the engine's additive `active_encode` field off
// the cerastream `status` event onto the CeraUI status broadcast — folded into
// telemetry and ridden by the EXISTING broadcastStatus() (no dedicated bridge
// method, unlike buffering). These tests pin the capability gate (absent
// active_encode → nothing) and the fold-into-telemetry path.

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function makeBackend(): {
	backend: CerastreamBackend;
	statusBroadcasts: { count: number };
} {
	const statusBroadcasts = { count: 0 };
	const bridge: CerastreamBackendDeps["bridge"] = {
		notify: () => {},
		notificationExists: () => false,
		broadcastStatus: () => {
			statusBroadcasts.count += 1;
		},
		broadcastBuffering: () => {},
	};
	const backend = new CerastreamBackend({
		connect: async () => {
			throw new Error("connect unused in handleEvent tests");
		},
		connectOptions: {},
		getConfig: () => ({}) as RuntimeConfig,
		saveConfig: () => {},
		bridge,
		execPath: "cerastream",
		configPath: "/tmp/cerastream-active-encode.json",
		logger: silentLogger,
	});
	return { backend, statusBroadcasts };
}

describe("extractActiveEncode (capability gate)", () => {
	test("returns null when the engine does not report active_encode", () => {
		expect(
			extractActiveEncode({ type: "status", seq: 0, streaming: true }),
		).toBeNull();
		expect(extractActiveEncode(null)).toBeNull();
		expect(extractActiveEncode(undefined)).toBeNull();
		expect(extractActiveEncode({ active_encode: "yes" })).toBeNull();
	});

	test("reads codec/resolution/framerate + optional active_input/decoder", () => {
		expect(
			extractActiveEncode({
				active_encode: {
					codec: "h265",
					resolution: "1920x1080",
					framerate: 30,
					active_input: "cam-0",
					decoder: "nvv4l2decoder",
				},
			}),
		).toEqual({
			codec: "h265",
			resolution: "1920x1080",
			framerate: 30,
			active_input: "cam-0",
			decoder: "nvv4l2decoder",
		});
	});

	test("returns a minimal payload when the optional fields are absent", () => {
		expect(
			extractActiveEncode({
				active_encode: { codec: "h264", resolution: "852x480", framerate: 60 },
			}),
		).toEqual({ codec: "h264", resolution: "852x480", framerate: 60 });
	});

	test("returns null on a partial/malformed active_encode (missing required)", () => {
		expect(
			extractActiveEncode({ active_encode: { codec: "h264", framerate: 30 } }),
		).toBeNull();
		expect(
			extractActiveEncode({
				active_encode: { codec: "h264", resolution: "852x480", framerate: "x" },
			}),
		).toBeNull();
	});
});

describe("CerastreamBackend active_encode bridge", () => {
	test("a status event with active_encode folds it into telemetry + rides broadcastStatus", () => {
		const { backend, statusBroadcasts } = makeBackend();

		backend.handleEvent({
			type: "status",
			seq: 0,
			state: "streaming",
			streaming: true,
			active_encode: {
				codec: "h265",
				resolution: "3840x2160",
				framerate: 30,
				active_input: "cam-0",
			},
		} as Parameters<CerastreamBackend["handleEvent"]>[0]);

		expect(statusBroadcasts.count).toBe(1);
		const telemetry = backend.getTelemetry() as {
			active_encode?: ActiveEncode;
		};
		expect(telemetry.active_encode).toEqual({
			codec: "h265",
			resolution: "3840x2160",
			framerate: 30,
			active_input: "cam-0",
		});
	});

	test("a plain status event (no active_encode) leaves telemetry without the field (capability absent)", () => {
		const { backend, statusBroadcasts } = makeBackend();

		backend.handleEvent({
			type: "status",
			seq: 1,
			state: "streaming",
			streaming: true,
		});

		expect(statusBroadcasts.count).toBe(1);
		const telemetry = backend.getTelemetry() as {
			active_encode?: ActiveEncode;
		};
		expect(telemetry.active_encode).toBeUndefined();
	});
});

describe("extractActiveEncode — input_codec whitelist (T14)", () => {
	test("copies a string input_codec off the event", () => {
		const ae = extractActiveEncode({
			active_encode: {
				codec: "h265",
				resolution: "1920x1080",
				framerate: 30,
				input_codec: "h264",
			},
		});
		expect(ae?.input_codec).toBe("h264");
	});

	test("omits a non-string / absent input_codec (older engine, malformed)", () => {
		const absent = extractActiveEncode({
			active_encode: { codec: "h265", resolution: "1920x1080", framerate: 30 },
		});
		expect(absent?.input_codec).toBeUndefined();
		const bad = extractActiveEncode({
			active_encode: {
				codec: "h265",
				resolution: "1920x1080",
				framerate: 30,
				input_codec: 7,
			},
		});
		expect(bad?.input_codec).toBeUndefined();
	});
});

// sendStatus/buildInitialStatus fire getSshStatus, which rejects on a stray
// setup.ssh_user a sibling test file may have left behind (see
// network-ingest-initial-status.test.ts). Clear it for the snapshot builds.
let savedSshUser: string | undefined;
beforeAll(() => {
	savedSshUser = (setup as { ssh_user?: string }).ssh_user;
	(setup as { ssh_user?: string }).ssh_user = undefined;
});
afterAll(() => {
	(setup as { ssh_user?: string }).ssh_user = savedSshUser;
});
afterEach(() => {
	setMockActiveEncodeProvider(null);
});

function makeContext(sent: string[]): RPCContext {
	const ws = {
		send: (frame: string) => {
			sent.push(frame);
		},
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

const NETWORK_STATUS_EVENT = {
	type: "status",
	seq: 0,
	state: "streaming",
	streaming: true,
	active_encode: {
		codec: "h265",
		resolution: "1920x1080",
		framerate: 30,
		active_input: "rtmp",
		input_codec: "h264",
	},
} as Parameters<CerastreamBackend["handleEvent"]>[0];

describe("active_encode reaches the wire (T14 pre-existing-gap fix)", () => {
	test("a fake status event's input_codec rides the ACTUAL status broadcast payload AND the pull procedure", async () => {
		// handleEvent bypasses the binding parse; the bridge is a no-op — the field
		// must survive extract -> telemetry -> the status snapshot builder onto the wire.
		const { backend } = makeBackend();
		backend.handleEvent(NETWORK_STATUS_EVENT);
		setMockActiveEncodeProvider(
			() =>
				(backend.getTelemetry() as { active_encode?: ActiveEncode } | null)
					?.active_encode ?? null,
		);

		expect(getActiveEncodeStatus()?.input_codec).toBe("h264");

		// The load-bearing assertion: the ACTUAL broadcast frame payload, NOT
		// backend.getTelemetry() — proving the field reaches the wire, not just state.
		const sent: string[] = [];
		sendStatus({ send: (f: string) => sent.push(f) } as unknown as WebSocket);
		const framePayload = JSON.parse(sent[0] as string).status as {
			active_encode?: ActiveEncode;
		};
		expect(framePayload.active_encode?.input_codec).toBe("h264");

		const pulled = await call(getStatusProcedure, undefined, {
			context: makeContext([]),
		});
		expect(pulled.active_encode?.input_codec).toBe("h264");

		expect(buildInitialStatus().status.active_encode?.input_codec).toBe("h264");
	});

	test("null-safe: a provider returning null never throws (falls through to engine telemetry)", () => {
		setMockActiveEncodeProvider(() => null);
		expect(() => getActiveEncodeStatus()).not.toThrow();
	});
});
