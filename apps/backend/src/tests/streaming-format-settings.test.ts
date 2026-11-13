import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	PROTOCOL_VERSION,
	rpcRequestSchema,
	SCHEMA_VERSION,
	startParamsSchema,
} from "@ceralive/cerastream";
import { configMessageSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import {
	getConfig,
	getConfigFilePath,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	CerastreamBackend,
	cerastreamBackend,
} from "../modules/streaming/cerastream-backend.ts";
import { setApplyNowGateForTest } from "../modules/streaming/config-change-bridge.ts";
import {
	getIsStreaming,
	updateStatus,
} from "../modules/streaming/streaming.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import {
	getConfigProcedure,
	setConfigProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

let directory: string;
let previousPath: string;
let previousConfig: ReturnType<typeof getConfig>;
let previousStreaming: boolean;
let server: ReturnType<typeof Bun.listen>;
let backend: CerastreamBackend;
let requests: Array<{ method: string; params?: unknown }>;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "format-settings-"));
	previousPath = getConfigFilePath();
	previousConfig = structuredClone(getConfig());
	previousStreaming = getIsStreaming();
	setConfigFilePath(join(directory, "config.json"));
	Object.assign(getConfig(), {
		pipeline: "libuvch264",
		max_br: 8000,
		srt_latency: 2000,
		balancer: "adaptive",
		video_codec: undefined,
		video_passthrough: undefined,
	});
	requests = [];
	const socketPath = join(directory, "engine.sock");
	server = Bun.listen<{ pending: string }>({
		unix: socketPath,
		socket: {
			open(socket) {
				socket.data = { pending: "" };
			},
			data(socket, bytes) {
				socket.data.pending += bytes.toString();
				const lines = socket.data.pending.split("\n");
				socket.data.pending = lines.pop() ?? "";
				for (const line of lines) {
					const request = rpcRequestSchema.parse(JSON.parse(line));
					requests.push(request);
					let result: unknown;
					switch (request.method) {
						case "hello":
							result = {
								protocol: PROTOCOL_VERSION,
								schema_version: SCHEMA_VERSION,
								engine_version: "test",
							};
							break;
						case "subscribe-events":
							result = { subscribed: [] };
							break;
						case "start":
							result = { session_id: "format-test", state: "streaming" };
							break;
						case "stop":
							result = { state: "idle" };
							break;
						default:
							throw new Error(`Unexpected engine request: ${request.method}`);
					}
					socket.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
					);
				}
			},
		},
	});
	backend = new CerastreamBackend({
		connect,
		connectOptions: { socketPath, autoReconnect: false },
		getConfig,
		saveConfig: () => {},
		configPath: join(directory, "engine.json"),
		getActiveInput: () => undefined,
		isEmbeddedAudioActive: () => false,
		bridge: {
			notify: () => {},
			notificationExists: () => false,
			removeNotification: () => {},
			broadcastStatus: () => {},
			broadcastBuffering: () => {},
		},
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	});
});

afterEach(async () => {
	await backend.confirmStop();
	await backend.settle();
	server.stop(true);
	setApplyNowGateForTest(null);
	for (const key of Object.keys(getConfig())) {
		Reflect.deleteProperty(getConfig(), key);
	}
	Object.assign(getConfig(), previousConfig);
	setConfigFilePath(previousPath);
	updateStatus(previousStreaming);
	await rm(directory, { recursive: true, force: true });
});

async function persistedConfig() {
	return runtimeConfigSchema.parse(await Bun.file(getConfigFilePath()).json());
}

async function nextStart() {
	await backend.start(await persistedConfig(), {
		pipeline: "hdmi",
		host: "127.0.0.1",
		port: 9000,
		streamid: "format-test",
	});
	await backend.settle();
	const request = requests.find((entry) => entry.method === "start");
	expect(request).toBeDefined();
	return startParamsSchema.parse(request?.params);
}

test("fixed balancer persists and reaches the next start", async () => {
	const result = await call(
		setConfigProcedure,
		{ balancer: "fixed" },
		{ context: makeRpcContext() },
	);

	expect(result.success).toBe(true);
	expect(await persistedConfig()).toHaveProperty("balancer", "fixed");
	expect(result.applied).toHaveProperty("balancer", "fixed");
	expect((await nextStart()).bitrate.balancer).toBe("fixed");
});

test("bogus balancer is rejected by input validation without changing disk", async () => {
	saveConfig();
	const before = await Bun.file(getConfigFilePath()).text();

	await expect(
		call(setConfigProcedure, JSON.parse('{"balancer":"bogus"}'), {
			context: makeRpcContext(),
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });

	expect(await Bun.file(getConfigFilePath()).text()).toBe(before);
});

test("null clears a saved codec and the next start omits codec", async () => {
	await call(
		setConfigProcedure,
		{ video_codec: "h264" },
		{ context: makeRpcContext() },
	);
	expect(await persistedConfig()).toHaveProperty("video_codec", "h264");

	const result = await call(
		setConfigProcedure,
		{ video_codec: null },
		{ context: makeRpcContext() },
	);

	expect(result.success).toBe(true);
	expect(await Bun.file(getConfigFilePath()).json()).not.toHaveProperty(
		"video_codec",
	);
	expect(await nextStart()).not.toHaveProperty("codec");
});

test("forced video passthrough remains stored and forwarded", async () => {
	await call(
		setConfigProcedure,
		{ video_passthrough: "force" },
		{ context: makeRpcContext() },
	);

	expect(await persistedConfig()).toHaveProperty("video_passthrough", "force");
	expect((await nextStart()).video_passthrough).toBe("force");
});

test("config broadcast and getConfig carry the saved balancer", async () => {
	const broadcasts: string[] = [];
	const context = makeRpcContext(broadcasts);
	addClient(context.ws);
	try {
		await call(
			setConfigProcedure,
			{ balancer: "fixed" },
			{ context: makeRpcContext() },
		);

		expect(
			broadcasts.map(
				(frame) => configMessageSchema.parse(JSON.parse(frame).config).balancer,
			),
		).toEqual(["fixed"]);
		expect(
			await call(getConfigProcedure, undefined, { context: makeRpcContext() }),
		).toHaveProperty("balancer", "fixed");
	} finally {
		removeClient(context.ws);
	}
});

test.each([false, true])(
	"format saves while streaming persist without calling the engine (apply_now=%s)",
	async (apply_now) => {
		getConfig().video_codec = "h264";
		updateStatus(true);
		const reload = spyOn(cerastreamBackend, "reloadConfig");
		const change = spyOn(cerastreamBackend, "changeConfig");
		const start = spyOn(cerastreamBackend, "start");
		const dispatch = mock(async () => ({
			result: "applied" as const,
			attemptId: "unexpected",
		}));
		setApplyNowGateForTest({ isStreamLive: () => true, dispatch });
		try {
			await call(
				setConfigProcedure,
				{ balancer: "fixed", video_codec: null, apply_now },
				{ context: makeRpcContext() },
			);

			expect(reload).not.toHaveBeenCalled();
			expect(change).not.toHaveBeenCalled();
			expect(start).not.toHaveBeenCalled();
			expect(dispatch).not.toHaveBeenCalled();
			expect(await persistedConfig()).toHaveProperty("balancer", "fixed");
			expect(await Bun.file(getConfigFilePath()).json()).not.toHaveProperty(
				"video_codec",
			);
		} finally {
			reload.mockRestore();
			change.mockRestore();
			start.mockRestore();
		}
	},
);
