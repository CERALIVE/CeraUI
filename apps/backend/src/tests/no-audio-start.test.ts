/**
 * A Start uses the audio configuration carried by the Start request; saves made
 * while it is in flight apply to the next Start only.
 *
 * A Start waits on several things between the operator's press and the engine
 * request. These tests hold each of them on the real route (the Start RPC, the
 * production orchestrator, session, updateConfig, startStream and the real engine
 * adapter over a fake client) and save another audio choice meanwhile.
 */
import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GetCapabilitiesResult } from "@ceralive/cerastream";
import {
	ATTEMPT_SCOPED_START_FEATURE,
	type CerastreamClient,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type { CaptureStreamSource } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	getConfig,
	getConfigFilePath,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	handleSetProfile,
	resetSetProfile,
} from "../modules/remote-control/set-profile.ts";
import { wireSetProfile } from "../modules/remote-control/set-profile-wiring.ts";
import { setup } from "../modules/setup.ts";
import {
	type ArmedStreamConfig,
	noteStreamStopped,
} from "../modules/streaming/armed-stream-marker.ts";
import * as audio from "../modules/streaming/audio.ts";
import * as autoAudio from "../modules/streaming/auto-audio.ts";
import * as bindMapSpawn from "../modules/streaming/bind-map-spawn.ts";
import {
	bluetoothAudioSourceId,
	resetBluetoothAudioForTest,
	setBluetoothAudioDepsForTest,
} from "../modules/streaming/bluetooth-audio.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import {
	initPipelines,
	type Pipeline,
} from "../modules/streaming/pipelines.ts";
import { setPreviewEncodeReplayTransport } from "../modules/streaming/preview-encode-replay.ts";
import * as srtla from "../modules/streaming/srtla.ts";
import {
	captureArmedStreamConfig,
	restorationLaunchConfig,
} from "../modules/streaming/stream-restoration.ts";
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
import { sendStatus } from "../modules/ui/status.ts";
import * as websocketServer from "../modules/ui/websocket-server.ts";
import { setAudioMixProcedure } from "../rpc/procedures/audio-mix.procedure.ts";
import {
	buildInitialStatus,
	getStatusProcedure,
} from "../rpc/procedures/status.procedure.ts";
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

const TEST_PIPELINE = {
	source: "test",
	name: "Test",
	hardware: "rk3588",
	description: "test",
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audio_kind: "selectable",
} satisfies Pipeline;

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

// The Live screen's Start carries every saved stream field, `asrc` included.
const uiStart = (asrc: string, extra = {}) =>
	start({
		pipeline: "test",
		delay: 0,
		max_br: 8000,
		srt_latency: 2000,
		bitrate_overlay: false,
		relay_protocol: "srtla",
		srtla_addr: "127.0.0.1",
		srtla_port: 5000,
		srt_streamid: "no-audio",
		asrc,
		...extra,
	});
// The last of each is a save that repeats the pick that was already saved.
const ORDERINGS = Object.keys(GATES).flatMap((stage) =>
	(["Second", "Primary", "No audio"] as const).map(
		(saved) => [stage, saved] as const,
	),
);

test.each(ORDERINGS)(
	"No audio saved during %s (%s saved before) leaves the microphone Start as pressed, stays saved and starts next time",
	async (stage, saved) => {
		getConfig().asrc = saved;
		saveConfig();
		GATES[stage]?.();
		const started = uiStart("Primary");
		await reached.promise;
		expect(await pick("No audio")).toMatchObject({ success: true });
		gate.resolve();
		const result = await started;
		expect(result).toMatchObject({ success: true });
		expect(launchedAudio()).toEqual([
			{ mode: "default", inputs: mixOnTheWire, delay_ms: 0 },
		]);
		expect(await disk()).toMatchObject({
			asrc: "No audio",
			audio_inputs: savedMix,
		});

		await stop();
		expect(await start()).toMatchObject({ success: true });
		expect(launchedAudio()[1]).toEqual({ mode: "none", delay_ms: 0 });
		expect(result.applied?.asrc).toBe("Primary");
	},
);

