import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CerastreamClient } from "@ceralive/cerastream";
import { call } from "@orpc/server";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import type { StreamRunOptions } from "../modules/streaming/streaming-backend.ts";
import { setConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const RUN_OPTS: StreamRunOptions = {
	pipeline: "hdmi",
	host: "127.0.0.1",
	port: 9000,
	streamid: "test",
};

const silentLogger: CerastreamBackendDeps["logger"] = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

function makeFakeClient(schemaVersion: string): {
	client: CerastreamClient;
	calls: Array<{ op: string; params?: unknown }>;
} {
	const calls: Array<{ op: string; params?: unknown }> = [];
	const client = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: schemaVersion,
			engine_version: "test",
		},
		start: async (params: unknown) => {
			calls.push({ op: "start", params });
			return { session_id: "s1", state: "streaming" as const };
		},
		rawRequest: async (method: string, params: unknown) => {
			calls.push({ op: method, params });
			if (method === "start")
				return { session_id: "s1", state: "streaming" as const };
			return {};
		},
		stop: async () => ({ state: "idle" as const }),
		reloadConfig: async (params: unknown) => {
			calls.push({ op: "reload-config", params });
			return { applied: params };
		},
		setBitrate: async (params: { max_bitrate: number }) => ({
			applied: { max_bitrate: params.max_bitrate },
		}),
		switchInput: async (params: { input_id: string; mode: string }) => ({
			active_input: params.input_id,
			mode: params.mode as "manual" | "auto",
		}),
		listDevices: async () => ({ devices: [] }),
		subscribeEvents: async () => ({
			result: { subscribed: [] as never[] },
			close: () => {},
		}),
		previewSession: async () => ({
			session_id: "p1",
			tier: "webcodecs" as const,
			transport: {
				kind: "uds-binary" as const,
				socket: "/run/cerastream/preview.sock" as const,
			},
		}),
		close: async () => {},
	};
	return { client: client as unknown as CerastreamClient, calls };
}

async function startParamsFor(
	config: RuntimeConfig,
): Promise<Record<string, unknown>> {
	const fake = makeFakeClient("0.6.0");
	const backend = new CerastreamBackend({
		connect: async () => fake.client,
		connectOptions: {},
		getConfig: () => config,
		saveConfig: () => {},
		bridge: {
			notify: () => {},
			notificationExists: () => false,
			removeNotification: () => {},
			broadcastStatus: () => {},
			broadcastBuffering: () => {},
		},
		execPath: "cerastream",
		configPath: "/tmp/cerastream-on-air-baseline.json",
		logger: silentLogger,
		getActiveInput: () => undefined,
		isEmbeddedAudioActive: () => false,
	});
	await backend.start(config, RUN_OPTS);
	await backend.settle();
	const started = fake.calls.find((call) => call.op === "start");
	expect(started).toBeDefined();
	return started?.params as Record<string, unknown>;
}

const BASE_CONFIG: RuntimeConfig = {
	pipeline: "libuvch264",
	max_br: 8000,
	srt_latency: 2000,
};
const PASSTHROUGH_VALUES = [undefined, "auto", "force", "off"] as const;
const CODEC_VALUES = [undefined, "h264", "h265"] as const;
const BALANCER_VALUES = [undefined, "adaptive", "fixed", "aimd"] as const;

describe("saved format settings stay pinned in the start request", () => {
	for (const video_passthrough of PASSTHROUGH_VALUES) {
		for (const video_codec of CODEC_VALUES) {
			for (const balancer of BALANCER_VALUES) {
				test(`passthrough=${video_passthrough ?? "absent"}, codec=${video_codec ?? "absent"}, balancer=${balancer ?? "absent"}`, async () => {
					const config: RuntimeConfig = {
						...BASE_CONFIG,
						...(video_passthrough === undefined ? {} : { video_passthrough }),
						...(video_codec === undefined ? {} : { video_codec }),
						...(balancer === undefined ? {} : { balancer }),
					};
					const params = await startParamsFor(config);
					const bitrate = params.bitrate as { balancer: string };

					if (video_passthrough === undefined) {
						expect(params).not.toHaveProperty("video_passthrough");
					} else {
						expect(params.video_passthrough).toBe(video_passthrough);
					}
					if (video_codec === undefined) {
						expect(params).not.toHaveProperty("codec");
					} else {
						expect(params.codec).toBe(video_codec);
					}
					expect(bitrate.balancer).toBe(balancer ?? "adaptive");
				});
			}
		}
	}
});

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

describe("streaming.setConfig preserves saved format settings", () => {
	const config = getConfig();
	let configDirectory: string;
	let previousConfigPath: string;
	let configFilePath: string;
	let previousVideoCodec: RuntimeConfig["video_codec"];

	beforeAll(() => {
		previousConfigPath = getConfigFilePath();
	});

	beforeEach(async () => {
		previousVideoCodec = config.video_codec;
		configDirectory = await mkdtemp(join(tmpdir(), "on-air-baseline-"));
		configFilePath = join(configDirectory, "config.json");
		setConfigFilePath(configFilePath);
	});

	afterEach(async () => {
		config.video_codec = previousVideoCodec;
		setConfigFilePath(previousConfigPath);
		await rm(configDirectory, { recursive: true, force: true });
	});

	afterAll(() => {
		setConfigFilePath(previousConfigPath);
	});

	test("saving H.264 persists the selected codec", async () => {
		config.video_codec = undefined;
		const result = await call(
			setConfigProcedure,
			{ video_codec: "h264" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(getConfig().video_codec).toBe("h264");
		const persisted = JSON.parse(
			await readFile(configFilePath, "utf8"),
		) as RuntimeConfig;
		expect(persisted.video_codec).toBe("h264");
	});

	test("an empty settings save leaves the saved codec in place", async () => {
		config.video_codec = "h264";
		const result = await call(
			setConfigProcedure,
			{},
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(getConfig().video_codec).toBe("h264");
		const persisted = JSON.parse(
			await readFile(configFilePath, "utf8"),
		) as RuntimeConfig;
		expect(persisted.video_codec).toBe("h264");
	});
});
