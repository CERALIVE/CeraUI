/*
 * Audio-backend device-config plumbing.
 *
 * `config.audio_backend` is an OPTIONAL operator override of the engine's audio
 * backend, and its whole contract is what ABSENCE means. There is no CeraUI-side
 * default: an absent selection must serialize NO backend key at all, so the
 * engine's own persisted default (shipped: pipewire) governs. A hardcoded
 * `'alsa'` fallback anywhere on this path would silently revert every existing
 * config in the fleet, none of which carries the key.
 *
 * The regression that proves it is the ABSENT-FIELD case below: a config with no
 * `audio_backend` must produce start AND reload payloads carrying no `backend`.
 *
 * The second contract is honesty: a backend may only be accepted while the
 * engine's capability payload advertises it, and a selection the engine later
 * refuses surfaces the engine's own error — it is never silently swapped for the
 * other arm.
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	type CerastreamClient,
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { call } from "@orpc/server";

import {
	loadJsonConfig,
	writeFileAtomicSync,
} from "../helpers/config-loader.ts";
import {
	RUNTIME_CONFIG_DEFAULTS,
	type RuntimeConfig,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";
import {
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import {
	AUDIO_BACKEND_UNSUPPORTED_ERROR,
	isAudioBackendSupported,
} from "../modules/streaming/audio-backend.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import {
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import type { StreamRunOptions } from "../modules/streaming/streaming-backend.ts";
import {
	getConfigProcedure,
	setConfigProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// ── Engine-serialization harness (mirrors cerastream-start-assembly.test.ts) ──

const RUN_OPTS: StreamRunOptions = {
	pipeline: "hdmi",
	host: "127.0.0.1",
	port: 9000,
};

const silentLogger: CerastreamBackendDeps["logger"] = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

interface FakeHarness {
	client: CerastreamClient;
	calls: Array<{ op: string; params?: unknown }>;
}

function makeFakeClient(schemaVersion: string): FakeHarness {
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
		close: async () => {},
	};
	return { client: client as unknown as CerastreamClient, calls };
}

function makeBackend(
	config: RuntimeConfig,
	schemaVersion = "0.4.0",
): { backend: CerastreamBackend; fake: FakeHarness } {
	const fake = makeFakeClient(schemaVersion);
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
		configPath: "/tmp/cerastream-audio-backend.json",
		logger: silentLogger,
		getActiveInput: () => undefined,
		isEmbeddedAudioActive: () => false,
	});
	return { backend, fake };
}

function audioOf(params: unknown): Record<string, unknown> | undefined {
	return (params as { audio?: Record<string, unknown> } | undefined)?.audio;
}

async function startAudioFor(
	config: RuntimeConfig,
): Promise<{ audio: Record<string, unknown> | undefined; params: unknown }> {
	const { backend, fake } = makeBackend(config);
	await backend.start(config, RUN_OPTS);
	await backend.settle();
	const started = fake.calls.find((c) => c.op === "start");
	expect(started).toBeDefined();
	return { audio: audioOf(started?.params), params: started?.params };
}

async function reloadAudioFor(
	config: RuntimeConfig,
): Promise<{ audio: Record<string, unknown> | undefined; params: unknown }> {
	const { backend, fake } = makeBackend(config);
	await backend.start(config, RUN_OPTS);
	await backend.settle();
	backend.reloadConfig();
	await backend.settle();
	const reload = fake.calls.find((c) => c.op === "reload-config");
	expect(reload).toBeDefined();
	return { audio: audioOf(reload?.params), params: reload?.params };
}

const BASE_CONFIG: RuntimeConfig = {
	pipeline: "h264_hdmi_1080p",
	max_br: 8000,
	srt_latency: 2000,
	balancer: "adaptive",
	acodec: "opus",
	delay: -500,
};

describe("engine serialization — a STATED backend reaches the engine", () => {
	test("start params carry audio.backend when the operator selected pipewire", async () => {
		const { audio } = await startAudioFor({
			...BASE_CONFIG,
			audio_backend: "pipewire",
		});
		expect(audio?.backend).toBe("pipewire");
	});

	test("an explicit alsa selection is forwarded verbatim, never coerced", async () => {
		const { audio } = await startAudioFor({
			...BASE_CONFIG,
			audio_backend: "alsa",
		});
		expect(audio?.backend).toBe("alsa");
	});

	test("a reload re-states the selection so the engine holds it next session", async () => {
		const { audio } = await reloadAudioFor({
			...BASE_CONFIG,
			audio_backend: "pipewire",
		});
		expect(audio?.backend).toBe("pipewire");
	});

	test("the selection does not disturb the sibling audio fields", async () => {
		const { audio } = await startAudioFor({
			...BASE_CONFIG,
			audio_backend: "pipewire",
		});
		expect(audio?.codec).toBe("opus");
		expect(audio?.delay_ms).toBe(-500);
	});
});

/*
 * THE MANDATORY REGRESSION. A config.json with no `audio_backend` — which is
 * every config in the fleet today — must reach the engine with NO backend key on
 * either payload, so the engine's own default survives. A CeraUI-side default
 * would pass every other test in this file and fail exactly here.
 */