test.each(ORDERINGS)(
	"a microphone saved during %s (%s saved before) survives an older No audio Start payload, which stays silent",
	async (stage, saved) => {
		getConfig().asrc = saved;
		saveConfig();
		GATES[stage]?.();
		const started = uiStart("No audio");
		await reached.promise;
		expect(await pick("Primary")).toMatchObject({ success: true });
		gate.resolve();
		const result = await started;
		expect(result).toMatchObject({ success: true });
		expect(launchedAudio()).toEqual([{ mode: "none", delay_ms: 0 }]);
		expect(await disk()).toMatchObject({ asrc: "Primary" });

		await stop();
		expect(await start()).toMatchObject({ success: true });
		expect(launchedAudio()[1]).toEqual({
			mode: "default",
			inputs: mixOnTheWire,
			delay_ms: 0,
		});
		expect(result.applied?.asrc).toBe("No audio");
	},
);

test("without a newer save the Start payload's own pick is still saved and launched", async () => {
	getConfig().asrc = "Second";
	saveConfig();
	expect(await uiStart("No audio")).toMatchObject({
		success: true,
		applied: { asrc: "No audio" },
	});
	expect(launchedAudio()).toEqual([{ mode: "none", delay_ms: 0 }]);
	expect(await disk()).toMatchObject({ asrc: "No audio" });
});

test("a Start pressed with a microphone that is unplugged meanwhile is refused, and No audio saved since stays saved", async () => {
	getConfig().asrc = "Second";
	saveConfig();
	GATES["update admission"]?.();
	const started = uiStart("Primary");
	await reached.promise;
	await pick("No audio");
	audio.setMockAudioDevicesProvider(() => ({ Second: "hw:CARD=second" }));
	gate.resolve();
	expect(await started).toMatchObject({
		success: false,
		error: "start_invalid",
		failure: { class: "start_invalid", phase: "params", retriable: false },
	});
	expect(launchedAudio()).toEqual([]);
	expect(await disk()).toMatchObject({ asrc: "No audio" });
});

test("a Start pressed with no pick saved is refused although a microphone is saved meanwhile", async () => {
	delete getConfig().asrc;
	saveConfig();
	GATES["update admission"]?.();
	const started = start();
	await reached.promise;
	await pick("Primary");
	gate.resolve();
	expect(await started).toMatchObject({
		success: false,
		failure: { class: "start_invalid", phase: "params" },
	});
	expect(launchedAudio()).toEqual([]);
	expect(await disk()).toMatchObject({ asrc: "Primary" });
});

test("a saved microphone that is missing at the press is still waited for after another pick is saved", async () => {
	getConfig().asrc = "Gone";
	getConfig().audio_inputs = undefined;
	saveConfig();
	GATES["update admission"]?.();
	const started = start();
	await reached.promise;
	await pick("Primary");
	gate.resolve();
	expect(await started).toMatchObject({ success: true });
	expect(probe.mock.calls).toEqual([["Gone"]]);
	expect(await disk()).toMatchObject({ asrc: "Primary" });
});

const newerMix = [entry("Primary", [1]), entry("Second", [1])];
const context = () => ({ context: makeRpcContext() });
test.each([
	[
		"a saved mix",
		() => call(setConfigProcedure, { audio_inputs: newerMix }, context()),
		newerMix,
	],
	[
		"the mix cleared again",
		() => call(setConfigProcedure, { audio_inputs: null }, context()),
		undefined,
	],
	[
		"a membership edit",
		() => call(setAudioMixProcedure, { id: "Third", include: true }, context()),
		[...savedMix, entry("Third", [1])],
	],
	[
		"a level edit",
		() => call(setAudioMixProcedure, { id: "Second", gain_db: -6 }, context()),
		[savedMix[0], { ...entry("Second", [2]), gain_db: -6 }],
	],
] as const)(
	"%s saved during update admission survives an older mix in the Start payload",
	async (name, save, expected) => {
		getConfig().asrc = "Primary";
		if (name === "the mix cleared again") getConfig().audio_inputs = undefined;
		saveConfig();
		GATES["update admission"]?.();
		const started = uiStart("Primary", {
			audio_inputs: [entry("Primary", [1]), entry("Third", [2])],
		});
		await reached.promise;
		expect(await save()).toMatchObject({ success: true });
		gate.resolve();
		expect(await started).toMatchObject({ success: true });
		expect((await disk()).audio_inputs).toEqual(expected);
	},
);

