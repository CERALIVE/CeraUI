/*
 * T18 — the preview-encoder request: persisted by CeraUI, fenced at the start.
 *
 * The engine fixes its preview encoder when it builds the main graph, so a mode
 * that arrives alongside `start` arrives too late — the session is already built
 * with the old one, and nothing surfaces the miss. The fix is a FENCE: the
 * persisted mode is asserted on the engine over a short-lived `reload-config`,
 * and the start waits for it.
 *
 * What each group proves, and how far:
 *
 * (a) ORDERING. Four legs drive the real choke point (`startStream`) with the
 *     argument shape each start ORIGIN produces, and assert the recorded engine
 *     dispatch order. What generalises the four legs to "every origin" is the
 *     SOLE-DISPATCH-SITE test below it: `startStream` is the only place in the
 *     backend that dispatches an engine `start`, and the fence is an earlier
 *     `await` in that same function — so no origin can route around it. The
 *     three restoration sites are covered by their call CHAIN
 *     (`runStreamRestoration` → its launch → `startStream`), pinned by the
 *     routing test, not by re-running boot.
 *
 * (b) REJECTION. A replay the engine refuses, or never answers, must abort the
 *     start with ZERO engine `start` dispatches — and, because the fence runs
 *     before every other side effect, with no sender spawned either.
 *
 * (c) ECHO. set → `applied` → config broadcast → `getConfig` → the bytes on disk
 *     re-parsed by the boot schema, which is what a backend restart actually is.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	configMessageSchema,
	isRetriableStartFailure,
	type PreviewEncodeMode,
	streamingConfigInputSchema,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import {
	type RuntimeConfig,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import { setup } from "../modules/setup.ts";
import * as linkTelemetryModule from "../modules/streaming/link-telemetry.ts";
import type { Pipeline } from "../modules/streaming/pipelines.ts";
import {
	PreviewEncodeRejectedError,
	setPreviewEncodeReplayTransport,
} from "../modules/streaming/preview-encode-replay.ts";
import * as streamingEngineModule from "../modules/streaming/streaming-engine.ts";
import * as processRunnerModule from "../modules/streaming/streamloop/process-runner.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import {
	getConfigProcedure,
	setConfigProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// Snapshot the REAL modules at load time — `mock.module` mutates the namespace
// in place, so the restore in afterAll has to come from here (the rule
// `source-selection-stale-cache.test.ts` already documents).
const realLinkTelemetry = { ...linkTelemetryModule };
const realProcessRunner = { ...processRunnerModule };
const realStreamingEngine = { ...streamingEngineModule };

type EngineDispatch =
	| { readonly kind: "reload-config"; readonly mode: PreviewEncodeMode }
	| { readonly kind: "start" };

let dispatches: EngineDispatch[] = [];
let sendersSpawned = 0;

const fakeSender = {
	proc: { exited: new Promise<number>(() => {}) },
	spawnfile: "srtla_send",
	exitListeners: [],
} as unknown as processRunnerModule.StreamingProcess;

mock.module("../modules/streaming/streamloop/process-runner.ts", () => ({
	...realProcessRunner,
	spawnStreamingLoop: () => {
		sendersSpawned += 1;
		return fakeSender;
	},
	stopProcessAndWait: async () => {},
}));

mock.module("../modules/streaming/link-telemetry.ts", () => ({
	...realLinkTelemetry,
	startLinkTelemetry: () => {},
	stopLinkTelemetry: () => {},
}));

mock.module("../modules/streaming/streaming-engine.ts", () => ({
	...realStreamingEngine,
	getStreamingBackend: () => ({
		setBitrate: () => undefined,
		start: async () => {
			dispatches.push({ kind: "start" });
		},
	}),
}));

// Imported AFTER the mocks so the choke point resolves them.
const { startStream, PREVIEW_ENCODE_REPLAY_FAILED } = await import(
	"../modules/streaming/streamloop/start-stream.ts"
);

const testPipeline = {
	source: "hdmi",
	name: "Test HDMI",
	hardware: "rk3588",
	description: "test pipeline",
	supportsAudio: false,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audio_kind: "none",
} as Pipeline;

/**
 * The engine took the mode — after a round trip that costs real time.
 *
 * The delay is the whole point: a replay that resolved on the microtask queue
 * would still be recorded ahead of `start` even if the fence were fire-and-
 * forget, so a zero-cost mock would pass against the very bug this pins.
 */