describe("engine serialization — ABSENT means NO KEY (engine default preserved)", () => {
	test("start params carry an audio section with NO backend key", async () => {
		const { audio } = await startAudioFor(BASE_CONFIG);
		expect(audio).toBeDefined();
		expect(audio).not.toHaveProperty("backend");
	});

	test("reload params carry an audio section with NO backend key", async () => {
		const { audio } = await reloadAudioFor(BASE_CONFIG);
		expect(audio).toBeDefined();
		expect(audio).not.toHaveProperty("backend");
	});

	test("the serialized JSON contains the string 'backend' nowhere", async () => {
		const { params: startParams } = await startAudioFor(BASE_CONFIG);
		const { params: reloadParams } = await reloadAudioFor(BASE_CONFIG);
		expect(JSON.stringify(startParams)).not.toContain("backend");
		expect(JSON.stringify(reloadParams)).not.toContain("backend");
	});

	test("an audio-less config still omits the whole audio section on start", async () => {
		const { audio, params } = await startAudioFor({
			pipeline: "test",
			max_br: 8000,
			srt_latency: 2000,
			balancer: "adaptive",
		});
		expect(audio).toBeUndefined();
		expect(params).not.toHaveProperty("audio");
	});

	test("an audio-less config still omits the whole audio section on reload", async () => {
		const { audio, params } = await reloadAudioFor({
			pipeline: "test",
			max_br: 8000,
			srt_latency: 2000,
			balancer: "adaptive",
		});
		expect(audio).toBeUndefined();
		expect(params).not.toHaveProperty("audio");
	});
});

describe("isAudioBackendSupported — fail-closed on absent evidence", () => {
	test("a backend the engine lists is supported", () => {
		expect(
			isAudioBackendSupported("pipewire", {
				supported: ["alsa", "pipewire"],
				active: "pipewire",
			}),
		).toBe(true);
	});

	test("a backend the engine omits from its own list is NOT supported", () => {
		expect(
			isAudioBackendSupported("pipewire", {
				supported: ["alsa"],
				active: "alsa",
			}),
		).toBe(false);
	});

	test("an absent capability block proves nothing, so nothing is supported", () => {
		expect(isAudioBackendSupported("pipewire", undefined)).toBe(false);
		expect(isAudioBackendSupported("alsa", undefined)).toBe(false);
	});

	test("an empty supported list is not read as 'everything'", () => {
		expect(
			isAudioBackendSupported("alsa", { supported: [], active: "alsa" }),
		).toBe(false);
	});
});

describe("config.json round-trip", () => {
	let tempDir: string;
	let configPath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-backend-config-"));
		configPath = path.join(tempDir, "config.json");
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("a persisted selection round-trips through an atomic write", async () => {
		writeFileAtomicSync(
			configPath,
			JSON.stringify({ max_br: 5000, audio_backend: "pipewire" }),
		);

		const result = await loadJsonConfig(
			configPath,
			runtimeConfigSchema,
			RUNTIME_CONFIG_DEFAULTS,
		);

		expect(result.data.audio_backend).toBe("pipewire");
	});

	test("a config WITHOUT the key stays without it and is never defaulted", async () => {
		fs.writeFileSync(configPath, JSON.stringify({ max_br: 6000 }));

		const result = await loadJsonConfig(
			configPath,
			runtimeConfigSchema,
			RUNTIME_CONFIG_DEFAULTS,
		);

		expect(result.data.audio_backend).toBeUndefined();
		expect(result.defaultedFields).not.toContain("audio_backend");
		expect(RUNTIME_CONFIG_DEFAULTS).not.toHaveProperty("audio_backend");
	});

	test("an unknown backend value is refused rather than coerced", () => {
		expect(
			runtimeConfigSchema.safeParse({ audio_backend: "pulseaudio" }).success,
		).toBe(false);
	});
});

// ── RPC surface (drives the REAL procedures, like capability-truth-save) ─────

type SourceCap = GetCapabilitiesResult["sources"][number];

function source(id: string): SourceCap {
	return {
		id,
		supports_audio: true,
		supports_resolution_override: true,
		supports_framerate_override: true,
		default_resolution: "1080p",
		default_framerate: 30,
	};
}

const CAPS_BASE: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [source("hdmi"), source("test")],
};