test("a pick saved during update admission replaces the Start's pick and not its mix", async () => {
	getConfig().asrc = "Primary";
	saveConfig();
	GATES["update admission"]?.();
	const own = [entry("Primary", [1]), entry("Third", [2])];
	const started = uiStart("Primary", { audio_inputs: own });
	await reached.promise;
	await pick("No audio");
	gate.resolve();
	expect(await started).toMatchObject({ success: true });
	expect(await disk()).toMatchObject({ asrc: "No audio", audio_inputs: own });
});

test("a card that re-enumerated during update admission keeps its migrated pick", async () => {
	getConfig().asrc = "Second";
	saveConfig();
	GATES["update admission"]?.();
	const started = uiStart("Second");
	await reached.promise;
	expect(
		audio.reconcileConfiguredAudioIdentity(
			new Map([["Primary", { stable_id: "mic" }]]) as never,
			{ Primary: "hw:CARD=primary" },
			new Map([["Second", "mic"]]),
		),
	).toBe(true);
	gate.resolve();
	expect(await started).toMatchObject({ success: true });
	expect(await disk()).toMatchObject({ asrc: "Primary" });
});

test("a card that re-enumerated during update admission does not undo the payload's own No audio", async () => {
	getConfig().asrc = "Second";
	saveConfig();
	GATES["update admission"]?.();
	const started = uiStart("No audio");
	await reached.promise;
	audio.reconcileConfiguredAudioIdentity(
		new Map([["Primary", { stable_id: "mic" }]]) as never,
		{ Primary: "hw:CARD=primary" },
		new Map([["Second", "mic"]]),
	);
	gate.resolve();
	expect(await started).toMatchObject({ success: true });
	expect(launchedAudio()).toEqual([{ mode: "none", delay_ms: 0 }]);
	expect(await disk()).toMatchObject({ asrc: "No audio" });
});

const offActive = async () => ({
	snapshot: buildInitialStatus().status.audio_off_active,
	pulled: (await call(getStatusProcedure, undefined, context()))
		.audio_off_active,
});
const offOnConnect = () => {
	const send = jest.fn((_frame: string) => {});
	sendStatus({ send } as never);
	return send.mock.calls
		.map(([frame]) => JSON.parse(frame).status)
		.find((status) => status?.is_streaming !== undefined)?.audio_off_active;
};

test("the running stream says it is silent whatever is saved, and Stop withdraws it", async () => {
	const frames = spyOn(websocketServer, "broadcastMsg");
	const sent = () =>
		frames.mock.calls
			.filter(([type]) => type === "status")
			.map(([, body]) => body as Record<string, unknown>)
			.filter((body) => "audio_off_active" in body)
			.map(({ is_streaming, audio_off_active }) => [
				is_streaming,
				audio_off_active,
			]);
	expect(await offActive()).toEqual({ snapshot: false, pulled: false });
	GATES["preview replay"]?.();
	const started = start();
	await reached.promise;
	await pick("Primary");
	gate.resolve();
	expect(await started).toMatchObject({ success: true });
	expect(getConfig().asrc).toBe("Primary");
	expect(await offActive()).toEqual({ snapshot: true, pulled: true });
	expect(offOnConnect()).toBe(true);
	expect(sent().at(-1)).toEqual([true, true]);

	await stop();
	expect(await offActive()).toEqual({ snapshot: false, pulled: false });
	expect(sent().at(-1)).toEqual([false, false]);

	expect(await start()).toMatchObject({ success: true });
	expect(await offActive()).toEqual({ snapshot: false, pulled: false });
	await pick("No audio");
	expect(await offActive()).toEqual({ snapshot: false, pulled: false });
});

const restore = (marker: ArmedStreamConfig) =>
	startStream(
		TEST_PIPELINE,
		"192.0.2.10",
		5000,
		"restored",
		{},
		"restored",
		restorationLaunchConfig(marker),
	);

test("a silent stream restored after an engine loss is still silent and says so", async () => {
	GATES["preview replay"]?.();
	const started = start();
	await reached.promise;
	await pick("Primary");
	gate.resolve();
	await started;
	const armed = captureArmedStreamConfig();
	noteStreamStopped("engine_loss");
	updateStatus(false);
	expect((await offActive()).snapshot).toBe(false);

	expect(await restore(armed)).toEqual({ success: true });
	updateStatus(true);
	expect(launchedAudio().at(-1)).toEqual({ mode: "none", delay_ms: 0 });
	expect(await offActive()).toEqual({ snapshot: true, pulled: true });
});

