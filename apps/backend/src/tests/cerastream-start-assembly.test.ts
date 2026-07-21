import { describe, expect, test } from "bun:test";

import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type CerastreamClient,
	readCerastreamConfig,
} from "@ceralive/cerastream";
import { fromEngineResolution, toEngineResolution } from "@ceraui/rpc/schemas";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
	supportsSignedReloadDelay,
} from "../modules/streaming/cerastream-backend.ts";
import type { StreamRunOptions } from "../modules/streaming/streaming-backend.ts";

// Todo 18 — start/reload assembly. Drives a real CerastreamBackend against an
// in-memory fake control client and inspects the exact params handed to the
// engine, proving every encode/input/audio field is forwarded (pixel-form
// resolution, signed delay verbatim), absent fields are omitted, and the
// reload-delay path routes by the engine's hello schema_version.

const RUN_OPTS: StreamRunOptions = {
	pipeline: "hdmi",
	host: "127.0.0.1",
	port: 9000,
	reducedPacketSize: false,
};

const silentLogger: CerastreamBackendDeps["logger"] = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

type RecordingLogger = CerastreamBackendDeps["logger"] & {
	infos: Array<{ message: string; meta?: unknown }>;
};

function recordingLogger(): RecordingLogger {
	const infos: Array<{ message: string; meta?: unknown }> = [];
	return {
		infos,
		debug() {},
		info(message, meta) {
			infos.push({ message, meta });
		},
		warn() {},
		error() {},
	};
}

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

function makeBackend(
	config: RuntimeConfig,
	opts: {
		schemaVersion?: string;
		activeInput?: string;
		logger?: CerastreamBackendDeps["logger"];
		configPath?: string;
		isEmbeddedAudioActive?: CerastreamBackendDeps["isEmbeddedAudioActive"];
	} = {},
): { backend: CerastreamBackend; fake: FakeHarness } {
	const fake = makeFakeClient(opts.schemaVersion ?? "0.4.0");
	const backend = new CerastreamBackend({
		connect: async () => fake.client,
		connectOptions: {},
		getConfig: () => config,
		saveConfig: () => {},
		bridge: {
			notify: () => {},
			notificationExists: () => false,
			broadcastStatus: () => {},
			broadcastBuffering: () => {},
		},
		execPath: "cerastream",
		configPath: opts.configPath ?? "/tmp/cerastream-assembly.json",
		logger: opts.logger ?? silentLogger,
		getActiveInput: () => opts.activeInput,
		isEmbeddedAudioActive: opts.isEmbeddedAudioActive ?? (() => false),
	});
	return { backend, fake };
}

async function startParamsFor(
	config: RuntimeConfig,
	opts: Parameters<typeof makeBackend>[1] = {},
): Promise<Record<string, unknown>> {
	const { backend, fake } = makeBackend(config, opts);
	backend.start(config, RUN_OPTS);
	await backend.settle();
	const started = fake.calls.find((c) => c.op === "start");
	expect(started).toBeDefined();
	return started?.params as Record<string, unknown>;
}

const FULL_CONFIG: RuntimeConfig = {
	pipeline: "h264_hdmi_1080p",
	max_br: 8000,
	srt_latency: 2000,
	balancer: "adaptive",
	selected_video_input: "/dev/video0",
	video_codec: "h265",
	resolution: "1080p",
	framerate: 30,
	asrc: "HDMI",
	acodec: "opus",
	delay: -2000,
};

describe("buildStartParams — full config forwards every field", () => {
	test("all encode/input/audio fields land on StartParams with pixel-form resolution", async () => {
		const params = await startParamsFor(FULL_CONFIG);
		expect(params.input_id).toBe("/dev/video0");
		expect(params.codec).toBe("h265");
		expect(params.resolution).toBe("1920x1080");
		expect(params.framerate).toBe(30);
		expect(params.audio).toEqual({
			// A real device selection resolves to mode:"device" + its ALSA id.
			// getAudioSrcId("HDMI") → "rockchiphdmiin" only on rk3588; on a dev
			// host the alias table has no HDMI entry, so it passes through as-is.
			mode: "device",
			device: (params.audio as { device: string }).device,
			codec: "opus",
			delay_ms: -2000,
		});
	});

	test("signed audio delay is forwarded VERBATIM (a -2000 stays -2000)", async () => {
		const params = await startParamsFor({ ...FULL_CONFIG, delay: -2000 });
		expect((params.audio as { delay_ms: number }).delay_ms).toBe(-2000);
	});

	test("a UI resolution token is never sent on the wire", async () => {
		const params = await startParamsFor(FULL_CONFIG);
		expect(params.resolution).not.toBe("1080p");
		expect(params.resolution).toBe("1920x1080");
	});
});

