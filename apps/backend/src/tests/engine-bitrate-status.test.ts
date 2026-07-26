import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import type { EngineBitrate } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import type WebSocket from "ws";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { setup } from "../modules/setup.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import {
	extractEngineBitrate,
	getEngineBitrateStatus,
	setMockEngineBitrateProvider,
} from "../modules/streaming/engine-bitrate-status.ts";
import { sendStatus } from "../modules/ui/status.ts";
import {
	buildInitialStatus,
	getStatusProcedure,
} from "../rpc/procedures/status.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// Wave H QA reported "configured 5 Mbps, only ~3 Mbps on the wire". The engine
// was behaving correctly — cerastream's adaptive controller had throttled the
// encoder below the ceiling because the link could not carry it — but CeraUI
// published only `config.max_br`, so every operator surface reported the REQUEST
// as though it were the RESULT. These tests pin the applied-vs-configured split
// end to end: the resolver, the session boundary, and the wire.

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

type BitrateTelemetry = { bitrate?: { current: number; max: number } };

function makeBackend(): CerastreamBackend {
	const bridge: CerastreamBackendDeps["bridge"] = {
		notify: () => {},
		notificationExists: () => false,
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
		configPath: "/tmp/cerastream-engine-bitrate.json",
		logger: silentLogger,
	});
}

const bitrateOf = (backend: CerastreamBackend) =>
	(backend.getTelemetry() as BitrateTelemetry | null)?.bitrate;

const streamingFrame = {
	type: "status",
	seq: 0,
	state: "streaming",
	streaming: true,
} as Parameters<CerastreamBackend["handleEvent"]>[0];

const throttledBitrate = {
	type: "bitrate",
	seq: 1,
	current_bitrate: 3000,
	max_bitrate: 5000,
} as Parameters<CerastreamBackend["handleEvent"]>[0];

describe("cerastream bitrate event folds into telemetry", () => {
	test("a throttled reading keeps the applied rate DISTINCT from the ceiling", () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame);
		backend.handleEvent(throttledBitrate);

		expect(bitrateOf(backend)).toEqual({ current: 3000, max: 5000 });
	});

	test("a partial frame WHILE streaming retains the last known reading", () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame);
		backend.handleEvent(throttledBitrate);

		backend.handleEvent({
			type: "status",
			seq: 2,
			state: "streaming",
			streaming: true,
		} as Parameters<CerastreamBackend["handleEvent"]>[0]);

		expect(bitrateOf(backend)).toEqual({ current: 3000, max: 5000 });
	});

	test("an engine-authored idle frame retires it — a rate cannot outlive its session", () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame);
		backend.handleEvent(throttledBitrate);
		expect(bitrateOf(backend)).toBeDefined();

		backend.handleEvent({
			type: "status",
			seq: 2,
			state: "idle",
			streaming: false,
		} as Parameters<CerastreamBackend["handleEvent"]>[0]);

		expect(bitrateOf(backend)).toBeUndefined();
	});
});

describe("extractEngineBitrate (capability gate)", () => {
	test("projects a complete reading onto the explicit-unit wire pair", () => {
		expect(
			extractEngineBitrate({ bitrate: { current: 3000, max: 5000 } }),
		).toEqual({ applied_kbps: 3000, ceiling_kbps: 5000 });
	});

	test("null for an engine that never reported a bitrate event", () => {
		expect(extractEngineBitrate(null)).toBeNull();
		expect(extractEngineBitrate(undefined)).toBeNull();
		expect(extractEngineBitrate({})).toBeNull();
	});

	test("refuses a half-reading rather than inventing the missing side", () => {
		expect(extractEngineBitrate({ bitrate: { current: 3000 } })).toBeNull();
		expect(extractEngineBitrate({ bitrate: { max: 5000 } })).toBeNull();
		expect(
			extractEngineBitrate({ bitrate: { current: "3000", max: 5000 } }),
		).toBeNull();
		expect(
			extractEngineBitrate({ bitrate: { current: Number.NaN, max: 5000 } }),
		).toBeNull();
	});

	test("an at-ceiling reading is still a real reading, not a gap", () => {
		expect(
			extractEngineBitrate({ bitrate: { current: 5000, max: 5000 } }),
		).toEqual({ applied_kbps: 5000, ceiling_kbps: 5000 });
	});
});

describe("getEngineBitrateStatus", () => {
	test("null when the engine never reported a bitrate event", () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame);
		setMockEngineBitrateProvider(() => null);

		expect(bitrateOf(backend)).toBeUndefined();
		expect(getEngineBitrateStatus()).toBeNull();
	});

	test("null-safe: a provider returning null never throws", () => {
		setMockEngineBitrateProvider(() => null);
		expect(() => getEngineBitrateStatus()).not.toThrow();
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
	setMockEngineBitrateProvider(null);
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

function statusFrameBitrate(): EngineBitrate | null | undefined {
	const sent: string[] = [];
	sendStatus({ send: (f: string) => sent.push(f) } as unknown as WebSocket);
	return (
		JSON.parse(sent[0] as string).status as {
			engine_bitrate?: EngineBitrate | null;
		}
	).engine_bitrate;
}

describe("engine_bitrate reaches the wire", () => {
	test("the throttled pair rides every status snapshot builder", async () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame);
		backend.handleEvent(throttledBitrate);
		setMockEngineBitrateProvider(() => {
			const reading = bitrateOf(backend);
			return reading
				? { applied_kbps: reading.current, ceiling_kbps: reading.max }
				: null;
		});

		const expected: EngineBitrate = {
			applied_kbps: 3000,
			ceiling_kbps: 5000,
		};

		expect(getEngineBitrateStatus()).toEqual(expected);
		expect(statusFrameBitrate()).toEqual(expected);

		const pulled = await call(getStatusProcedure, undefined, {
			context: makeContext([]),
		});
		expect(pulled.engine_bitrate).toEqual(expected);
		expect(buildInitialStatus().status.engine_bitrate).toEqual(expected);
	});

	test("a stopped session publishes an explicit null, never an omission", () => {
		const backend = makeBackend();
		backend.handleEvent(streamingFrame);
		backend.handleEvent(throttledBitrate);
		backend.handleEvent({
			type: "status",
			seq: 2,
			state: "idle",
			streaming: false,
		} as Parameters<CerastreamBackend["handleEvent"]>[0]);
		setMockEngineBitrateProvider(() => {
			const reading = bitrateOf(backend);
			return reading
				? { applied_kbps: reading.current, ceiling_kbps: reading.max }
				: null;
		});

		expect(statusFrameBitrate()).toBeNull();
	});
});