test.each([
	["single", savedMix, { mode: "device", device: "hw:CARD=Primary" }],
	["mix", null, { mode: "default", inputs: mixOnTheWire }],
] as const)(
	"a stream pressed with a saved %s is restored with it, whatever mix is saved meanwhile",
	async (shape, saved, sent) => {
		savePressed("Primary", shape);
		GATES["update admission"]?.();
		const started = start();
		await reached.promise;
		expect(
			await call(setConfigProcedure, { audio_inputs: saved }, context()),
		).toMatchObject({ success: true });
		getConfig().audio_backend = "pipewire";
		getConfig().acodec = "opus";
		saveConfig();
		gate.resolve();
		expect(await started).toMatchObject({ success: true });
		const armed = captureArmedStreamConfig();
		noteStreamStopped("engine_loss");

		expect(await restore(armed)).toEqual({ success: true });
		expect(launchedAudio()).toEqual([
			{ ...sent, delay_ms: 0 },
			{ ...sent, delay_ms: 0 },
		]);
	},
);

test("a marker from before the mix was recorded restores the saved mix", async () => {
	savePressed("Primary", "mix");
	expect(await restore({ asrc: "Primary" })).toEqual({ success: true });
	expect(launchedAudio()).toEqual([
		{ mode: "default", inputs: mixOnTheWire, delay_ms: 0 },
	]);
});

test("a stream adopted after Stop carries no claim left over from the stream before it", async () => {
	expect(await start()).toMatchObject({ success: true });
	expect((await offActive()).snapshot).toBe(true);
	await stop();
	updateStatus(true);
	expect(await offActive()).toEqual({ snapshot: undefined, pulled: undefined });
});

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
	"No audio picked during %s of a microphone Start counts for the next Start",
	async (stage) => {
		getConfig().asrc = "Primary";
		saveConfig();
		GATES[stage]?.();
		const started = start();
		await reached.promise;
		await pick("No audio");
		gate.resolve();
		expect(await started).toMatchObject({ success: true });
		expect(launchedAudio()).toEqual([
			{ mode: "default", inputs: mixOnTheWire, delay_ms: 0 },
		]);
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
	expect(await startStream(TEST_PIPELINE, "192.0.2.10", 5000, "auto")).toEqual({
		success: true,
	});
	return launchedAudio()[0];
}

test("Auto on a card that cannot capture is not the operator's No audio: a saved mix is still sent", async () => {
	expect(await launchAutoOnDeadHdmi()).toEqual({
		mode: "default",
		inputs: mixOnTheWire,
		delay_ms: 0,
	});
});

test("No audio picked while Auto's card is being checked counts for the next Start", async () => {
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
	expect(launchedAudio()).toEqual([
		{ mode: "default", inputs: mixOnTheWire, delay_ms: 0 },
	]);
	expect(await disk()).toMatchObject({ asrc: "No audio" });
});

test("Auto on a card that cannot capture without a saved mix still starts without audio", async () => {
	getConfig().audio_inputs = undefined;
	expect(await launchAutoOnDeadHdmi()).toEqual({ mode: "none", delay_ms: 0 });
	updateStatus(true);
	expect(await offActive()).toEqual({ snapshot: false, pulled: false });
});

// ─── Saves at every point a Start waits ──────────────────────────────────────

const wrapClient = (extra: (client: CerastreamClient) => object) => {
	const deps = engine.backend["deps"];
	const connect = deps.connect;
	spyOn(deps, "connect").mockImplementation(async (options) => {
		const client = await connect(options);
		return Object.assign(client, extra(client));
	});
};
/** An engine that prepares a scoped attempt before its Start request. */
const scopedEngine = (held: "getCapabilities" | "prepareStart") => {
	engine.dispose();
	engine = evidenceHarness(false, { schemaVersion: "0.25.0" });
	wrapClient(() => ({
		getCapabilities: async () => {
			if (held === "getCapabilities") await hold();
			return { ...CAPS, features: [ATTEMPT_SCOPED_START_FEATURE] };
		},
		prepareStart: async () => {
			if (held === "prepareStart") await hold();
			return { attempt_id: "attempt-1", expires_in_ms: 10_000 };
		},
		cancelStart: async (attempt: unknown) => attempt,
	}));
};
const holdProbe = (settle: (asrc: string) => string) =>
	spyOn(audio, "asrcProbe").mockImplementationOnce(async (asrc) => {
		await hold();
		return settle(asrc);
	});