describe("buildStartParams — absent fields are omitted (no undefined keys)", () => {
	const MINIMAL: RuntimeConfig = {
		pipeline: "test",
		max_br: 8000,
		srt_latency: 2000,
		balancer: "adaptive",
	};

	test("StartParams carries only pipeline/srt/bitrate when nothing else is set", async () => {
		const params = await startParamsFor(MINIMAL, { activeInput: undefined });
		expect(Object.keys(params).sort()).toEqual(["bitrate", "pipeline", "srt"]);
		expect(params).not.toHaveProperty("input_id");
		expect(params).not.toHaveProperty("codec");
		expect(params).not.toHaveProperty("resolution");
		expect(params).not.toHaveProperty("framerate");
		expect(params).not.toHaveProperty("audio");
	});

	test("audio section is omitted entirely when no audio field is set", async () => {
		const params = await startParamsFor({
			...MINIMAL,
			resolution: "720p",
		});
		expect(params.resolution).toBe("1280x720");
		expect(params).not.toHaveProperty("audio");
	});
});

describe("buildStartParams — embedded network-ingest audio (Task 13)", () => {
	test("mode:default + NO device when the embedded-audio gate is active", async () => {
		const params = await startParamsFor(FULL_CONFIG, {
			isEmbeddedAudioActive: () => true,
		});
		expect(params.audio).toEqual({
			mode: "default",
			codec: "opus",
			delay_ms: -2000,
		});
		expect(params.audio).not.toHaveProperty("device");
	});

	test("mode:device + device id when the gate is inactive (ALSA path)", async () => {
		const params = await startParamsFor(FULL_CONFIG, {
			isEmbeddedAudioActive: () => false,
		});
		expect((params.audio as { mode: string }).mode).toBe("device");
		expect((params.audio as { device: string }).device).toBeTruthy();
	});
});

describe("buildStartParams — pseudo-source → audio.mode wire contract (Todo 17)", () => {
	const BASE: RuntimeConfig = {
		pipeline: "hdmi",
		max_br: 8000,
		srt_latency: 2000,
		balancer: "adaptive",
	};

	test('"No audio" ⇒ mode:"none" with no device (a video-only stream)', async () => {
		const params = await startParamsFor(
			{ ...BASE, asrc: "No audio" },
			{ schemaVersion: "0.6.0" },
		);
		expect(params.audio).toEqual({ mode: "none" });
		expect(params.audio).not.toHaveProperty("device");
	});

	test('"Pipeline default" ⇒ mode:"default" with no device', async () => {
		const params = await startParamsFor(
			{ ...BASE, asrc: "Pipeline default" },
			{ schemaVersion: "0.6.0" },
		);
		expect(params.audio).toEqual({ mode: "default" });
		expect(params.audio).not.toHaveProperty("device");
	});

	test('a real device ⇒ mode:"device" + its ALSA id', async () => {
		const params = await startParamsFor(
			{ ...BASE, asrc: "usbaudio" },
			{ schemaVersion: "0.6.0" },
		);
		expect(params.audio).toEqual({ mode: "device", device: "usbaudio" });
	});

	test("a legacy caller that omits asrc sends NO audio section (compat)", async () => {
		const params = await startParamsFor(BASE, {
			schemaVersion: "0.6.0",
			activeInput: undefined,
		});
		expect(params).not.toHaveProperty("audio");
	});

	test("a ≥0.6.0 engine receives start over the RAW bridge (mode survives)", async () => {
		const { backend, fake } = makeBackend(
			{ ...BASE, asrc: "usbaudio" },
			{ schemaVersion: "0.6.0" },
		);
		backend.start({ ...BASE, asrc: "usbaudio" }, RUN_OPTS);
		await backend.settle();
		const started = fake.calls.find((c) => c.op === "start");
		expect(started).toBeDefined();
		expect((started?.params as { audio?: { mode?: string } }).audio?.mode).toBe(
			"device",
		);
	});
});

describe("buildStartParams — input_id source resolution", () => {
	test("persisted selected_video_input wins over the registry active input", async () => {
		const params = await startParamsFor(
			{ ...FULL_CONFIG, selected_video_input: "/dev/video2" },
			{ activeInput: "/dev/video9" },
		);
		expect(params.input_id).toBe("/dev/video2");
	});

	test("falls back to getActiveInput() when selected_video_input is absent", async () => {
		const { selected_video_input: _drop, ...noSelection } = FULL_CONFIG;
		const params = await startParamsFor(noSelection, {
			activeInput: "/dev/video7",
		});
		expect(params.input_id).toBe("/dev/video7");
	});
});