const ENGINE_ROUND_TRIP_MS = 25;

function acceptingTransport(): void {
	setPreviewEncodeReplayTransport(async (mode) => {
		await new Promise((resolve) => setTimeout(resolve, ENGINE_ROUND_TRIP_MS));
		dispatches.push({ kind: "reload-config", mode });
	});
}

let ipsFile: string;
let configFile: string;
let tempDir: string;
let savedIpsFile: string | undefined;
let savedConfigFile: string;
let savedConfig: RuntimeConfig;

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

function runStart(configOverride?: Partial<RuntimeConfig>) {
	return startStream(
		testPipeline,
		"192.0.2.10",
		5000,
		"sid",
		{},
		"att_preview",
		configOverride,
	);
}

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), "preview-encode-replay-"));
	ipsFile = join(tempDir, "srtla_ips");
	writeFileSync(ipsFile, "192.0.2.20\n");
	savedIpsFile = setup.ips_file;
	setup.ips_file = ipsFile;
	// The default is a bare `config.json`, resolved against whatever CWD the
	// suite was invoked from — so the round trip below would rewrite a REAL
	// config with this file's fixtures. Persist into the temp dir instead; the
	// round trip reads the same path back, so what it proves is unchanged.
	configFile = join(tempDir, "config.json");
	savedConfigFile = getConfigFilePath();
	setConfigFilePath(configFile);
});

afterAll(() => {
	setup.ips_file = savedIpsFile;
	setConfigFilePath(savedConfigFile);
	rmSync(tempDir, { recursive: true, force: true });
	setPreviewEncodeReplayTransport(null);
	mock.module(
		"../modules/streaming/streamloop/process-runner.ts",
		() => realProcessRunner,
	);
	mock.module(
		"../modules/streaming/link-telemetry.ts",
		() => realLinkTelemetry,
	);
	mock.module(
		"../modules/streaming/streaming-engine.ts",
		() => realStreamingEngine,
	);
});

beforeEach(() => {
	savedConfig = { ...getConfig() };
	dispatches = [];
	sendersSpawned = 0;
	acceptingTransport();
});

afterEach(() => {
	const config = getConfig();
	for (const key of Object.keys(config)) {
		delete (config as Record<string, unknown>)[key];
	}
	Object.assign(config, savedConfig);
	setPreviewEncodeReplayTransport(null);
});