// Every await between the Start request and the engine request, in order.
const AWAITS: Record<string, () => void | Promise<void>> = {
	"runtime reconcile": async () => {
		expect(await start()).toMatchObject({ success: true });
		engine.startRequests.length = 0;
		updateStatus(false);
		spyOn(streamSessionProductionDeps, "queryRuntime").mockImplementation(
			async () => {
				await hold();
				return "idle";
			},
		);
	},
	...GATES,
	"audio probe": () => {
		holdProbe((asrc) => asrc);
	},
	"sender address list": () => {
		const file = Bun.file;
		spyOn(Bun, "file").mockImplementation(((path: string, options?: object) =>
			path === setup.ips_file
				? {
						text: async () => {
							await hold();
							return "192.0.2.2\n";
						},
					}
				: file(path, options)) as typeof Bun.file);
	},
	"sender capability check": () => {
		spyOn(bindMapSpawn, "resolveBindMapArgs").mockImplementation(async () => {
			await hold();
			return [];
		});
	},
	"engine queue": () => {
		void engine.backend["enqueue"](() => gate.promise, "set-bitrate");
		const run = engine.backend.start.bind(engine.backend);
		spyOn(engine.backend, "start").mockImplementation((...args) => {
			const result = run(...args);
			reached.resolve();
			return result;
		});
	},
	"engine connect": () => {
		const deps = engine.backend["deps"];
		const connect = deps.connect;
		spyOn(deps, "connect").mockImplementation(async (options) => {
			await hold();
			return connect(options);
		});
	},
	"engine subscribe": () => {
		wrapClient((client) => {
			const subscribe = client.subscribeEvents.bind(client);
			return {
				subscribeEvents: async (
					...args: Parameters<CerastreamClient["subscribeEvents"]>
				) => {
					await hold();
					return subscribe(...args);
				},
			};
		});
	},
	"engine capability check": () => scopedEngine("getCapabilities"),
	"engine start preparation": () => scopedEngine("prepareStart"),
	"start retry wait": () => {
		getConfig().previewEncode = "software";
		setPreviewEncodeReplayTransport(async () => {
			setPreviewEncodeReplayTransport(async () => {});
			throw new Error("engine restarting");
		});
		const schedule = globalThis.setTimeout;
		spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			ms?: number,
		) => {
			if (ms !== 2_000) return schedule(callback, ms);
			void hold().then(callback);
			return 0;
		}) as typeof setTimeout);
	},
};

const wire = (id: string, tracks: number[]) => {
	const { id: _id, ...input } = entry("", tracks);
	return { ...input, input_id: `hw:CARD=${id.toLowerCase()}` };
};
const mixed = (...inputs: ReturnType<typeof wire>[]) => ({
	mode: "default",
	inputs,
	delay_ms: 0,
});
const device = (id: string) => ({
	mode: "device",
	device: `hw:CARD=${id}`,
	delay_ms: 0,
});
const silent = { mode: "none", delay_ms: 0 };
const otherMix = [entry("Primary", [1]), entry("Second", [1])];

const SHAPES = ["mix", "single"] as const;
type Shape = (typeof SHAPES)[number];
/** What each press sends, with a saved mix and with one input. */
const PRESSED = {
	Primary: {
		mix: mixed(wire("Primary", [1]), wire("Second", [2])),
		single: device("Primary"),
	},
	Auto: {
		mix: mixed(wire("Third", [1]), wire("Primary", [1]), wire("Second", [2])),
		single: device("Third"),
	},
	"No audio": { mix: silent, single: silent },
} satisfies Record<string, Record<Shape, object>>;
type Pressed = keyof typeof PRESSED;

interface LaterSave {
	save: () => Promise<unknown>;
	saved: Record<string, unknown>;
	/** What the next Start sends; the audio pick decides when it is absent. */
	next?: Record<Shape, object>;
}
const LATER: Record<string, LaterSave> = {
	"No audio": {
		save: () => pick("No audio"),
		saved: { asrc: "No audio" },
		next: PRESSED["No audio"],
	},
	"a different microphone": {
		save: () => pick("Second"),
		saved: { asrc: "Second" },
		next: {
			mix: mixed(wire("Second", [2]), wire("Primary", [1])),
			single: device("Second"),
		},
	},
	"a different mix": {
		save: () => call(setConfigProcedure, { audio_inputs: otherMix }, context()),
		saved: { audio_inputs: otherMix },
	},
	Auto: {
		save: () => pick("Auto"),
		saved: { asrc: "Auto" },
		next: PRESSED.Auto,
	},
	"a different delay": {
		save: () => call(setConfigProcedure, { delay: 120 }, context()),
		saved: { delay: 120 },
	},
};
const later = (name: string): LaterSave => {
	const choice = LATER[name];
	if (choice === undefined) throw new Error(name);
	return choice;
};