describe("toEngineConfig — writeConfig round-trips the encode/audio fields", () => {
	test("the persisted engine config carries codec/resolution/framerate/audio/input", () => {
		const path = join(
			tmpdir(),
			`cerastream-engineconfig-${process.pid}-${Date.now()}.json`,
		);
		const { backend } = makeBackend(FULL_CONFIG, { configPath: path });
		backend.writeConfig(FULL_CONFIG);
		const written = readCerastreamConfig(path);
		expect(written.input_id).toBe("/dev/video0");
		expect(written.codec).toBe("h265");
		expect(written.resolution).toBe("1920x1080");
		expect(written.framerate).toBe(30);
		expect(written.audio?.codec).toBe("opus");
		expect(written.audio?.delay_ms).toBe(-2000);
	});
});

describe("resolution map — token ↔ WxH bijection with alias", () => {
	test("toEngineResolution accepts both 2160p and 4k → 3840x2160", () => {
		expect(toEngineResolution("2160p")).toBe("3840x2160");
		expect(toEngineResolution("4k")).toBe("3840x2160");
	});

	test("fromEngineResolution is canonical: 3840x2160 → 2160p only (never 4k)", () => {
		expect(fromEngineResolution("3840x2160")).toBe("2160p");
	});

	test("canonical tokens round-trip", () => {
		for (const token of ["480p", "720p", "1080p", "1440p", "2160p"] as const) {
			expect(fromEngineResolution(toEngineResolution(token))).toBe(token);
		}
	});

	test("an unknown pixel form maps back to undefined", () => {
		expect(fromEngineResolution("123x456")).toBeUndefined();
	});
});

describe("supportsSignedReloadDelay — schema_version gate", () => {
	test("true for >= 0.4.0", () => {
		expect(supportsSignedReloadDelay("0.4.0")).toBe(true);
		expect(supportsSignedReloadDelay("0.5.0")).toBe(true);
		expect(supportsSignedReloadDelay("1.0.0")).toBe(true);
	});

	test("false for < 0.4.0 and unparseable/absent versions", () => {
		expect(supportsSignedReloadDelay("0.3.0")).toBe(false);
		expect(supportsSignedReloadDelay("0.3.9")).toBe(false);
		expect(supportsSignedReloadDelay("test")).toBe(false);
		expect(supportsSignedReloadDelay(undefined)).toBe(false);
	});
});

describe("reloadAudioDelay — delay routing by engine hello version", () => {
	test("a >= 0.4.0 engine receives delay_ms_signed verbatim", async () => {
		const { backend, fake } = makeBackend(FULL_CONFIG, {
			schemaVersion: "0.4.0",
		});
		backend.start(FULL_CONFIG, RUN_OPTS);
		await backend.settle();
		await backend.reloadAudioDelay(-500);
		const reload = fake.calls.find((c) => c.op === "reload-config");
		const audio = (reload?.params as { audio?: Record<string, unknown> }).audio;
		expect(audio?.delay_ms_signed).toBe(-500);
		expect(audio).not.toHaveProperty("delay_ms");
	});

	test("a 0.3.0 engine receives legacy delay_ms=max(0,delay) + one log line", async () => {
		const logger = recordingLogger();
		const { backend, fake } = makeBackend(FULL_CONFIG, {
			schemaVersion: "0.3.0",
			logger,
		});
		backend.start(FULL_CONFIG, RUN_OPTS);
		await backend.settle();
		await backend.reloadAudioDelay(-500);
		const reload = fake.calls.find((c) => c.op === "reload-config");
		const audio = (reload?.params as { audio?: Record<string, unknown> }).audio;
		expect(audio?.delay_ms).toBe(0);
		expect(audio).not.toHaveProperty("delay_ms_signed");
		expect(logger.infos.length).toBe(1);
	});
});

describe("toReloadParams — general reload carries the signed delay", () => {
	test("a >= 0.4.0 engine reload carries delay_ms_signed from config.delay", async () => {
		const { backend, fake } = makeBackend(FULL_CONFIG, {
			schemaVersion: "0.4.0",
		});
		backend.start(FULL_CONFIG, RUN_OPTS);
		await backend.settle();
		backend.reloadConfig();
		await backend.settle();
		const reload = fake.calls.find((c) => c.op === "reload-config");
		const audio = (reload?.params as { audio?: Record<string, unknown> }).audio;
		expect(audio?.delay_ms_signed).toBe(-2000);
	});
});
