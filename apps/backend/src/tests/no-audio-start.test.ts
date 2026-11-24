/**
 * "No audio" belongs to the Start that was accepted with it.
 *
 * A Start waits on several things between the operator's press and the engine
 * request. These tests hold each of them on the real route (the Start RPC, the
 * production orchestrator, session, updateConfig, startStream and the real engine
 * adapter over a fake client) and save another audio pick meanwhile.
 */
import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GetCapabilitiesResult } from "@ceralive/cerastream";
import { SCHEMA_VERSION } from "@ceralive/cerastream";
import type { CaptureStreamSource } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	getConfig,
	getConfigFilePath,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import { setup } from "../modules/setup.ts";
import * as audio from "../modules/streaming/audio.ts";
import * as autoAudio from "../modules/streaming/auto-audio.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import { initPipelines } from "../modules/streaming/pipelines.ts";
import { setPreviewEncodeReplayTransport } from "../modules/streaming/preview-encode-replay.ts";
import * as srtla from "../modules/streaming/srtla.ts";
import { captureArmedStreamConfig } from "../modules/streaming/stream-restoration.ts";
import { noteStreamSessionEngineStatus } from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { autoStartStream } from "../modules/streaming/streamloop/autostart.ts";
import type { StreamingProcess } from "../modules/streaming/streamloop/process-runner.ts";
import * as preparation from "../modules/streaming/streamloop/srtla-ip-preparation.ts";
import {
	setStartStreamDepsForTest,
	startStream,
} from "../modules/streaming/streamloop/start-stream.ts";
import {
	setConfigProcedure,
	streamingStartProcedure,
	streamingStopProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";
import { evidenceHarness } from "./helpers/stream-engine-evidence.ts";

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
		{
			id: "test",
			supports_audio: true,
			supports_resolution_override: true,
			supports_framerate_override: true,
			default_resolution: "1080p",
			default_framerate: 30,
		},
	],
	audio_mix: {
		max_inputs: 4,
		max_tracks: 4,
		gain_db_min: -60,
		gain_db_max: 12,
		delay_ms_max: 2000,
	},
};
const entry = (id: string, tracks: number[]) => ({
	id,
	tracks,
	gain_db: 0,
	mute: false,
	delay_ms: 0,
});
const savedMix = [entry("Primary", [1]), entry("Second", [2])];
const mixOnTheWire = [
	{ ...entry("", [1]), input_id: "hw:CARD=primary" },
	{ ...entry("", [2]), input_id: "hw:CARD=second" },
].map(({ id: _id, ...input }) => input);

let directory: string;
let previousPath: string;
let previousConfig: ReturnType<typeof getConfig>;
let previousIps: string | undefined;
const env = { ...process.env };
let engine: ReturnType<typeof evidenceHarness>;
let probe: { mock: { calls: unknown[][] } };
let gate: ReturnType<typeof Promise.withResolvers<void>>;
let reached: ReturnType<typeof Promise.withResolvers<void>>;

const hold = async () => {
	reached.resolve();
	await gate.promise;
};
const GATES: Record<string, () => void> = {
	"update admission": () => {
		spyOn(streamSessionProductionDeps, "admitUpdate").mockImplementation(
			async () => {
				await hold();
				return { allowed: true };
			},
		);
	},
	"relay address lookup": () => {
		spyOn(srtla, "resolveSrtla").mockImplementation(async (addr) => {
			await hold();
			return addr;
		});
	},
	"bond preparation": () => {
		spyOn(preparation, "prepareSrtlaIpAddresses").mockImplementation(
			async () => {
				await hold();
				return published();
			},
		);
	},
	"preview replay": () => {
		getConfig().previewEncode = "software";
		setPreviewEncodeReplayTransport(hold);
	},
};

const published = () => ({
	ok: true as const,
	generation: 1,
	changed: true,
	sidecarPath: join(directory, "ips.bindmap.json"),
});