function savePressed(asrc: string, shape: Shape) {
	getConfig().asrc = asrc;
	getConfig().audio_inputs =
		shape === "mix" ? structuredClone(savedMix) : undefined;
	saveConfig();
	spyOn(autoAudio, "resolveAutoAsrcFromLiveState").mockReturnValue({
		asrcKey: "Third",
		cardId: "third",
		reason: "usb-same-device",
	});
}
// Each shape also takes one of the two ways a Start states its audio: the whole
// configuration in the request, or nothing but the saved one.
const press = (asrc: string, shape: Shape) =>
	shape === "mix" ? uiStart(asrc) : start();
async function expectSaved(asrc: string, shape: Shape, choice: LaterSave) {
	const { asrc: pickOnDisk, audio_inputs, delay } = await disk();
	expect({ asrc: pickOnDisk, audio_inputs, delay }).toEqual({
		asrc,
		audio_inputs: shape === "mix" ? savedMix : undefined,
		delay: 0,
		...choice.saved,
	});
}

const EVERY_AWAIT = (Object.keys(PRESSED) as Pressed[]).flatMap((asrc) =>
	Object.keys(AWAITS)
		// A No audio Start has no microphone to check.
		.filter((point) => asrc !== "No audio" || point !== "audio probe")
		.flatMap((point) =>
			Object.keys(LATER)
				.filter((name) => name !== asrc)
				.flatMap((name) =>
					SHAPES.map((shape) => [asrc, name, point, shape] as const),
				),
		),
);

test.each(EVERY_AWAIT)(
	"a Start pressed with %s ignores %s saved during %s, which the next Start sends (%s saved)",
	async (asrc, name, point, shape) => {
		const choice = later(name);
		savePressed(asrc, shape);
		await AWAITS[point]?.();
		const started = press(asrc, shape);
		await reached.promise;
		expect(await choice.save()).toMatchObject({ success: true });
		expect(launchedAudio()).toEqual([]);
		gate.resolve();
		const result = await started;
		expect(result).toMatchObject({ success: true });
		expect(launchedAudio()).toEqual([PRESSED[asrc][shape]]);
		expect((await offActive()).snapshot).toBe(asrc === "No audio");
		expect(captureArmedStreamConfig()).toMatchObject({ asrc, delay: 0 });
		if (shape === "mix") expect(result.applied?.asrc).toBe(asrc);
		await expectSaved(asrc, shape, choice);

		if (choice.next === undefined) return;
		await stop();
		expect(await start()).toMatchObject({ success: true });
		expect(launchedAudio()[1]).toEqual(choice.next[shape]);
	},
);

test.each(
	Object.keys(LATER).flatMap((name) =>
		SHAPES.map((shape) => [name, shape] as const),
	),
)(
	"%s saved while the engine answers the Start is not part of it (%s saved)",
	async (name, shape) => {
		const choice = later(name);
		savePressed("Primary", shape);
		engine.holdStart(gate.promise);
		const started = press("Primary", shape);
		await engine.startDispatched;
		expect(await choice.save()).toMatchObject({ success: true });
		gate.resolve();
		expect(await started).toMatchObject({ success: true });
		expect(launchedAudio()).toEqual([PRESSED.Primary[shape]]);
		expect(captureArmedStreamConfig()).toMatchObject({
			asrc: "Primary",
			delay: 0,
		});
		await expectSaved("Primary", shape, choice);
	},
);

test.each(
	Object.keys(LATER).flatMap((name) =>
		SHAPES.map((shape) => [name, shape] as const),
	),
)(
	"%s saved during the check of the pressed microphone does not excuse it from failing (%s saved)",
	async (name, shape) => {
		const choice = later(name);
		savePressed("Primary", shape);
		holdProbe((asrc) => {
			throw new audio.AudioProbeTimeoutError(asrc);
		});
		const started = press("Primary", shape);
		await reached.promise;
		expect(await choice.save()).toMatchObject({ success: true });
		gate.resolve();
		expect(await started).toMatchObject({
			success: false,
			error: "audio_source_probe_failed",
			failure: {
				class: "audio_source_unavailable",
				phase: "params",
				retriable: false,
			},
		});
		expect(launchedAudio()).toEqual([]);
		await expectSaved("Primary", shape, choice);

		if (choice.next === undefined) return;
		expect(await start()).toMatchObject({ success: true });
		expect(launchedAudio()).toEqual([choice.next[shape]]);
	},
);