describe("the replay fence — every start waits for the mode", () => {
	// Each leg is named for the ORIGIN whose call shape it reproduces. The three
	// restoration origins reach this function through
	// `runStreamRestoration()` → its launch → `startStream(..., attemptId,
	// markerConfig)`; that chain is pinned by the routing test below, so what the
	// legs add is the ordering under each origin's own argument shape.
	const legs = [
		{
			name: "boot restoration (main.ts runStreamRestoration)",
			override: { pipeline: "hdmi", max_br: 6000 } as Partial<RuntimeConfig>,
		},
		{
			name: "boot-race reconnect loop (engine-reconnect.ts runStreamRestoration)",
			override: { pipeline: "hdmi", max_br: 4000 } as Partial<RuntimeConfig>,
		},
		{
			name: "mid-session engine loss (cerastream-backend.ts runStreamRestoration)",
			override: { pipeline: "hdmi", max_br: 8000 } as Partial<RuntimeConfig>,
		},
		{
			name: "an ordinary operator/autostart start",
			override: undefined,
		},
	] as const;

	for (const leg of legs) {
		test(`reload-config(preview_encode) lands before start — ${leg.name}`, async () => {
			getConfig().previewEncode = "hardware";

			const result = await runStart(leg.override);

			expect(result).toEqual({ success: true });
			expect(dispatches).toEqual([
				{ kind: "reload-config", mode: "hardware" },
				{ kind: "start" },
			]);
		});
	}

	test("an idle engine restart does not latch the replay off — the next start asserts it again", async () => {
		getConfig().previewEncode = "hardware";

		await runStart();
		// The engine is systemd-restarted while the device sits idle. Nothing tells
		// CeraUI, and the engine came back with its own default — so a fence that
		// only fired once would let this second start build in software.
		const afterFirstStart = [...dispatches];
		dispatches = [];

		await runStart();

		expect(afterFirstStart).toEqual([
			{ kind: "reload-config", mode: "hardware" },
			{ kind: "start" },
		]);
		expect(dispatches).toEqual([
			{ kind: "reload-config", mode: "hardware" },
			{ kind: "start" },
		]);
	});

	test("a device that never stated a preference opens no connection at all", async () => {
		getConfig().previewEncode = undefined;
		let transportCalls = 0;
		setPreviewEncodeReplayTransport(async () => {
			transportCalls += 1;
		});

		const result = await runStart();

		expect(result).toEqual({ success: true });
		expect(transportCalls).toBe(0);
		expect(dispatches).toEqual([{ kind: "start" }]);
	});

	test("a persisted `software` is asserted too — it is a stated preference", async () => {
		getConfig().previewEncode = "software";

		await runStart();

		expect(dispatches).toEqual([
			{ kind: "reload-config", mode: "software" },
			{ kind: "start" },
		]);
	});
});

describe("a replay the engine does not take blocks the start outright", () => {
	test("a rejected replay dispatches ZERO starts and spawns no sender", async () => {
		getConfig().previewEncode = "hardware";
		setPreviewEncodeReplayTransport(() =>
			Promise.reject(
				new PreviewEncodeRejectedError("engine refused preview_encode"),
			),
		);

		const result = await runStart();

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toBe(PREVIEW_ENCODE_REPLAY_FAILED);
		expect(result.phase).toBe("connect");
		// Deterministic: the same request fails identically on a re-dial, so the
		// taxonomy must NOT loop the operator through five retries.
		expect(result.failureClass).toBe("engine_internal");
		expect(
			isRetriableStartFailure(
				result.failureClass ?? "engine_internal",
				"connect",
			),
		).toBe(false);
		expect(dispatches).toEqual([]);
		expect(sendersSpawned).toBe(0);
	});

	test("an unreachable engine is a retriable boot race, still with zero starts", async () => {
		getConfig().previewEncode = "hardware";
		setPreviewEncodeReplayTransport(() =>
			Promise.reject(new Error("ENOENT: no such file or directory")),
		);

		const result = await runStart();

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.failureClass).toBe("engine_unavailable");
		// An engine mid-systemd-restart at autostart time must not turn a stated
		// preview preference into a hard start refusal — a device WITHOUT the
		// preference retries across that window, and this one has to as well.
		expect(
			isRetriableStartFailure(
				result.failureClass ?? "engine_unavailable",
				result.phase,
			),
		).toBe(true);
		expect(dispatches).toEqual([]);
		expect(sendersSpawned).toBe(0);
	});
});