beforeEach(async () => {
	delete process.env.MOCK_MODE;
	process.env.NODE_ENV = "test";
	directory = await mkdtemp(join(tmpdir(), "no-audio-start-"));
	process.env.CERALIVE_STREAMING_MARKER = join(directory, "streaming");
	previousPath = getConfigFilePath();
	previousConfig = structuredClone(getConfig());
	previousIps = setup.ips_file;
	setup.ips_file = join(directory, "ips");
	await Bun.write(setup.ips_file, "192.0.2.2\n");
	setConfigFilePath(join(directory, "config.json"));
	for (const key of Object.keys(getConfig()))
		Reflect.deleteProperty(getConfig(), key);
	Object.assign(getConfig(), {
		pipeline: "test",
		asrc: "No audio",
		audio_inputs: structuredClone(savedMix),
		delay: 0,
		max_br: 8000,
		srt_latency: 2000,
		bitrate_overlay: false,
		relay_protocol: "srtla",
		srtla_addr: "127.0.0.1",
		srtla_port: 5000,
		srt_streamid: "no-audio",
	});
	saveConfig();
	audio.setMockAudioDevicesProvider(() => ({
		Primary: "hw:CARD=primary",
		Second: "hw:CARD=second",
		Third: "hw:CARD=third",
	}));
	updateStatus(false);
	clearCapabilitiesCache();
	await initPipelines({
		fetchEngineCapabilities: async () => ({
			caps: CAPS,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
	gate = Promise.withResolvers<void>();
	reached = Promise.withResolvers<void>();
	engine = evidenceHarness(false, { schemaVersion: "0.24.0" });
	setStartStreamDepsForTest({
		getStreamingBackend: () => engine.backend,
		spawnStreamingLoop: () =>
			({
				proc: { exited: Promise.resolve(0) },
				spawnfile: "srtla_send",
				exitListeners: [],
			}) as unknown as StreamingProcess,
		startLinkTelemetry: () => {},
		stopLinkTelemetry: () => {},
		stopProcessAndWait: async () => {},
	});
	spyOn(streamSessionProductionDeps, "admitUpdate").mockImplementation(
		async () => ({ allowed: true }),
	);
	spyOn(streamSessionProductionDeps, "queryRuntime").mockImplementation(
		async () => "idle",
	);
	spyOn(streamSessionProductionDeps, "stopRuntime").mockImplementation(
		async () => engine.backend.confirmStop(),
	);
	spyOn(streamSessionProductionDeps, "onStreamArmed").mockImplementation(
		() => {},
	);
	spyOn(streamSessionProductionDeps, "onStreamCommitted").mockImplementation(
		() => {},
	);
	probe = spyOn(audio, "asrcProbe").mockImplementation(async (asrc) => asrc);
	spyOn(srtla, "resolveSrtla").mockImplementation(async (addr) => addr);
	spyOn(preparation, "prepareSrtlaIpAddresses").mockImplementation(async () =>
		published(),
	);
});

afterEach(async () => {
	gate.resolve();
	await stop();
	jest.restoreAllMocks();
	setStartStreamDepsForTest(null);
	setPreviewEncodeReplayTransport(null);
	engine.dispose();
	audio.setMockAudioDevicesProvider(undefined);
	clearCapabilitiesCache();
	for (const key of Object.keys(getConfig()))
		Reflect.deleteProperty(getConfig(), key);
	Object.assign(getConfig(), previousConfig);
	setConfigFilePath(previousPath);
	setup.ips_file = previousIps;
	for (const key of ["NODE_ENV", "MOCK_MODE", "CERALIVE_STREAMING_MARKER"]) {
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	await rm(directory, { recursive: true, force: true });
});

const start = (input = {}) =>
	call(streamingStartProcedure, input, { context: makeRpcContext() });
const pick = (asrc: string) =>
	call(
		setConfigProcedure,
		{ asrc, audio_pick: true },
		{ context: makeRpcContext() },
	);
async function stop() {
	noteStreamSessionEngineStatus({
		type: "status",
		seq: 1,
		state: "idle",
		streaming: false,
	});
	await call(streamingStopProcedure, undefined, { context: makeRpcContext() });
	updateStatus(false);
}
const launchedAudio = () => engine.startRequests.map(({ audio }) => audio);
const disk = () => Bun.file(getConfigFilePath()).json();

test.each(Object.keys(GATES))(
	"a microphone picked during %s leaves the accepted No audio Start without audio, and the next Start uses the pick",
	async (stage) => {
		GATES[stage]?.();
		const started = start();
		await reached.promise;
		expect(launchedAudio()).toEqual([]);
		expect(await pick("Primary")).toMatchObject({ success: true });
		gate.resolve();
		expect(await started).toMatchObject({ success: true });
		expect(launchedAudio()).toEqual([{ mode: "none", delay_ms: 0 }]);
		expect(probe.mock.calls).toEqual([]);
		expect(await disk()).toMatchObject({
			asrc: "Primary",
			audio_inputs: savedMix,
		});

		await stop();
		expect(await start()).toMatchObject({ success: true });
		expect(launchedAudio()[1]).toEqual({
			mode: "default",
			inputs: mixOnTheWire,
			delay_ms: 0,
		});
	},
);

test("autostart keeps the No audio it was accepted with", async () => {
	spyOn(srtla, "genSrtlaIpList").mockReturnValue(["192.0.2.2"]);
	GATES["relay address lookup"]?.();
	const started = autoStartStream();
	await reached.promise;
	await pick("Primary");
	gate.resolve();
	await started;
	expect(launchedAudio()).toEqual([{ mode: "none", delay_ms: 0 }]);
	expect(await disk()).toMatchObject({ asrc: "Primary" });
});

test("a Start that itself asks for No audio keeps it when the saved pick is a microphone", async () => {
	getConfig().asrc = "Primary";
	saveConfig();
	GATES["preview replay"]?.();
	const started = start({ asrc: "No audio" });
	await reached.promise;
	await pick("Primary");
	gate.resolve();
	expect(await started).toMatchObject({ success: true });
	expect(launchedAudio()).toEqual([{ mode: "none", delay_ms: 0 }]);
});

test.each(Object.keys(GATES))(
	"No audio picked during %s of a microphone Start also sends no audio",
	async (stage) => {
		getConfig().asrc = "Primary";
		saveConfig();
		GATES[stage]?.();
		const started = start();
		await reached.promise;
		await pick("No audio");
		gate.resolve();
		expect(await started).toMatchObject({ success: true });
		expect(launchedAudio()).toEqual([{ mode: "none", delay_ms: 0 }]);
		expect(await disk()).toMatchObject({ asrc: "No audio" });
	},
);

test("a pick outside the mix saved during the relay address lookup keeps its mix too", async () => {
	GATES["relay address lookup"]?.();
	const started = start();
	await reached.promise;
	await pick("Third");
	gate.resolve();
	await started;
	expect(launchedAudio()).toEqual([{ mode: "none", delay_ms: 0 }]);
	expect(await disk()).toMatchObject({
		asrc: "Third",
		audio_inputs: [entry("Third", [1]), ...savedMix],
	});
});

test("the running No audio stream is what an engine restart restores, not the later pick", async () => {
	GATES["preview replay"]?.();
	const started = start();
	await reached.promise;
	await pick("Primary");
	gate.resolve();
	await started;
	expect(getConfig().asrc).toBe("Primary");
	expect(captureArmedStreamConfig().asrc).toBe("No audio");

	await stop();
	await start();
	expect(captureArmedStreamConfig().asrc).toBe("Primary");
});

const HDMI: CaptureStreamSource = {
	origin: "capture",
	id: "hdmi-rx",
	pipelineId: "test",
	kind: "hdmi",
	displayName: "Rockchip HDMI-RX",
	devicePath: "/dev/video0",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: "selectable",
	available: true,
};

async function launchAutoOnDeadHdmi() {
	const resolution = autoAudio.resolveAutoAsrc({
		source: HDMI,
		audioDevices: { HDMI: "rockchiphdmiin" },
		engineAudio: [],
		networkEmbeddedAudio: undefined,
		captureCapableCardIds: new Set(["primary"]),
	});
	expect(resolution).toEqual({
		asrcKey: "No audio",
		cardId: null,
		reason: "no-capture-audio",
	});
	spyOn(autoAudio, "resolveAutoAsrcFromLiveState").mockReturnValue(resolution);
	getConfig().asrc = "Auto";
	expect(
		await startStream(
			{
				source: "test",
				name: "Test",
				hardware: "rk3588",
				description: "test",
				supportsAudio: true,
				supportsResolutionOverride: true,
				supportsFramerateOverride: true,
				audio_kind: "selectable",
			},
			"192.0.2.10",
			5000,
			"auto",
		),
	).toEqual({ success: true });
	return launchedAudio()[0];
}

test("Auto on a card that cannot capture is not the operator's No audio: a saved mix is still sent", async () => {
	expect(await launchAutoOnDeadHdmi()).toEqual({
		mode: "default",
		inputs: mixOnTheWire,
		delay_ms: 0,
	});
});

test("No audio picked while Auto's card is being checked also sends no audio", async () => {
	spyOn(autoAudio, "resolveAutoAsrcFromLiveState").mockReturnValue({
		asrcKey: "Primary",
		cardId: "primary",
		reason: "usb-same-device",
	});
	getConfig().asrc = "Auto";
	saveConfig();
	spyOn(audio, "asrcProbe").mockImplementation(async (asrc) => {
		await hold();
		return asrc;
	});
	const started = start();
	await reached.promise;
	await pick("No audio");
	gate.resolve();
	expect(await started).toMatchObject({ success: true });
	expect(launchedAudio()).toEqual([{ mode: "none", delay_ms: 0 }]);
});

test("Auto on a card that cannot capture without a saved mix still starts without audio", async () => {
	getConfig().audio_inputs = undefined;
	expect(await launchAutoOnDeadHdmi()).toEqual({ mode: "none", delay_ms: 0 });
});