function provide(audioBackends: GetCapabilitiesResult["audio_backends"]) {
	return {
		fetchEngineCapabilities: async () => ({
			caps: {
				...CAPS_BASE,
				...(audioBackends !== undefined
					? { audio_backends: audioBackends }
					: {}),
			},
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	};
}

// `lastCapabilities` is module-global, so an uncleared cache would let a previous
// case's `audio_backends` answer this one — and the absent-block case would then
// pass for the wrong reason.
async function useCaps(
	audioBackends: GetCapabilitiesResult["audio_backends"],
): Promise<void> {
	clearCapabilitiesCache();
	await initPipelines(provide(audioBackends));
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

describe("streaming.setConfig / getConfig — capability-gated audio backend", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const CONFIG_PATH = path.resolve("config.json");
	let priorBackend: RuntimeConfig["audio_backend"];
	// `setConfig` persists, so these cases really write the working-directory
	// config.json. Its bytes are restored so the suite leaves no tracked file
	// modified behind it.
	let savedConfigJson: string | undefined;

	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		savedConfigJson = fs.existsSync(CONFIG_PATH)
			? fs.readFileSync(CONFIG_PATH, "utf8")
			: undefined;
		initMockService("caps-full");
		setMockHardware("rk3588");
	});
	beforeEach(() => {
		priorBackend = getConfig().audio_backend;
		getConfig().audio_backend = undefined;
	});
	afterEach(() => {
		getConfig().audio_backend = priorBackend;
		setStreamingState(false);
		updateStatus(false);
		resetMockState();
	});
	afterAll(async () => {
		stopMockService();
		setMockHardware("rk3588");
		clearCapabilitiesCache();
		await initPipelines();
		if (savedConfigJson !== undefined)
			fs.writeFileSync(CONFIG_PATH, savedConfigJson);
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
	});

	test("a supported backend is accepted, persisted and echoed in applied", async () => {
		await useCaps({ supported: ["alsa", "pipewire"], active: "pipewire" });
		const result = await call(
			setConfigProcedure,
			{ audio_backend: "pipewire" },
			{ context: makeContext() },
		);
		expect(result.success).toBe(true);
		expect(result.applied.audio_backend).toBe("pipewire");
		expect(getConfig().audio_backend).toBe("pipewire");
	});

	test("a backend the engine never advertised is REFUSED, and nothing is written", async () => {
		await useCaps({ supported: ["alsa"], active: "alsa" });
		const result = await call(
			setConfigProcedure,
			{ audio_backend: "pipewire" },
			{ context: makeContext() },
		);
		expect(result.success).toBe(false);
		expect(result.error).toBe(AUDIO_BACKEND_UNSUPPORTED_ERROR);
		expect(result.applied).not.toHaveProperty("audio_backend");
		expect(getConfig().audio_backend).toBeUndefined();
	});

	test("an ABSENT capability block refuses too — an unverifiable claim is not made", async () => {
		await useCaps(undefined);
		const result = await call(
			setConfigProcedure,
			{ audio_backend: "pipewire" },
			{ context: makeContext() },
		);
		expect(result.success).toBe(false);
		expect(result.error).toBe(AUDIO_BACKEND_UNSUPPORTED_ERROR);
		expect(getConfig().audio_backend).toBeUndefined();
	});

	test("a refusal leaves the rest of the same save unwritten (gate precedes mutation)", async () => {
		await useCaps({ supported: ["alsa"], active: "alsa" });
		const priorMaxBr = getConfig().max_br;
		const result = await call(
			setConfigProcedure,
			{ audio_backend: "pipewire", max_br: 4321 },
			{ context: makeContext() },
		);
		expect(result.success).toBe(false);
		expect(getConfig().max_br).toBe(priorMaxBr);
	});

	test("a save that never mentions the backend is not gated at all", async () => {
		await useCaps(undefined);
		const result = await call(
			setConfigProcedure,
			{ max_br: 4321 },
			{ context: makeContext() },
		);
		expect(result.success).toBe(true);
		expect(getConfig().audio_backend).toBeUndefined();
	});

	test("getConfig echoes a stated selection", async () => {
		await useCaps({ supported: ["alsa", "pipewire"], active: "pipewire" });
		await call(
			setConfigProcedure,
			{ audio_backend: "pipewire" },
			{ context: makeContext() },
		);
		const echoed = await call(
			getConfigProcedure,
			{},
			{ context: makeContext() },
		);
		expect(echoed.audio_backend).toBe("pipewire");
	});

	test("getConfig omits the field when nothing was ever selected", async () => {
		await useCaps({ supported: ["alsa", "pipewire"], active: "pipewire" });
		const echoed = await call(
			getConfigProcedure,
			{},
			{ context: makeContext() },
		);
		expect(echoed.audio_backend).toBeUndefined();
	});
});