describe("the fence covers every start origin, not just the tested ones", () => {
	const backendSrc = join(import.meta.dir, "..");

	async function read(relativePath: string): Promise<string> {
		return Bun.file(join(backendSrc, relativePath)).text();
	}

	test("`startStream` is the SOLE engine-start dispatch site in the backend", async () => {
		const sources = new Bun.Glob("modules/**/*.ts").scan({ cwd: backendSrc });
		const dispatchSites: string[] = [];
		for await (const relativePath of sources) {
			const text = await read(relativePath);
			if (text.includes("getStreamingBackend().start(")) {
				dispatchSites.push(relativePath);
			}
		}

		expect(dispatchSites).toEqual([
			"modules/streaming/streamloop/start-stream.ts",
		]);
	});

	test("the fence is awaited BEFORE that dispatch, in the same function", async () => {
		const text = await read("modules/streaming/streamloop/start-stream.ts");
		const fence = text.indexOf("await replayPreviewEncodeMode()");
		const dispatch = text.indexOf("await getStreamingBackend().start(");

		expect(fence).toBeGreaterThan(-1);
		expect(dispatch).toBeGreaterThan(fence);
	});

	test("all three restoration trigger sites route through runStreamRestoration", async () => {
		for (const site of [
			"main.ts",
			"modules/streaming/engine-reconnect.ts",
			"modules/streaming/cerastream-backend.ts",
		]) {
			expect(await read(site)).toContain("runStreamRestoration()");
		}
		// …whose launch reaches the choke point, closing the chain.
		expect(await read("modules/streaming/stream-restoration.ts")).toContain(
			"streamloop/start-stream.ts",
		);
	});
});

describe("previewEncode survives the full round trip", () => {
	test("set → applied → config broadcast → getConfig → a backend restart", async () => {
		const received: string[] = [];
		const client = {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (message: string) => received.push(message),
		} as unknown as AppWebSocket;
		addClient(client);

		try {
			const saved = await call(
				setConfigProcedure,
				{ previewEncode: "hardware" },
				{ context: makeContext() },
			);

			expect(saved.success).toBe(true);
			expect(saved.applied?.previewEncode).toBe("hardware");
			expect(getConfig().previewEncode).toBe("hardware");

			const broadcast = received
				.map((raw) => JSON.parse(raw) as { config?: unknown })
				.filter((message) => message.config !== undefined)
				.map((message) => configMessageSchema.parse(message.config));
			expect(broadcast.at(-1)?.previewEncode).toBe("hardware");

			const pulled = await call(
				getConfigProcedure,
				{},
				{ context: makeContext() },
			);
			expect(pulled.previewEncode).toBe("hardware");

			// A backend restart is exactly this: the bytes that reached disk, read
			// back through the schema boot parses them with.
			const reloaded = runtimeConfigSchema.parse(
				JSON.parse(await Bun.file(configFile).text()),
			);
			expect(reloaded.previewEncode).toBe("hardware");
		} finally {
			removeClient(client);
		}
	});

	test("the value the operator last saved is the one the fence replays", async () => {
		await call(
			setConfigProcedure,
			{ previewEncode: "hardware" },
			{ context: makeContext() },
		);
		await call(
			setConfigProcedure,
			{ previewEncode: "software" },
			{ context: makeContext() },
		);

		await runStart();

		expect(dispatches).toEqual([
			{ kind: "reload-config", mode: "software" },
			{ kind: "start" },
		]);
	});
});

describe("every previewEncode surface stays additive", () => {
	test("a setConfig payload without previewEncode still parses", () => {
		const legacy = streamingConfigInputSchema.parse({ max_br: 6000 });

		expect(legacy.previewEncode).toBeUndefined();
		expect(legacy.max_br).toBe(6000);
	});

	test("a config message without previewEncode still parses", () => {
		expect(
			configMessageSchema.parse({ max_br: 6000 }).previewEncode,
		).toBeUndefined();
	});

	test("a config.json written before this field still parses", () => {
		expect(
			runtimeConfigSchema.parse({ max_br: 6000, pipeline: "hdmi" })
				.previewEncode,
		).toBeUndefined();
	});

	test("only the two engine-known modes are accepted, on every surface", () => {
		for (const schema of [
			streamingConfigInputSchema,
			configMessageSchema,
			runtimeConfigSchema,
		]) {
			expect(() => schema.parse({ previewEncode: "auto" })).toThrow();
			expect(schema.parse({ previewEncode: "hardware" }).previewEncode).toBe(
				"hardware",
			);
			expect(schema.parse({ previewEncode: "software" }).previewEncode).toBe(
				"software",
			);
		}
	});
});
