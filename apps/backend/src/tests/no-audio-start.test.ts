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
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	GetCapabilitiesResult,
	ReloadConfigParams,
	SetAudioMixParams,
} from "@ceralive/cerastream";
import {
	ATTEMPT_SCOPED_START_FEATURE,
	type CerastreamClient,
	CerastreamConnectionError,
	CerastreamRpcError,
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
	defaultArmedStreamMarkerDeps,
	pinLaunchedAudio,
} from "../modules/streaming/armed-stream-marker.ts";
import * as audio from "../modules/streaming/audio.ts";
import * as autoAudio from "../modules/streaming/auto-audio.ts";
import * as bindMapSpawn from "../modules/streaming/bind-map-spawn.ts";
import {
	bluetoothAudioSourceId,
	isBluetoothAudioSourceId,
	resetBluetoothAudioForTest,
	setBluetoothAudioDepsForTest,
} from "../modules/streaming/bluetooth-audio.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import {
	CerastreamBackend,
	cerastreamBackend,
} from "../modules/streaming/cerastream-backend.ts";
import { commitStagedConfigChange } from "../modules/streaming/config-change-persistence.ts";
import { stageConfigChange } from "../modules/streaming/config-change-staging.ts";
import {
	initPipelines,
	type Pipeline,
} from "../modules/streaming/pipelines.ts";
import { setPreviewEncodeReplayTransport } from "../modules/streaming/preview-encode-replay.ts";
import {
	refreshEngineDeviceCache,
	setEngineAudioChangeHandler,
} from "../modules/streaming/sources.ts";
import * as srtla from "../modules/streaming/srtla.ts";
import { acceptStartAudio } from "../modules/streaming/start-audio.ts";
import {
	armStreamRestoration,
	captureArmedStreamConfig,
	runStreamRestoration,
} from "../modules/streaming/stream-restoration.ts";
import {
	noteStreamSessionEngineStatus,
	retireLostStreamSession,
} from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { autoStartStream } from "../modules/streaming/streamloop/autostart.ts";
import type { StreamingProcess } from "../modules/streaming/streamloop/process-runner.ts";
import * as preparation from "../modules/streaming/streamloop/srtla-ip-preparation.ts";
import {
	setStartStreamDepsForTest,
	startStream,
} from "../modules/streaming/streamloop/start-stream.ts";
import * as notifications from "../modules/ui/notifications.ts";
import { sendStatus } from "../modules/ui/status.ts";
import * as websocketServer from "../modules/ui/websocket-server.ts";
import { setAudioMixProcedure } from "../rpc/procedures/audio-mix.procedure.ts";
import {
	buildInitialStatus,
	getStatusProcedure,
} from "../rpc/procedures/status.procedure.ts";
import {
	applySwitchInputFollow,
	reloadAudioDelayProcedure,
	setConfigProcedure,
	setStreamingProcedureDepsForTest,
	streamingStartProcedure,
	streamingStopProcedure,
	switchAudioProcedure,
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

test("a missing microphone pressed with no pick saved is refused although it is saved meanwhile", async () => {
	delete getConfig().asrc;
	saveConfig();
	GATES["update admission"]?.();
	const started = uiStart("Gone");
	await reached.promise;
	expect(await pick("Gone")).toMatchObject({ success: true });
	gate.resolve();
	expect(await started).toMatchObject({
		success: false,
		failure: { class: "start_invalid", phase: "params" },
	});
	expect(launchedAudio()).toEqual([]);
	expect(await disk()).toMatchObject({ asrc: "Gone" });
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
	expect(
		await startStream(
			TEST_PIPELINE,
			"192.0.2.10",
			5000,
			"auto",
			{},
			"auto",
			undefined,
			acceptStartAudio(),
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
const holdStreamSubscription = () =>
	wrapClient((client) => {
		const subscribe = client.subscribeEvents;
		return {
			subscribeEvents: async (
				...args: Parameters<CerastreamClient["subscribeEvents"]>
			) => {
				if (args[0]?.topics === undefined) await hold();
				return subscribe(...args);
			},
		};
	});
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
	"microphone list refresh": () => {
		spyOn(preparation, "prepareSrtlaIpAddresses").mockImplementationOnce(
			async () => {
				getConfig().audio_backend = "pipewire";
				return published();
			},
		);
		spyOn(audio, "refreshBluetoothAudioDevices").mockImplementationOnce(
			async () => {
				getConfig().audio_backend = undefined;
				await hold();
			},
		);
	},
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
	mode: "default" as const,
	inputs,
	delay_ms: 0,
});
const device = (id: string) => ({
	mode: "device" as const,
	device: `hw:CARD=${id}`,
	delay_ms: 0,
});
const silent = { mode: "none" as const, delay_ms: 0 };
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
/** The microphone each press checks; none without audio. */
const PROBED: Record<Pressed, unknown[] | undefined> = {
	Primary: ["Primary"],
	Auto: ["Third"],
	"No audio": undefined,
};

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
		expect(probe.mock.calls.at(-1)).toEqual(PROBED[asrc]);
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
			{ address, name: "Mic", alias: "Mic", connected: true, scoCapable: true },
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

test("the pressed mix shares nothing with the saved one", async () => {
	savePressed("Primary", "mix");
	GATES["update admission"]?.();
	const started = start();
	await reached.promise;
	for (const input of getConfig().audio_inputs ?? []) input.gain_db = -6;
	gate.resolve();
	expect(await started).toMatchObject({ success: true });
	expect(launchedAudio()).toEqual([PRESSED.Primary.mix]);
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
			{ source: "camera-a" },
			acceptStartAudio(),
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

// ─── Engine restarts ─────────────────────────────────────────────────────────
// The production marker, its hooks, the restoration runner and its own launch.

let armed: string | undefined;
function keepMarker() {
	armed = undefined;
	const marker = defaultArmedStreamMarkerDeps;
	spyOn(marker, "readBootId").mockReturnValue("boot");
	spyOn(marker, "readMarker").mockImplementation(() => armed);
	spyOn(marker, "writeMarker").mockImplementation((_path, contents) => {
		armed = contents;
	});
	spyOn(marker, "removeMarker").mockImplementation(() => {
		armed = undefined;
	});
	spyOn(streamSessionProductionDeps, "onStreamArmed").mockImplementation(() => {
		armStreamRestoration();
	});
}
/** The control link drops; the engine itself may still run. */
function loseLink() {
	Object.assign(engine.backend["deps"], {
		onSessionConnectionLost: () => {},
		onEngineUnreachable: () => {},
	});
	engine.backend["noteConnectionLoss"](
		engine.backend["client"],
		new CerastreamConnectionError("the engine died"),
		"test",
	);
}
async function loseEngine() {
	loseLink();
	await retireLostStreamSession();
}
const restore = () => runStreamRestoration({ publish: () => {} });
async function restart() {
	await loseEngine();
	expect((await restore()).result).toBe("recovered");
	return launchedAudio().at(-1);
}
/** This backend finds the stream the engine still runs. */
async function adopt() {
	const adopting = engine.backend.reconcileRuntimeState();
	await engine.probeSubscribed;
	engine.clients
		.at(-1)
		?.emit({ type: "status", seq: 1, state: "streaming", streaming: true });
	expect(await adopting).toBe("streaming");
}
/** A new backend process: it has no pin and adopts the stream the engine still runs. */
async function restartBackend() {
	pinLaunchedAudio(undefined);
	engine.backend = new CerastreamBackend(engine.backend["deps"]);
	await adopt();
}
/** The same process adopts its own stream again, with no marker written for it. */
async function relinkUnarmed() {
	armed = undefined;
	loseLink();
	await adopt();
}

type MixUpdate = SetAudioMixParams["inputs"][number];
/** Routes the live RPCs to this stream's engine, which answers with what it applied. */
function liveEngine(
	answer: <T>(asked: T) => T | Promise<T> = (asked) => asked,
	applied: (update: MixUpdate) => MixUpdate = (update) => update,
) {
	const reloads: ReloadConfigParams[] = [];
	wrapClient((client) => {
		const raw = Reflect.get(client, "rawRequest");
		return {
			setAudioMix: async ({ inputs }: SetAudioMixParams) => ({
				inputs: await Promise.all(
					inputs.map(async (update) => {
						const running = engine.backend
							.getAudioMixInputs()
							?.find(({ input_id }) => input_id === update.input_id);
						return {
							gain_db: running?.gain_db ?? 0,
							mute: running?.mute ?? false,
							delay_ms: running?.delay_ms ?? 0,
							...applied(await answer(update)),
						};
					}),
				),
			}),
			reloadConfig: async (params: ReloadConfigParams) => {
				reloads.push(params);
				return { applied: await answer(params) };
			},
			setBitrate: async (params: object) => params,
			rawRequest: async (method: string, params: { audio_input_id: string }) =>
				method === "switch-audio"
					? {
							active_audio_input: (await answer(params)).audio_input_id,
							mode: "manual",
						}
					: raw(method, params),
		};
	});
	const live = () => engine.backend;
	spyOn(cerastreamBackend, "getAudioMixInputs").mockImplementation(() =>
		live().getAudioMixInputs(),
	);
	spyOn(cerastreamBackend, "setAudioMix").mockImplementation((params) =>
		live().setAudioMix(params),
	);
	spyOn(cerastreamBackend, "reloadAudioDelay").mockImplementation((delay) =>
		live().reloadAudioDelay(delay),
	);
	spyOn(cerastreamBackend, "switchAudio").mockImplementation((params) =>
		live().switchAudio(params),
	);
	return reloads;
}
const editMix = (id: string, edit: object) =>
	call(setAudioMixProcedure, { id, ...edit }, context());
const liveEdit = async (id: string, edit: object) =>
	expect(await editMix(id, edit)).toMatchObject({
		success: true,
		applies_next_start: false,
	});
const delayLive = (delay_ms: number) =>
	call(reloadAudioDelayProcedure, { delay_ms }, context());
const switchLive = (audio_input_id: string) =>
	call(switchAudioProcedure, { audio_input_id }, context());
async function running(asrc: string, shape: Shape) {
	keepMarker();
	savePressed(asrc, shape);
	expect(await start()).toMatchObject({ success: true });
}

const mutedSecond = mixed(wire("Primary", [1]), {
	...wire("Second", [2]),
	mute: true,
});

test.each([
	["mute", { mute: true }],
	["gain", { gain_db: -12 }],
	["delay", { delay_ms: 300 }],
])(
	"a live %s the engine acknowledged is still on after an engine restart",
	async (_name, edit) => {
		liveEngine();
		await running("Primary", "mix");
		await liveEdit("Second", edit);
		expect(await restart()).toEqual(
			mixed(wire("Primary", [1]), { ...wire("Second", [2]), ...edit }),
		);
	},
);

test("an engine restart restores the level the engine applied, not the one asked for", async () => {
	liveEngine(undefined, (update) => ({ ...update, gain_db: -11 }));
	await running("Primary", "mix");
	await liveEdit("Second", { gain_db: -20 });
	expect(await restart()).toEqual(
		mixed(wire("Primary", [1]), { ...wire("Second", [2]), gain_db: -11 }),
	);
});

test("a live mute the engine refused is not restored", async () => {
	liveEngine(() => {
		throw new CerastreamRpcError(-32602, "refused", "cerastream.refused", 1);
	});
	await running("Primary", "mix");
	expect(await editMix("Second", { mute: true })).toMatchObject({
		success: false,
	});
	expect(await restart()).toEqual(PRESSED.Primary.mix);
});

test.each(["Third", "Auto"])(
	"a live mute of %s, the main input outside the pressed mix, is still on after an engine restart",
	async (asrc) => {
		liveEngine();
		await running(asrc, "mix");
		await liveEdit("Third", { mute: true });
		expect(await restart()).toEqual(
			mixed(
				{ ...wire("Third", [1]), mute: true },
				wire("Primary", [1]),
				wire("Second", [2]),
			),
		);
	},
);

test("a live mute is still on after an engine restart although the mix was cleared for the next Start", async () => {
	liveEngine();
	await running("Primary", "mix");
	await call(setConfigProcedure, { audio_inputs: null }, context());
	await liveEdit("Second", { mute: true });
	expect(await disk()).not.toHaveProperty("audio_inputs");
	expect(await restart()).toEqual(mutedSecond);
});

test("a live mute is still on after an engine restart, and a mix edited for the next Start waits for it", async () => {
	liveEngine();
	await running("Primary", "mix");
	for (const [id, include] of [
		["Third", true],
		["Second", false],
	] as const)
		expect(await editMix(id, { include })).toMatchObject({
			success: true,
			applies_next_start: true,
		});
	await liveEdit("Second", { mute: true });
	expect(await restart()).toEqual(mutedSecond);
	expect(await disk()).toMatchObject({
		audio_inputs: [entry("Primary", [1]), entry("Third", [1])],
	});
});

test("a live mute is still on after a second engine restart", async () => {
	liveEngine();
	await running("Primary", "mix");
	await liveEdit("Second", { mute: true });
	await restart();
	expect(await restart()).toEqual(mutedSecond);
});

test("a live mute acknowledged before the stream is armed is still on after an engine restart", async () => {
	liveEngine();
	keepMarker();
	spyOn(streamSessionProductionDeps, "onStreamArmed").mockImplementation(
		() => {},
	);
	savePressed("Primary", "mix");
	expect(await start()).toMatchObject({ success: true });
	await liveEdit("Second", { mute: true });
	armStreamRestoration();
	expect(await restart()).toEqual(mutedSecond);
});

test("a live mute is still on when the backend and then the engine restart", async () => {
	liveEngine();
	await running("Primary", "mix");
	await liveEdit("Second", { mute: true });
	await restartBackend();
	expect(await restart()).toEqual(mutedSecond);
});

// Each answered by the engine only after Stop and a new Start.
test.each([
	["mix edit", "mix", () => editMix("Second", { mute: true })],
	["delay", "mix", () => delayLive(150)],
	["switch to silence", "single", () => switchLive("silence")],
] as const)(
	"a %s of the stream before is not restored into this one",
	async (_name, shape, change) => {
		let held = true;
		liveEngine(async (asked) => {
			if (held) {
				held = false;
				await hold();
			}
			return asked;
		});
		await running("Primary", shape);
		const changing = change();
		await reached.promise;
		await stop();
		expect(await start()).toMatchObject({ success: true });
		gate.resolve();
		await changing;
		expect(await restart()).toEqual(PRESSED.Primary[shape]);
	},
);

test("a live delay reload the engine acknowledged is still on after an engine restart", async () => {
	liveEngine();
	await running("Primary", "mix");
	expect(await delayLive(150)).toEqual({ success: true, delay_ms: 150 });
	expect(await restart()).toEqual({ ...PRESSED.Primary.mix, delay_ms: 150 });
});

test("a live reload restates the running delay, not the one saved for the next Start", async () => {
	const reloads = liveEngine();
	await running("Primary", "mix");
	spyOn(engine.backend["deps"], "getConfig").mockImplementation(getConfig);
	const reload = async () => {
		engine.backend.reloadConfig();
		await engine.backend.settle();
		return reloads.at(-1)?.audio;
	};
	await call(setConfigProcedure, { delay: 120 }, context());
	expect(await reload()).toEqual({ delay_ms_signed: 0 });
	await delayLive(150);
	expect(await reload()).toEqual({ delay_ms_signed: 150 });
	expect(await disk()).toMatchObject({ delay: 120 });
});

test.each([
	["after a backend restart", restartBackend],
	["again before it was armed", relinkUnarmed],
])(
	"a live reload of a stream adopted %s restates its running delay",
	async (_when, adopted) => {
		const reloads = liveEngine();
		await running("Primary", "mix");
		spyOn(engine.backend["deps"], "getConfig").mockImplementation(getConfig);
		await delayLive(150);
		await call(setConfigProcedure, { delay: 120 }, context());
		await adopted();
		engine.backend.reloadConfig();
		await engine.backend.settle();
		expect(reloads.at(-1)?.audio).toEqual({ delay_ms_signed: 150 });
	},
);

test.each([
	[
		"delay",
		"mix",
		() => delayLive(150),
		{ ...PRESSED.Primary.mix, delay_ms: 150 },
	],
	["switch to silence", "single", () => switchLive("silence"), silent],
] as const)(
	"a live %s made after a backend restart is still on after an engine restart",
	async (_name, shape, change, restored) => {
		liveEngine();
		await running("Primary", shape);
		await restartBackend();
		expect(await change()).toMatchObject({ success: true });
		expect(await restart()).toEqual(restored);
	},
);

test.each(["armed", "not armed yet"])(
	"a microphone switched to silence live (%s) stays off the air after an engine restart",
	async (when) => {
		liveEngine();
		keepMarker();
		if (when !== "armed")
			spyOn(streamSessionProductionDeps, "onStreamArmed").mockImplementation(
				() => {},
			);
		savePressed("Primary", "single");
		expect(await start()).toMatchObject({ success: true });
		expect(await switchLive("silence")).toMatchObject({ success: true });
		// This stream was still launched with its microphone.
		expect((await offActive()).snapshot).toBe(false);
		if (when !== "armed") armStreamRestoration();
		expect(await restart()).toEqual(silent);
		expect((await offActive()).snapshot).toBe(true);
	},
);

test("a microphone switched back on live is on the air after an engine restart", async () => {
	liveEngine();
	await running("Primary", "single");
	await switchLive("silence");
	await switchLive("hw:CARD=Primary");
	expect(await restart()).toEqual(PRESSED.Primary.single);
});

const LATER_AUDIO: typeof LATER = {
	...LATER,
	"a different codec": {
		save: () => call(setConfigProcedure, { acodec: "opus" }, context()),
		saved: { acodec: "opus" },
	},
	"a different audio backend": {
		save: async () => {
			getConfig().audio_backend = "pipewire";
			saveConfig();
			return { success: true };
		},
		saved: { audio_backend: "pipewire" },
	},
};
test.each(
	(Object.keys(PRESSED) as Pressed[]).flatMap((asrc) =>
		Object.keys(LATER_AUDIO)
			.filter((name) => name !== asrc)
			.flatMap((name) => SHAPES.map((shape) => [asrc, name, shape] as const)),
	),
)(
	"an engine restart restores the stream pressed with %s, not %s saved while it ran (%s saved)",
	async (asrc, name, shape) => {
		const choice = LATER_AUDIO[name];
		if (choice === undefined) throw new Error(name);
		await running(asrc, shape);
		expect(await choice.save()).toMatchObject({ success: true });
		expect(await restart()).toEqual(PRESSED[asrc][shape]);
		expect(probe.mock.calls.at(-1)).toEqual(PROBED[asrc]);
		expect(await disk()).toMatchObject(choice.saved);
		expect((await offActive()).snapshot).toBe(asrc === "No audio");
	},
);

// Live changes of the stream that are not its audio, with another pick saved.
const OTHER_LIVE_CHANGES: Record<string, () => Promise<void> | void> = {
	"the bitrate": async () => {
		spyOn(engine.backend["deps"], "getConfig").mockImplementation(getConfig);
		expect(engine.backend.setBitrate({ max_br: 4000 })).toBe(4000);
		await engine.backend.settle();
	},
	"the video source": () => {
		setStreamingProcedureDepsForTest({
			getSourcesMessage: () => ({ sources: [HDMI] }) as never,
		});
		try {
			applySwitchInputFollow("hdmi-rx", { success: true });
		} finally {
			setStreamingProcedureDepsForTest(null);
		}
		expect(getConfig().source).toBe("hdmi-rx");
	},
	"an encoder setting": () => {
		stageConfigChange(
			{
				attemptId: "change",
				startedAt: 1,
				candidate: { resolution: "720p" },
				previous: {},
			},
			{
				markerPath: "unused",
				readMarker: () => undefined,
				writeMarker: () => {},
				removeMarker: () => {},
			},
		);
		expect(commitStagedConfigChange("change")).toEqual({ resolution: "720p" });
	},
	"the stream profile": async () => {
		await setProfile();
	},
};
async function setProfile() {
	wireSetProfile();
	try {
		await handleSetProfile({
			commandId: "11111111-1111-4111-8111-111111111113",
			config: {
				presetId: "balanced",
				latencyMs: 2000,
				fecEnabled: false,
				recoveryMode: "standard",
			},
		});
	} finally {
		resetSetProfile();
	}
}
test.each(Object.keys(OTHER_LIVE_CHANGES))(
	"changing %s live leaves a live mute on after an engine restart, and No audio saved later waits for the next Start",
	async (name) => {
		liveEngine();
		await running("Primary", "mix");
		await liveEdit("Second", { mute: true });
		await OTHER_LIVE_CHANGES[name]?.();
		await pick("No audio");
		expect(await restart()).toEqual(mutedSecond);
		expect(await disk()).toMatchObject({ asrc: "No audio" });
	},
);

const RESTORE_AWAITS: typeof AWAITS = {
	...AWAITS,
	"runtime reconcile": () => {
		spyOn(streamSessionProductionDeps, "queryRuntime").mockImplementation(
			async () => {
				await hold();
				return "idle";
			},
		);
	},
};
test.each(
	Object.keys(RESTORE_AWAITS).flatMap((point) =>
		Object.keys(LATER)
			.filter((name) => name !== "Auto")
			.map((name) => [name, point] as const),
	),
)(
	"%s saved during %s of a restoration counts for the next Start",
	async (name, point) => {
		const choice = later(name);
		await running("Primary", "mix");
		await loseEngine();
		await RESTORE_AWAITS[point]?.();
		const restoring = restore();
		await Promise.race([reached.promise, restoring]);
		expect(await choice.save()).toMatchObject({ success: true });
		gate.resolve();
		expect((await restoring).result).toBe("recovered");
		expect(launchedAudio().at(-1)).toEqual(PRESSED.Primary.mix);
		expect(probe.mock.calls.at(-1)).toEqual(PROBED.Primary);
		await expectSaved("Primary", "mix", choice);
	},
);

test("a silent stream is still silent after an engine restart and says so", async () => {
	await running("No audio", "mix");
	await pick("Primary");
	await loseEngine();
	updateStatus(false);
	expect((await offActive()).snapshot).toBe(false);
	expect((await restore()).result).toBe("recovered");
	expect(launchedAudio().at(-1)).toEqual(silent);
	expect(await offActive()).toEqual({ snapshot: true, pulled: true });
});

test("a marker from before the mix was recorded restores its pick with the saved mix and backend", async () => {
	await running("Primary", "mix");
	const marker = JSON.parse(armed ?? "");
	delete marker.config.audio_inputs;
	armed = JSON.stringify(marker);
	getConfig().asrc = "Second";
	getConfig().audio_inputs = structuredClone(otherMix);
	getConfig().audio_backend = "pipewire";
	expect(await restart()).toEqual({
		...mixed(wire("Primary", [1]), wire("Second", [1])),
		backend: "pipewire",
	});
});

/** The first look of the real check, without its wait. */
const lookForMicrophone = () =>
	spyOn(audio, "asrcProbe").mockImplementation(async (asrc) => {
		if (isBluetoothAudioSourceId(asrc))
			await audio.refreshBluetoothAudioDevices();
		if (!(asrc in audio.getAudioDevices()))
			throw new audio.AudioProbeTimeoutError(asrc);
		return asrc;
	});
const BLUETOOTH = "bluealsa:DEV=AA:BB:CC:11:22:33,PROFILE=sco";
const BLUETOOTH_SHAPES = ["the main input", "another mix input"] as const;
const bluetoothOnTheWire = (as: (typeof BLUETOOTH_SHAPES)[number]) =>
	as === "the main input"
		? { mode: "device" as const, device: BLUETOOTH, delay_ms: 0 }
		: mixed(wire("Primary", [1]), {
				...wire("", [2]),
				input_id: BLUETOOTH,
			});
/** A saved Bluetooth microphone, listed, and the save that takes it off the list. */
async function savedBluetooth(as: (typeof BLUETOOTH_SHAPES)[number]) {
	const id = await listBluetoothMic();
	lookForMicrophone();
	getConfig().asrc = as === "the main input" ? id : "Primary";
	getConfig().audio_inputs =
		as === "the main input"
			? undefined
			: [entry("Primary", [1]), entry(id, [2])];
	saveConfig();
	return async () => {
		getConfig().audio_backend = "pipewire";
		saveConfig();
		await audio.refreshBluetoothAudioDevices();
	};
}

const ENTRIES: Record<
	string,
	(saveBackend: () => Promise<void>) => Promise<unknown>
> = {
	"the Start button": async (saveBackend) => {
		GATES["update admission"]?.();
		const started = start();
		await reached.promise;
		await saveBackend();
		gate.resolve();
		return started;
	},
	"a retried Start": async (saveBackend) => {
		await AWAITS["start retry wait"]?.();
		const started = start();
		await reached.promise;
		await saveBackend();
		gate.resolve();
		return started;
	},
	"an automatic start": async (saveBackend) => {
		spyOn(srtla, "genSrtlaIpList").mockReturnValue(["192.0.2.2"]);
		GATES["relay address lookup"]?.();
		const started = autoStartStream();
		await reached.promise;
		await saveBackend();
		gate.resolve();
		return started;
	},
	"a restart for a new stream profile": async (saveBackend) => {
		expect(await start()).toMatchObject({ success: true });
		spyOn(streamSessionProductionDeps, "stopRuntime").mockImplementation(
			async () => {
				await hold();
				return engine.backend.confirmStop();
			},
		);
		const configured = setProfile();
		await reached.promise;
		await saveBackend();
		gate.resolve();
		return configured;
	},
	"an engine restart": async (saveBackend) => {
		keepMarker();
		expect(await start()).toMatchObject({ success: true });
		await saveBackend();
		return restart();
	},
	"a retried engine restart": async (saveBackend) => {
		keepMarker();
		expect(await start()).toMatchObject({ success: true });
		await loseEngine();
		await AWAITS["start retry wait"]?.();
		const restoring = restore();
		await reached.promise;
		await saveBackend();
		gate.resolve();
		return restoring;
	},
};
test.each(
	Object.keys(ENTRIES).flatMap((name) =>
		BLUETOOTH_SHAPES.map((as) => [name, as] as const),
	),
)(
	"%s launches its Bluetooth microphone as %s although another audio backend is saved meanwhile",
	async (name, as) => {
		try {
			const saveBackend = await savedBluetooth(as);
			let launches = 0;
			await ENTRIES[name]?.(async () => {
				launches = launchedAudio().length;
				await saveBackend();
			});
			expect(launchedAudio().slice(launches)).toEqual([bluetoothOnTheWire(as)]);
			// The list is the saved backend's again once the launch is done.
			expect(Object.values(audio.getAudioDevices())).not.toContain(BLUETOOTH);
			expect(await disk()).toMatchObject({ audio_backend: "pipewire" });
		} finally {
			await unlistBluetoothMic();
		}
	},
);

test("a Bluetooth microphone that dropped is waited for after an engine restart", async () => {
	try {
		await savedBluetooth("the main input");
		keepMarker();
		expect(await start()).toMatchObject({ success: true });
		await pick("Primary");
		await unlistBluetoothMic();
		spyOn(audio, "asrcProbe").mockImplementation(async (asrc) => {
			await hold();
			return asrc;
		});
		await loseEngine();
		const restoring = restore();
		await Promise.race([reached.promise, restoring]);
		await listBluetoothMic();
		gate.resolve();
		expect((await restoring).result).toBe("recovered");
		expect(launchedAudio().at(-1)).toEqual(
			bluetoothOnTheWire("the main input"),
		);
	} finally {
		await unlistBluetoothMic();
	}
});

test("an unplugged microphone is waited for after an engine restart although another one is saved", async () => {
	await running("Second", "single");
	await pick("Primary");
	audio.setMockAudioDevicesProvider(() => ({ Primary: "hw:CARD=primary" }));
	expect(await restart()).toEqual(device("Second"));
	expect(probe.mock.calls.at(-1)).toEqual(["Second"]);
});

function reenumerate(from: string, to: string) {
	const devices = {
		Primary: "hw:CARD=primary",
		Second: "hw:CARD=second",
		Third: "hw:CARD=third",
	};
	Reflect.deleteProperty(devices, from);
	const successor = audio.audioIdentitySuccessor;
	audio.setMockAudioDevicesProvider(() => ({ ...devices }));
	spyOn(audio, "audioIdentitySuccessor").mockImplementation((asrc) =>
		successor(
			asrc,
			new Map([[to, { stable_id: "mic" }]]) as never,
			devices,
			new Map([[from, "mic"]]),
		),
	);
}

test("a microphone that re-enumerated is restored under its new id", async () => {
	await running("Second", "single");
	await pick("Primary");
	reenumerate("Second", "Third");
	expect(await restart()).toEqual(device("Third"));
});

test.each(SHAPES)(
	"a microphone that re-enumerates while the stream is restored is launched under its new id (%s)",
	async (shape) => {
		await running("Primary", shape);
		await loseEngine();
		GATES["bond preparation"]?.();
		const restoring = restore();
		await reached.promise;
		reenumerate("Primary", "Third");
		gate.resolve();
		expect((await restoring).result).toBe("recovered");
		expect(launchedAudio().at(-1)).toEqual(
			shape === "mix"
				? mixed(wire("Third", [1]), wire("Second", [2]))
				: device("Third"),
		);
	},
);

test("a microphone muted live that re-enumerated is still muted after an engine restart", async () => {
	liveEngine();
	await running("Primary", "mix");
	await liveEdit("Primary", { mute: true });
	reenumerate("Primary", "Third");
	expect(await restart()).toEqual(
		mixed({ ...wire("Third", [1]), mute: true }, wire("Second", [2])),
	);
});

test.each([
	"waiting for the microphone",
	"subscribing the engine client",
	"preparing a scoped engine Start",
] as const)(
	"restoration sends the known physical microphone's new id exactly once after rekeying while %s",
	async (stage) => {
		const card = join(directory, "card0");
		const listCard = async (id?: string) => {
			if (id === undefined) {
				await rm(card, { recursive: true, force: true });
			} else {
				await mkdir(join(card, "pcmC0D0c"), { recursive: true });
				await Bun.write(join(card, "id"), `${id}\n`);
			}
			await refreshEngineDeviceCache({
				fetchEngineDevices: async () => ({
					devices:
						id === undefined
							? []
							: [
									{
										alsa_card_id: id,
										input_id: `hw:CARD=${id}`,
										device_path: `hw:CARD=${id}`,
										media_class: "audio",
										display_name: "Recovery microphone",
										stable_id: "usb:restoration:rekey-mic",
									},
								],
				}),
			});
			await audio.updateAudioDevices(directory);
		};
		// Drive the same ALSA scan and inventory join in one controlled hotplug tick.
		setEngineAudioChangeHandler(() => {});
		try {
			if (stage === "preparing a scoped engine Start") {
				engine.dispose();
				engine = evidenceHarness(false, { schemaVersion: "0.25.0" });
			}
			await listCard("micOld");
			keepMarker();
			liveEngine();
			getConfig().asrc = "micOld";
			getConfig().audio_inputs = [entry("micOld", [1]), entry("Second", [2])];
			getConfig().audio_backend = "alsa";
			saveConfig();
			expect(await start()).toMatchObject({ success: true });
			await liveEdit("micOld", { mute: true, gain_db: -9, delay_ms: 120 });
			expect(await pick("Third")).toMatchObject({ success: true });
			getConfig().audio_backend = "pipewire";
			saveConfig();
			const saved = await disk();
			await loseEngine();
			const launches = engine.startRequests.length;
			spyOn(audio, "asrcProbe").mockRestore();

			if (stage === "waiting for the microphone") {
				await listCard();
				const notify = notifications.notificationBroadcast;
				spyOn(notifications, "notificationBroadcast").mockImplementation(
					(...args) => {
						if (args[0] === "asrc_not_found") reached.resolve();
						return notify(...args);
					},
				);
			} else if (stage === "subscribing the engine client") {
				spyOn(engine.backend["deps"], "connect").mockRestore();
				holdStreamSubscription();
			} else {
				spyOn(engine.backend["deps"], "connect").mockRestore();
				wrapClient(() => ({
					getCapabilities: async () => ({
						...CAPS,
						features: [ATTEMPT_SCOPED_START_FEATURE],
					}),
					prepareStart: async () => {
						await hold();
						return { attempt_id: "rekey-attempt", expires_in_ms: 10_000 };
					},
					cancelStart: async (attempt: unknown) => attempt,
				}));
			}
			const restoring = restore();
			try {
				expect(
					await Promise.race([
						reached.promise.then(() => "rekey boundary"),
						restoring.then(({ result }) => result),
					]),
				).toBe("rekey boundary");
				expect(engine.startRequests.slice(launches)).toEqual([]);
				await listCard("micNew");
			} finally {
				gate.resolve();
			}

			expect((await restoring).result).toBe("recovered");
			expect(launchedAudio().slice(launches)).toEqual([
				{
					...mixed(
						{
							input_id: "hw:CARD=micNew",
							tracks: [1],
							mute: true,
							gain_db: -9,
							delay_ms: 120,
						},
						wire("Second", [2]),
					),
					backend: "alsa",
				},
			]);
			if (stage === "preparing a scoped engine Start")
				expect(engine.startRequests.at(-1)).toHaveProperty(
					"attempt_id",
					"rekey-attempt",
				);
			expect(await disk()).toEqual(saved);
		} finally {
			audio.clearAsrcProbeReject();
			await listCard();
			audio.resetRememberedAudioIdentities();
			setEngineAudioChangeHandler(undefined);
		}
	},
	20_000,
);

test("a re-enumerated mix input whose new id is already in the mix is not sent twice", async () => {
	await running("Primary", "mix");
	getConfig().audio_inputs = [entry("Second", [1]), entry("Third", [2])];
	getConfig().asrc = "Third";
	await stop();
	const launches = engine.startRequests.length;
	holdStreamSubscription();
	const starting = start();
	try {
		expect(
			await Promise.race([
				reached.promise.then(() => "subscription"),
				starting.then(() => "Start finished"),
			]),
		).toBe("subscription");
		reenumerate("Second", "Third");
	} finally {
		gate.resolve();
	}
	expect(await starting).toMatchObject({ success: true });
	expect(launchedAudio().slice(launches)).toEqual([
		mixed(wire("Third", [2]), {
			...wire("Second", [1]),
			input_id: "hw:CARD=Second",
		}),
	]);
	expect(acceptStartAudio().config.audio_inputs?.map(({ id }) => id)).toEqual([
		"Second",
		"Third",
	]);
});