test("a Start pressed with No audio never checks the microphone saved during it", async () => {
	savePressed("No audio", "mix");
	const asked = holdProbe((asrc) => asrc);
	await AWAITS["sender address list"]?.();
	const started = uiStart("No audio");
	await reached.promise;
	await pick("Primary");
	gate.resolve();
	expect(await started).toMatchObject({ success: true });
	expect(asked.mock.calls).toEqual([]);
	expect(launchedAudio()).toEqual([silent]);
	expect(await disk()).toMatchObject({
		asrc: "Primary",
		audio_inputs: savedMix,
	});
});

test.each([true, false])(
	"a codec saved during update admission is the next Start's (stated in the request: %p)",
	async (stated) => {
		savePressed("Primary", "mix");
		getConfig().acodec = "aac";
		saveConfig();
		GATES["update admission"]?.();
		const started = stated ? uiStart("Primary", { acodec: "aac" }) : start();
		await reached.promise;
		expect(
			await call(setConfigProcedure, { acodec: "opus" }, context()),
		).toMatchObject({ success: true });
		gate.resolve();
		expect(await started).toMatchObject({ success: true });
		expect(launchedAudio()).toEqual([{ ...PRESSED.Primary.mix, codec: "aac" }]);
		expect(captureArmedStreamConfig().acodec).toBe("aac");
		expect(await disk()).toMatchObject({ acodec: "opus" });
	},
);

// Only the BlueALSA arm lists this microphone, so "pipewire" takes it off the list.
async function listBluetoothMic() {
	const address = "AA:BB:CC:11:22:33";
	setBluetoothAudioDepsForTest({
		readEnumeratedPcms: async () => [
			{
				path: "/org/bluealsa/hci0/dev_AA_BB_CC_11_22_33/sco/source",
				address,
				codec: "mSBC",
				sampleRateHz: 16_000,
				channels: 1,
			},
		],
		readRegistryDevices: () => [
			{ address, alias: "Mic", connected: true, scoCapable: true },
		],
		engineSupportsPcmSpec: () => true,
		engineSupportsPipewireCapture: () => false,
		readEngineAudioDevices: () => [],
		readAudioProvider: async () => "bluealsa",
	});
	await audio.refreshBluetoothAudioDevices();
	const id = bluetoothAudioSourceId(address);
	expect(audio.getAudioDevices()[id]).toBeDefined();
	return id;
}
async function unlistBluetoothMic() {
	resetBluetoothAudioForTest();
	setBluetoothAudioDepsForTest({
		readEnumeratedPcms: async () => [],
		readRegistryDevices: () => [],
		engineSupportsPcmSpec: () => false,
		engineSupportsPipewireCapture: () => false,
		readEngineAudioDevices: () => [],
		readAudioProvider: async () => "bluealsa",
	});
	await audio.refreshBluetoothAudioDevices();
	resetBluetoothAudioForTest();
}

test.each(["update admission", "sender capability check"])(
	"an audio backend saved during %s does not take the pressed Bluetooth microphone away",
	async (point) => {
		try {
			const id = await listBluetoothMic();
			savePressed("Primary", "single");
			await AWAITS[point]?.();
			const started = uiStart(id);
			await reached.promise;
			// What saving the backend does once the engine offers it.
			getConfig().audio_backend = "pipewire";
			saveConfig();
			await audio.refreshBluetoothAudioDevices();
			gate.resolve();
			expect(await started).toMatchObject({ success: true });
			expect(launchedAudio()).toEqual([
				{
					mode: "device",
					device: "bluealsa:DEV=AA:BB:CC:11:22:33,PROFILE=sco",
					delay_ms: 0,
				},
			]);
			// The list is the saved backend's again once the Start is done.
			expect(audio.getAudioDevices()[id]).toBeUndefined();
			expect(await disk()).toMatchObject({ audio_backend: "pipewire" });
		} finally {
			await unlistBluetoothMic();
		}
	},
);

test("an audio backend saved during update admission is the next Start's", async () => {
	savePressed("Primary", "single");
	GATES["update admission"]?.();
	const started = start();
	await reached.promise;
	getConfig().audio_backend = "pipewire";
	saveConfig();
	gate.resolve();
	expect(await started).toMatchObject({ success: true });
	expect(launchedAudio()).toEqual([PRESSED.Primary.single]);
});

test("a bitrate changed while the microphone is checked still reaches the engine", async () => {
	savePressed("Primary", "single");
	holdProbe((asrc) => asrc);
	const started = start();
	await reached.promise;
	getConfig().max_br = 4000;
	gate.resolve();
	expect(await started).toMatchObject({ success: true });
	expect(engine.startRequests[0]?.bitrate.max_bitrate).toBe(4000);
});

test("Auto follows the camera this Start launches, not one chosen for later", async () => {
	savePressed("Auto", "single");
	getConfig().source = "camera-b";
	spyOn(autoAudio, "resolveAutoAsrcFromLiveState").mockImplementation(
		(source = getConfig().source) => {
			const asrcKey = source === "camera-a" ? "Second" : "Third";
			return { asrcKey, cardId: asrcKey, reason: "usb-same-device" };
		},
	);
	expect(
		await startStream(
			TEST_PIPELINE,
			"192.0.2.10",
			5000,
			"restored",
			{},
			"restored",
			{ asrc: "Auto", source: "camera-a" },
		),
	).toEqual({ success: true });
	expect(launchedAudio()).toEqual([device("Second")]);
});

test.each(["update admission", "start retry wait"])(
	"a card that re-enumerated during %s is started and saved under its new id",
	async (point) => {
		savePressed("Primary", "single");
		await AWAITS[point]?.();
		const started = uiStart("Second");
		await reached.promise;
		const remembered = new Map([["Second", "mic"]]);
		const identities = new Map([["Third", { stable_id: "mic" }]]) as never;
		const devices = { Third: "hw:CARD=third" };
		audio.reconcileConfiguredAudioIdentity(identities, devices, remembered);
		audio.setMockAudioDevicesProvider(() => ({ ...devices }));
		const successor = audio.audioIdentitySuccessor;
		spyOn(audio, "audioIdentitySuccessor").mockImplementation((asrc) =>
			successor(asrc, identities, devices, remembered),
		);
		gate.resolve();
		expect(await started).toMatchObject({ success: true });
		expect(launchedAudio()).toEqual([device("Third")]);
		expect(await disk()).toMatchObject({ asrc: "Third" });
	},
);

test.each(Object.keys(LATER))(
	"an automatic start ignores %s saved while it waits for recovery",
	async (name) => {
		const choice = later(name);
		savePressed("Primary", "mix");
		spyOn(srtla, "genSrtlaIpList").mockReturnValue(["192.0.2.2"]);
		spyOn(streamSessionProductionDeps, "awaitRecovery").mockImplementation(
			hold,
		);
		const started = autoStartStream();
		await reached.promise;
		expect(await choice.save()).toMatchObject({ success: true });
		gate.resolve();
		await started;
		expect(launchedAudio()).toEqual([PRESSED.Primary.mix]);
		await expectSaved("Primary", "mix", choice);
	},
);

test.each(["its stop", "update admission"])(
	"a restart for a new stream profile ignores No audio saved during %s",
	async (point) => {
		savePressed("Primary", "mix");
		expect(await start()).toMatchObject({ success: true });
		wireSetProfile();
		GATES[point]?.();
		if (point === "its stop")
			spyOn(streamSessionProductionDeps, "stopRuntime").mockImplementation(
				async () => {
					await hold();
					return engine.backend.confirmStop();
				},
			);
		try {
			const configured = handleSetProfile({
				commandId: "11111111-1111-4111-8111-111111111112",
				config: {
					presetId: "balanced",
					latencyMs: 2000,
					fecEnabled: false,
					recoveryMode: "standard",
				},
			});
			await reached.promise;
			await pick("No audio");
			gate.resolve();
			await configured;
			expect(launchedAudio()).toEqual([
				PRESSED.Primary.mix,
				PRESSED.Primary.mix,
			]);
			expect(await disk()).toMatchObject({ asrc: "No audio" });
		} finally {
			resetSetProfile();
		}
	},
);
