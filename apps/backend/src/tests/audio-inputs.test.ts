import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListDevicesResult } from "@ceralive/cerastream";
import {
	type AudioInputConfig,
	connect,
	type GetCapabilitiesResult,
	PROTOCOL_VERSION,
	type rpcErrorSchema,
	rpcRequestSchema,
	SCHEMA_VERSION,
	setAudioMixParamsSchema,
	startParamsSchema,
} from "@ceralive/cerastream";
import type { AudioLevelMessage } from "@ceraui/rpc/schemas";
import {
	type AudioInputSetting,
	configMessageSchema,
	setAudioMixInputSchema,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import type { Socket } from "bun";
import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import {
	getConfig,
	getConfigFilePath,
	loadConfig,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	broadcastAudioSources,
	setMockAudioDevicesProvider,
} from "../modules/streaming/audio.ts";
import {
	launchAudioPlan,
	primaryAudioInputId,
} from "../modules/streaming/audio-inputs.ts";
import {
	initAudioMeterBridge,
	settleAudioMeterBridge,
	stopAudioMeterBridge,
	toAudioLevelMessage,
} from "../modules/streaming/audio-meter-bridge.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import {
	CerastreamBackend,
	cerastreamBackend,
} from "../modules/streaming/cerastream-backend.ts";
import { initPipelines } from "../modules/streaming/pipelines.ts";
import {
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import {
	getIsStreaming,
	updateStatus,
} from "../modules/streaming/streaming.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import * as procedures from "../rpc/procedures/streaming.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

const caps: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: ["test", "rtmp", "srt"].map((id) => ({
		id,
		supports_audio: true,
		supports_resolution_override: true,
		supports_framerate_override: true,
		default_resolution: "1080p",
		default_framerate: 30,
	})),
	network_embedded_audio: true,
	audio_mix: {
		max_inputs: 4,
		max_tracks: 4,
		gain_db_min: -60,
		gain_db_max: 12,
		delay_ms_max: 2000,
	},
};
const devices: Record<string, string> = {
	Primary: "hw:CARD=primary",
	Second: "hw:CARD=second",
	Third: "hw:CARD=third",
	Fourth: "hw:CARD=fourth",
	Fifth: "hw:CARD=fifth",
};
const entry = (id: string, tracks = [1]) => ({
	id,
	tracks,
	gain_db: 0,
	mute: false,
	delay_ms: 0,
});
let directory: string;
let previousPath: string;
let previousConfig: ReturnType<typeof getConfig>;
let previousStreaming: boolean;
let backend: CerastreamBackend;
let server: ReturnType<typeof Bun.listen>;
let requests: Array<{ method: string; params?: unknown }>;
let engineError:
	| ReturnType<typeof rpcErrorSchema.shape.error.parse>
	| undefined;
let liveSpies: Array<{ mockRestore(): void }>;
let meterSocket: Socket<{ pending: string }> | undefined;
let holdStart: boolean;
let startObserved: ReturnType<typeof Promise.withResolvers<void>>;
let releaseStart: (() => void) | undefined;
let engineAppliedGain: number | undefined;
let engineInputs: AudioInputConfig[];

async function capabilities(supported = true) {
	clearCapabilitiesCache();
	await initPipelines({
		fetchEngineCapabilities: async () => ({
			caps: supported ? caps : { ...caps, audio_mix: undefined },
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "ai-"));
	previousPath = getConfigFilePath();
	previousConfig = structuredClone(getConfig());
	previousStreaming = getIsStreaming();
	setConfigFilePath(join(directory, "config.json"));
	for (const key of Object.keys(getConfig()))
		Reflect.deleteProperty(getConfig(), key);
	Object.assign(getConfig(), {
		pipeline: "test",
		asrc: "Primary",
		max_br: 8000,
		srt_latency: 2000,
	});
	setMockAudioDevicesProvider(() => devices);
	updateStatus(false);
	await capabilities();
	requests = [];
	engineError = undefined;
	engineAppliedGain = undefined;
	engineInputs = [];
	liveSpies = [];
	meterSocket = undefined;
	holdStart = false;
	startObserved = Promise.withResolvers<void>();
	releaseStart = undefined;
	const socketPath = join(directory, "e.sock");
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
					if (
						engineError &&
						["start", "set-audio-mix"].includes(request.method)
					) {
						socket.write(
							`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: engineError })}\n`,
						);
						continue;
					}
					let result: unknown;
					switch (request.method) {
						case "hello":
							result = {
								protocol: PROTOCOL_VERSION,
								schema_version: "0.24.0",
								engine_version: "test",
							};
							break;
						case "subscribe-events":
							if (JSON.stringify(request.params).includes("audio-level"))
								meterSocket = socket;
							result = { subscribed: ["audio-level"] };
							break;
						case "start":
							engineInputs = structuredClone(
								startParamsSchema.parse(request.params).audio?.inputs ?? [],
							);
							result = { session_id: "audio-inputs", state: "streaming" };
							if (holdStart) {
								releaseStart = () =>
									socket.write(
										`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { session_id: "audio-inputs", state: "streaming" } })}\n`,
									);
								startObserved.resolve();
								continue;
							}
							break;
						case "set-audio-mix": {
							const updates = setAudioMixParamsSchema.parse(
								request.params,
							).inputs;
							result = {
								inputs: updates.map((update) => {
									const input = engineInputs.find(
										(input) => input.input_id === update.input_id,
									);
									if (!input)
										throw new Error(
											`Unexpected peer input: ${update.input_id}`,
										);
									if (update.gain_db !== undefined)
										input.gain_db = update.gain_db;
									if (engineAppliedGain !== undefined)
										input.gain_db = engineAppliedGain;
									if (update.mute !== undefined) input.mute = update.mute;
									if (update.delay_ms !== undefined)
										input.delay_ms = update.delay_ms;
									return {
										input_id: input.input_id,
										gain_db: input.gain_db ?? 0,
										mute: input.mute ?? false,
										delay_ms: input.delay_ms ?? 0,
									};
								}),
							};
							break;
						}
						case "switch-audio":
							result = { active_audio_input: "hw:CARD=second", mode: "manual" };
							break;
						case "reload-config":
							result = { applied: request.params };
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
		isEmbeddedAudioActive: (id) => id === "rtmp" || id === "srt",
		bridge: {
			notify() {},
			notificationExists: () => false,
			removeNotification() {},
			broadcastStatus() {},
			broadcastBuffering() {},
		},
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	});
});

afterEach(async () => {
	stopAudioMeterBridge();
	for (const spy of liveSpies) spy.mockRestore();
	await backend.confirmStop();
	await backend.settle();
	server.stop(true);
	setMockAudioDevicesProvider(undefined);
	clearCapabilitiesCache();
	for (const key of Object.keys(getConfig()))
		Reflect.deleteProperty(getConfig(), key);
	Object.assign(getConfig(), previousConfig);
	setConfigFilePath(previousPath);
	updateStatus(previousStreaming);
	await rm(directory, { recursive: true, force: true });
});

const save = (audio_inputs: readonly AudioInputSetting[] | null) =>
	call(
		procedures.setConfigProcedure,
		{ audio_inputs: audio_inputs === null ? null : [...audio_inputs] },
		{ context: makeRpcContext() },
	);
const disk = () => Bun.file(getConfigFilePath()).json();
async function start() {
	await backend.start(getConfig(), {
		pipeline: "test",
		host: "127.0.0.1",
		port: 9000,
		streamid: "audio-inputs",
	});
	return startParamsSchema.parse(
		requests.find((r) => r.method === "start")?.params,
	);
}
function routeLiveProcedure() {
	updateStatus(true);
	liveSpies.push(
		spyOn(cerastreamBackend, "getAudioMixInputs").mockImplementation(() =>
			backend.getAudioMixInputs(),
		),
		spyOn(cerastreamBackend, "setAudioMix").mockImplementation((params) =>
			backend.setAudioMix(params),
		),
		spyOn(cerastreamBackend, "switchAudio").mockImplementation((params) =>
			backend.switchAudio(params),
		),
	);
}
const change = (input: unknown) =>
	call(procedures.setAudioMixProcedure, setAudioMixInputSchema.parse(input), {
		context: makeRpcContext(),
	});

test("audio mix changes require authentication before persistence", async () => {
	saveConfig();
	const before = await Bun.file(getConfigFilePath()).text();
	await expect(
		call(
			procedures.setAudioMixProcedure,
			{ id: "Primary", gain_db: -6 },
			{
				context: { ...makeRpcContext(), isAuthenticated: () => false },
			},
		),
	).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	expect(await Bun.file(getConfigFilePath()).text()).toBe(before);
});

for (const path of ["save", "live"]) {
	for (const gain_db of [
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	]) {
		test(`${path} rejects non-finite gain ${gain_db} at the RPC boundary`, async () => {
			await save([entry("Primary"), entry("Second")]);
			if (path === "live") {
				await start();
				routeLiveProcedure();
			}
			const before = await Bun.file(getConfigFilePath()).text();
			const rejected =
				path === "save"
					? save([{ ...entry("Primary"), gain_db }])
					: call(
							procedures.setAudioMixProcedure,
							{ id: "Second", gain_db },
							{ context: makeRpcContext() },
						);
			await expect(rejected).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(await Bun.file(getConfigFilePath()).text()).toBe(before);
			expect(
				requests.filter((request) => request.method === "set-audio-mix"),
			).toEqual([]);
		});
	}
}

test("saved inputs round-trip and start with primary first and no device", async () => {
	const inputs = [
		{ ...entry("Second", [2]), gain_db: -12, mute: true, delay_ms: 300 },
		entry("Primary"),
	];
	expect(await save(inputs)).toMatchObject({
		success: true,
		applied: { audio_inputs: inputs },
	});
	expect(runtimeConfigSchema.parse(await disk())).toHaveProperty(
		"audio_inputs",
		inputs,
	);
	expect(
		configMessageSchema.parse(
			await call(procedures.getConfigProcedure, undefined, {
				context: makeRpcContext(),
			}),
		),
	).toHaveProperty("audio_inputs", inputs);
	expect((await start()).audio).toEqual({
		mode: "default",
		inputs: [
			{
				input_id: "hw:CARD=primary",
				tracks: [1],
				gain_db: 0,
				mute: false,
				delay_ms: 0,
			},
			{
				input_id: "hw:CARD=second",
				tracks: [2],
				gain_db: -12,
				mute: true,
				delay_ms: 300,
			},
		],
	});
});

test.each([{ inputs: null }, { inputs: [entry("Primary")] }])(
	"default-only or null save %j keeps the legacy start",
	async ({ inputs }) => {
		await save([entry("Primary"), entry("Second")]);
		expect(await save(inputs)).toMatchObject({
			success: true,
			applied: { audio_inputs: null },
		});
		expect(await disk()).not.toHaveProperty("audio_inputs");
		expect((await start()).audio).toEqual({
			mode: "device",
			device: "hw:CARD=Primary",
		});
	},
);

test("absence preserves exactly the legacy audio fields", async () => {
	getConfig().acodec = "aac";
	getConfig().delay = -120;
	expect((await start()).audio).toEqual({
		mode: "device",
		device: "hw:CARD=Primary",
		codec: "aac",
		delay_ms: -120,
	});
});

test("unsupported capability refuses saves atomically but permits clearing", async () => {
	saveConfig();
	const before = await Bun.file(getConfigFilePath()).text();
	await capabilities(false);
	expect(await save([entry("Primary"), entry("Second")])).toEqual({
		success: false,
		error: "audio_mix_unsupported",
		applied: { relay_protocol: "srtla" },
	});
	expect(await Bun.file(getConfigFilePath()).text()).toBe(before);
	expect(await save(null)).toMatchObject({ success: true });
});

const invalidInputs = [
	{
		name: "unknown input",
		inputs: [entry("Missing")],
		error: "audio_input_unknown",
	},
	{ name: "empty inputs", inputs: [], error: "audio_inputs_empty" },
	{
		name: "fifth input",
		inputs: Object.keys(devices).map((id) => entry(id)),
		error: "audio_inputs_too_many",
	},
	{
		name: "duplicate input",
		inputs: [entry("Primary"), entry("Primary")],
		error: "audio_input_duplicate",
	},
	{
		name: "empty tracks",
		inputs: [entry("Primary", [])],
		error: "audio_tracks_invalid",
	},
	{
		name: "track below one",
		inputs: [entry("Primary", [0])],
		error: "audio_tracks_invalid",
	},
	{
		name: "track above four",
		inputs: [entry("Primary", [1, 2, 3, 4, 5])],
		error: "audio_tracks_invalid",
	},
	{
		name: "fractional track",
		inputs: [entry("Primary", [1, 1.5])],
		error: "audio_tracks_invalid",
	},
	{
		name: "duplicate track",
		inputs: [entry("Primary", [1, 1])],
		error: "audio_tracks_invalid",
	},
	{
		name: "track gap",
		inputs: [entry("Primary"), entry("Second", [3])],
		error: "audio_tracks_gap",
	},
	{
		name: "track one empty",
		inputs: [entry("Primary", [2])],
		error: "audio_tracks_gap",
	},
	{
		name: "gain below minimum",
		inputs: [{ ...entry("Primary"), gain_db: -60.01 }],
		error: "audio_gain_range",
	},
	{
		name: "gain above maximum",
		inputs: [{ ...entry("Primary"), gain_db: 12.01 }],
		error: "audio_gain_range",
	},
	{
		name: "delay below zero",
		inputs: [{ ...entry("Primary"), delay_ms: -1 }],
		error: "audio_delay_range",
	},
	{
		name: "delay above maximum",
		inputs: [{ ...entry("Primary"), delay_ms: 2001 }],
		error: "audio_delay_range",
	},
	{
		name: "fractional delay",
		inputs: [{ ...entry("Primary"), delay_ms: 0.5 }],
		error: "audio_delay_range",
	},
];
for (const row of invalidInputs) {
	test(`save refuses ${row.name} without changing persisted config`, async () => {
		saveConfig();
		const before = await Bun.file(getConfigFilePath()).text();
		expect(await save(row.inputs)).toEqual({
			success: false,
			error: row.error,
			applied: { relay_protocol: "srtla" },
		});
		expect(await Bun.file(getConfigFilePath()).text()).toBe(before);
	});
}

const validInputs = [
	{ name: "gain minimum", inputs: [{ ...entry("Primary"), gain_db: -60 }] },
	{ name: "gain maximum", inputs: [{ ...entry("Primary"), gain_db: 12 }] },
	{
		name: "delay zero",
		inputs: [{ ...entry("Primary"), gain_db: -1, delay_ms: 0 }],
	},
	{ name: "delay maximum", inputs: [{ ...entry("Primary"), delay_ms: 2000 }] },
	{
		name: "four inputs and all four tracks",
		inputs: [
			entry("Primary", [1]),
			entry("Second", [2]),
			entry("Third", [3]),
			entry("Fourth", [4]),
		],
	},
	{ name: "one input on all tracks", inputs: [entry("Primary", [4, 2, 1, 3])] },
];
for (const row of validInputs) {
	test(`start accepts ${row.name}`, async () => {
		expect(await save(row.inputs)).toMatchObject({ success: true });
		expect((await start()).audio?.inputs).toEqual(
			row.inputs.map(({ id, ...rest }) => ({ input_id: devices[id], ...rest })),
		);
	});
}

test("network source id maps only its embedded input, not a microphone", async () => {
	getConfig().pipeline = "rtmp";
	getConfig().source = "rtmp";
	getConfig().asrc = "Auto";
	expect(await save([entry("Second", [2]), entry("rtmp")])).toMatchObject({
		success: true,
	});
	expect((await start()).audio).toEqual({
		mode: "default",
		inputs: [
			{
				input_id: "embedded",
				tracks: [1],
				gain_db: 0,
				mute: false,
				delay_ms: 0,
			},
			{
				input_id: "hw:CARD=second",
				tracks: [2],
				gain_db: 0,
				mute: false,
				delay_ms: 0,
			},
		],
	});
});

async function unplugSecond(tracks = [1]) {
	const saved = [entry("Primary"), entry("Second", tracks)];
	expect((await save(saved)).success).toBe(true);
	setMockAudioDevicesProvider(() => ({ Primary: "hw:CARD=primary" }));
	return saved;
}

test("muting Primary succeeds while the saved Second input is unplugged", async () => {
	const saved = await unplugSecond();
	expect((await change({ id: "Primary", mute: true })).success).toBe(true);
	expect((await disk()).audio_inputs).toEqual([
		{ ...entry("Primary"), mute: true },
		saved[1],
	]);
	expect(buildInitialStatus().status).toMatchObject({
		audio_mix_excluded: [{ id: "Second", reason: "unplugged" }],
	});
});

test("refreshing status after unplug keeps the still-attached mock input available", async () => {
	await unplugSecond();
	const sent = spyOn(websocket, "broadcastMsg");
	try {
		await broadcastAudioSources();
		const status = sent.mock.calls.find(
			([type, data]) =>
				type === "status" &&
				typeof data === "object" &&
				data !== null &&
				"audio_sources" in data,
		)?.[1];
		expect(status).toMatchObject({
			audio_mix_excluded: [{ id: "Second", reason: "unplugged" }],
		});
	} finally {
		sent.mockRestore();
	}
});

test("Start omits an unplugged input when another input covers its tracks", async () => {
	const saved = await unplugSecond();
	expect((await start()).audio?.inputs).toEqual([
		{
			input_id: "hw:CARD=primary",
			tracks: [1],
			gain_db: 0,
			mute: false,
			delay_ms: 0,
		},
	]);
	expect((await disk()).audio_inputs).toEqual(saved);
});

test("Start does not silently drop the unplugged input's sole track", async () => {
	const saved = await unplugSecond([2]);
	await expect(start()).rejects.toThrow();
	expect(requests.filter(({ method }) => method === "start")).toEqual([]);
	expect((await disk()).audio_inputs).toEqual(saved);
});

test("an unplugged saved input can be removed without reassigning tracks", async () => {
	await unplugSecond([2]);
	expect((await change({ id: "Primary", mute: true })).success).toBe(true);
	expect((await change({ id: "Second", include: false })).success).toBe(true);
	expect((await disk()).audio_inputs).toEqual([
		{ ...entry("Primary"), mute: true },
	]);
});

test("a saved RTMP embedded input stays visible but is not sent to a USB Start", async () => {
	Object.assign(getConfig(), {
		pipeline: "rtmp",
		source: "rtmp",
		asrc: "Auto",
	});
	expect((await save([entry("rtmp"), entry("Primary")])).success).toBe(true);
	Object.assign(getConfig(), {
		pipeline: "usb",
		source: "usb",
		asrc: "Primary",
	});
	expect((await change({ id: "Primary", mute: true })).success).toBe(true);
	expect(buildInitialStatus().status).toMatchObject({
		audio_mix_excluded: [{ id: "rtmp", reason: "other_source" }],
	});
	expect((await start()).audio?.inputs).toEqual([
		{
			input_id: "hw:CARD=primary",
			tracks: [1],
			gain_db: 0,
			mute: true,
			delay_ms: 0,
		},
	]);
	expect((await disk()).audio_inputs).toEqual([
		entry("rtmp"),
		{ ...entry("Primary"), mute: true },
	]);
});

test("live mix update drives the published client once and persists applied values", async () => {
	await save([entry("Second", [2]), entry("Primary")]);
	await start();
	routeLiveProcedure();
	const result = await change({
		id: "Second",
		gain_db: -20,
		mute: true,
		delay_ms: 800,
	});
	expect(result).toEqual({
		success: true,
		applied: { id: "Second", gain_db: -20, mute: true, delay_ms: 800 },
		applies_next_start: false,
	});
	expect(
		requests
			.filter((r) => r.method === "set-audio-mix")
			.map(({ method, params }) => ({ method, params })),
	).toEqual([
		{
			method: "set-audio-mix",
			params: {
				inputs: [
					{
						input_id: "hw:CARD=second",
						gain_db: -20,
						mute: true,
						delay_ms: 800,
					},
				],
			},
		},
	]);
	expect((await disk()).audio_inputs).toEqual([
		{ ...entry("Second", [2]), gain_db: -20, mute: true, delay_ms: 800 },
		entry("Primary"),
	]);
});

for (const mute of [undefined, false, true]) {
	test(`saving primary mute ${mute} retains only the muted non-default through reload and Start`, async () => {
		const primary = {
			id: "Primary",
			tracks: [1],
			gain_db: 0,
			delay_ms: 0,
			...(mute === undefined ? {} : { mute }),
		};
		expect(
			await call(
				procedures.setConfigProcedure,
				{ audio_inputs: [primary] },
				{ context: makeRpcContext() },
			),
		).toMatchObject({ success: true });
		const persisted = await disk();
		if (mute === true)
			expect(persisted.audio_inputs).toEqual([
				{ ...entry("Primary"), mute: true },
			]);
		else expect(persisted).not.toHaveProperty("audio_inputs");
		const savedBytes = await Bun.file(getConfigFilePath()).text();
		await loadConfig();
		expect(await Bun.file(getConfigFilePath()).text()).toBe(savedBytes);
		const params = await start();
		if (mute === true)
			expect(params.audio?.inputs).toEqual([
				{
					input_id: "hw:CARD=primary",
					tracks: [1],
					gain_db: 0,
					mute: true,
					delay_ms: 0,
				},
			]);
		else expect(params.audio).not.toHaveProperty("inputs");
	});

	test(`loaded primary mute ${mute} maps its default at Start and retains it on a partial live update`, async () => {
		const primary = {
			id: "Primary",
			tracks: [1],
			gain_db: 0,
			delay_ms: 0,
			...(mute === undefined ? {} : { mute }),
		};
		const savedBytes = JSON.stringify({
			...getConfig(),
			audio_inputs: [primary],
		});
		await Bun.write(getConfigFilePath(), savedBytes);
		await loadConfig();
		expect(getConfig().audio_inputs).toEqual([
			{ ...entry("Primary"), mute: mute ?? false },
		]);
		expect(await Bun.file(getConfigFilePath()).text()).toBe(savedBytes);
		expect((await start()).audio?.inputs).toEqual([
			{
				input_id: "hw:CARD=primary",
				tracks: [1],
				gain_db: 0,
				mute: mute ?? false,
				delay_ms: 0,
			},
		]);
		routeLiveProcedure();
		expect(await change({ id: "Primary", gain_db: -7 })).toEqual({
			success: true,
			applied: { id: "Primary", gain_db: -7, mute: mute ?? false, delay_ms: 0 },
			applies_next_start: false,
		});
		expect((await disk()).audio_inputs).toEqual([
			{ ...entry("Primary"), gain_db: -7, mute: mute ?? false },
		]);
	});
}

test("a partial live update preserves a nonzero admitted gain in the reply and on disk", async () => {
	await save([entry("Primary"), { ...entry("Second", [2]), gain_db: -9 }]);
	await start();
	routeLiveProcedure();
	expect(await change({ id: "Second", mute: true, delay_ms: 300 })).toEqual({
		success: true,
		applied: { id: "Second", gain_db: -9, mute: true, delay_ms: 300 },
		applies_next_start: false,
	});
	expect((await disk()).audio_inputs).toEqual([
		entry("Primary"),
		{ ...entry("Second", [2]), gain_db: -9, mute: true, delay_ms: 300 },
	]);
});

test("a different engine-applied gain is echoed persisted reloaded and mapped into the next Start", async () => {
	await save([entry("Primary"), entry("Second", [2])]);
	await start();
	routeLiveProcedure();
	engineAppliedGain = -11;
	expect(await change({ id: "Second", gain_db: -20 })).toEqual({
		success: true,
		applied: { id: "Second", gain_db: -11, mute: false, delay_ms: 0 },
		applies_next_start: false,
	});
	expect((await disk()).audio_inputs).toEqual([
		entry("Primary"),
		{ ...entry("Second", [2]), gain_db: -11 },
	]);
	await backend.confirmStop();
	updateStatus(false);
	await loadConfig();
	requests = [];
	expect((await start()).audio?.inputs).toEqual([
		{
			input_id: "hw:CARD=primary",
			tracks: [1],
			gain_db: 0,
			mute: false,
			delay_ms: 0,
		},
		{
			input_id: "hw:CARD=second",
			tracks: [2],
			gain_db: -11,
			mute: false,
			delay_ms: 0,
		},
	]);
});

for (const row of [
	{ name: "gain minimum", update: { gain_db: -60 } },
	{ name: "gain maximum", update: { gain_db: 12 } },
	{ name: "delay zero", update: { delay_ms: 0 } },
	{ name: "delay maximum", update: { delay_ms: 2000 } },
]) {
	test(`live accepts ${row.name}`, async () => {
		await save([entry("Primary"), entry("Second")]);
		await start();
		routeLiveProcedure();
		expect(await change({ id: "Second", ...row.update })).toMatchObject({
			success: true,
			applied: { id: "Second", ...row.update },
			applies_next_start: false,
		});
	});
}
for (const row of [
	{
		name: "gain below minimum",
		update: { gain_db: -60.01 },
		error: "audio_gain_range",
	},
	{
		name: "gain above maximum",
		update: { gain_db: 12.01 },
		error: "audio_gain_range",
	},
	{
		name: "delay below zero",
		update: { delay_ms: -1 },
		error: "audio_delay_range",
	},
	{
		name: "delay above maximum",
		update: { delay_ms: 2001 },
		error: "audio_delay_range",
	},
	{
		name: "fractional delay",
		update: { delay_ms: 0.5 },
		error: "audio_delay_range",
	},
]) {
	test(`live refuses ${row.name} without engine or persistence changes`, async () => {
		await save([entry("Primary"), entry("Second")]);
		await start();
		routeLiveProcedure();
		const before = await Bun.file(getConfigFilePath()).text();
		expect(await change({ id: "Second", ...row.update })).toEqual({
			success: false,
			error: row.error,
		});
		expect(requests.filter((r) => r.method === "set-audio-mix")).toEqual([]);
		expect(await Bun.file(getConfigFilePath()).text()).toBe(before);
	});
}

test.each([false, true])(
	"non-mix session or idle saves for next start (streaming=%s)",
	async (streaming) => {
		if (streaming) await start();
		await save([entry("Primary"), entry("Second")]);
		routeLiveProcedure();
		updateStatus(streaming);
		expect(await change({ id: "Second", gain_db: -6 })).toMatchObject({
			success: true,
			applies_next_start: true,
			applied: { id: "Second", gain_db: -6 },
		});
		expect(requests.filter((r) => r.method === "set-audio-mix")).toEqual([]);
		if (streaming) {
			expect(
				await call(
					procedures.switchAudioProcedure,
					{ audio_input_id: "hw:CARD=second" },
					{ context: makeRpcContext() },
				),
			).toMatchObject({ success: true });
		}
	},
);

test("mix source switch refuses even after next-start settings are cleared", async () => {
	await save([entry("Primary"), entry("Second")]);
	await start();
	routeLiveProcedure();
	await save(null);
	expect(
		await call(
			procedures.switchAudioProcedure,
			{ audio_input_id: "hw:CARD=second" },
			{ context: makeRpcContext() },
		),
	).toEqual({ success: false, error: "audio_mix_active" });
	expect(requests.filter((r) => r.method === "switch-audio")).toEqual([]);
});

test("live engine error preserves the native numeric code, token and data", async () => {
	await save([entry("Primary"), entry("Second")]);
	await start();
	routeLiveProcedure();
	engineError = {
		code: -32602,
		message:
			"invalid params: audio-gain-range: invalid audio mix configuration",
		data: {
			code: "cerastream.params.invalid",
		},
	};
	const before = await Bun.file(getConfigFilePath()).text();
	expect(await change({ id: "Second", gain_db: -20 })).toEqual({
		success: false,
		error: "cerastream.params.invalid",
		engine_error: engineError,
	});
	expect(await Bun.file(getConfigFilePath()).text()).toBe(before);
});

test("a native start refusal retains its numeric code, message and capture cause", async () => {
	await save([entry("Primary"), entry("Second")]);
	getConfig().composition = {
		secondary_input_id: "secondary",
		layout: "pip-top-right",
	};
	engineError = {
		code: -32602,
		message:
			"invalid params: composition-unsupported: rgacompositor did not pass its READY backend trial",
		data: {
			code: "cerastream.params.invalid",
			capture_causes: [
				{ device: "composition", cause: "composition-unsupported" },
			],
		},
	};
	await expect(start()).rejects.toMatchObject({
		failure: {
			phase: "start-rpc",
			code: -32602,
			message: engineError.message,
			captureCause: "composition-unsupported",
		},
	});
	expect(backend.getAudioMixInputs()).toBeUndefined();
});

test("per-input levels retain their values under the corresponding CeraUI ids", async () => {
	await save([entry("Second", [2]), entry("Primary")]);
	await start();
	routeLiveProcedure();
	expect(
		toAudioLevelMessage({
			type: "audio-level",
			seq: 1,
			channels: 2,
			rms_db: [-10, -11],
			peak_db: [-8, -9],
			inputs: [
				{
					input_id: "hw:CARD=second",
					channels: 1,
					rms_db: [-31],
					peak_db: [-20],
				},
				{
					input_id: "hw:CARD=primary",
					channels: 2,
					rms_db: [-13, -14],
					peak_db: [-4, -5],
				},
			],
		}).inputs,
	).toEqual([
		{ input_id: "Second", channels: 1, rms_db: [-31], peak_db: [-20] },
		{ input_id: "Primary", channels: 2, rms_db: [-13, -14], peak_db: [-4, -5] },
	]);
});

test("mix status follows the admitted session across save, clear, stop and next start", async () => {
	await save([entry("Primary"), entry("Second")]);
	await start();
	routeLiveProcedure();
	expect(buildInitialStatus().status.audio_mix_active).toBe(true);
	await save(null);
	expect(buildInitialStatus().status.audio_mix_active).toBe(true);
	await backend.confirmStop();
	expect(buildInitialStatus().status.audio_mix_active).toBe(false);
	await start();
	expect(buildInitialStatus().status.audio_mix_active).toBe(false);
});

test("saving pending membership leaves live input updates on the admitted engine id and track", async () => {
	await save([entry("Primary"), entry("Second", [2])]);
	await start();
	routeLiveProcedure();
	await save([entry("Primary"), entry("Second"), entry("Third", [2])]);
	expect(await change({ id: "Third", gain_db: -8 })).toEqual({
		success: false,
		error: "audio_input_unknown",
	});
	expect(await change({ id: "Second", gain_db: -8 })).toMatchObject({
		success: true,
		applies_next_start: false,
	});
	expect((await disk()).audio_inputs).toEqual([
		entry("Primary"),
		{ ...entry("Second"), gain_db: -8 },
		entry("Third", [2]),
	]);
	expect(
		backend
			.getAudioMixInputs()
			?.map((input) => ({ id: input.id, tracks: input.tracks })),
	).toEqual([
		{ id: "Primary", tracks: [1] },
		{ id: "Second", tracks: [2] },
	]);
});

test("capability loss leaves a saved mix untouched and sends the legacy path", async () => {
	await save([entry("Primary"), entry("Second")]);
	const before = await Bun.file(getConfigFilePath()).text();
	await capabilities(false);
	expect((await start()).audio).toEqual({
		mode: "device",
		device: "hw:CARD=Primary",
	});
	expect(await Bun.file(getConfigFilePath()).text()).toBe(before);
});

test("a config save during Start cannot erase the admitted CeraUI input identities", async () => {
	await save([entry("Primary"), entry("Second")]);
	holdStart = true;
	const started = start();
	await startObserved.promise;
	await save(null);
	releaseStart?.();
	await started;
	routeLiveProcedure();
	expect(await change({ id: "Second", gain_db: -17 })).toMatchObject({
		success: true,
		applied: { id: "Second", gain_db: -17 },
		applies_next_start: false,
	});
	expect(await disk()).not.toHaveProperty("audio_inputs");
});

test("streaming mix levels survive a deferred No audio selection", async () => {
	await save([entry("Primary"), entry("Second")]);
	await start();
	routeLiveProcedure();
	await call(
		procedures.setConfigProcedure,
		{ asrc: "No audio" },
		{ context: makeRpcContext() },
	);
	const received = Promise.withResolvers<AudioLevelMessage>();
	initAudioMeterBridge({
		connect,
		connectOptions: {
			socketPath: join(directory, "e.sock"),
			autoReconnect: false,
		},
		broadcast: (message) => received.resolve(message),
		meterPreference: () => null,
		meterSilenced: () => true,
		meterPreferencePresent: () => true,
	});
	await settleAudioMeterBridge();
	expect(meterSocket).toBeDefined();
	meterSocket?.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			method: "event",
			params: {
				type: "audio-level",
				seq: 1,
				source: { owner: "streaming", identity: "program" },
				channels: 2,
				rms_db: [-10, -11],
				peak_db: [-8, -9],
				inputs: [
					{
						input_id: "hw:CARD=second",
						channels: 1,
						rms_db: [-31],
						peak_db: [-20],
					},
					{
						input_id: "hw:CARD=primary",
						channels: 2,
						rms_db: [-13, -14],
						peak_db: [-4, -5],
					},
				],
			},
		})}\n`,
	);
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		const message = await Promise.race([
			received.promise,
			new Promise<never>((_, reject) => {
				deadline = setTimeout(
					() => reject(new Error("No bridged mix level within 1 s")),
					1000,
				);
			}),
		]);
		expect(message.inputs).toEqual([
			{ input_id: "Second", channels: 1, rms_db: [-31], peak_db: [-20] },
			{
				input_id: "Primary",
				channels: 2,
				rms_db: [-13, -14],
				peak_db: [-4, -5],
			},
		]);
		expect(message.unavailable).toBeUndefined();
	} finally {
		clearTimeout(deadline);
	}
});

const twoInputs = [entry("Primary"), entry("Second", [2])];
const twoInputsOnTheWire = [
	{
		input_id: "hw:CARD=primary",
		tracks: [1],
		gain_db: 0,
		mute: false,
		delay_ms: 0,
	},
	{
		input_id: "hw:CARD=second",
		tracks: [2],
		gain_db: 0,
		mute: false,
		delay_ms: 0,
	},
];

test.each(["test", "rtmp"])(
	"No audio with a saved two-input mix starts with no audio at all on the %s pipeline and keeps the mix on disk",
	async (pipeline) => {
		getConfig().pipeline = pipeline;
		await save(twoInputs);
		await pick("No audio");
		Object.assign(getConfig(), {
			acodec: "aac",
			delay: -120,
			audio_backend: "pipewire",
		});
		const saved = await Bun.file(getConfigFilePath()).text();
		expect((await start()).audio).toEqual({
			backend: "pipewire",
			mode: "none",
			codec: "aac",
			delay_ms: -120,
		});
		expect(getConfig().audio_inputs).toEqual(twoInputs);
		expect(await Bun.file(getConfigFilePath()).text()).toBe(saved);
	},
);

test("a saved config from before the fix with No audio and a two-input mix starts with no audio and keeps the file as it was", async () => {
	await Bun.write(
		getConfigFilePath(),
		JSON.stringify({
			pipeline: "test",
			asrc: "No audio",
			max_br: 8000,
			srt_latency: 2000,
			audio_inputs: twoInputs,
		}),
	);
	await loadConfig();
	expect(getConfig().audio_inputs).toEqual(twoInputs);
	const loaded = await Bun.file(getConfigFilePath()).text();
	expect((await start()).audio).toEqual({ mode: "none", delay_ms: 0 });
	expect(await Bun.file(getConfigFilePath()).text()).toBe(loaded);
});

test("picking a microphone while a No audio Start is held keeps this stream silent, edits keep the mix, and the next Start sends it", async () => {
	await save(twoInputs);
	await pick("No audio");
	holdStart = true;
	const started = start();
	await startObserved.promise;
	await pick("Primary");
	releaseStart?.();
	expect((await started).audio).toEqual({ mode: "none" });
	routeLiveProcedure();
	expect(buildInitialStatus().status.audio_mix_active).toBe(false);
	expect(await change({ id: "Second", gain_db: -6 })).toMatchObject({
		success: true,
		applies_next_start: true,
	});
	await backend.confirmStop();
	holdStart = false;
	requests = [];
	expect((await start()).audio).toEqual({
		mode: "default",
		inputs: [twoInputsOnTheWire[0], { ...twoInputsOnTheWire[1], gain_db: -6 }],
	});
});

test("Start sends launchAudioPlan, and audio off sends none over any pick and mix without saving", async () => {
	await save(twoInputs);
	const saved = await Bun.file(getConfigFilePath()).text();
	expect(launchAudioPlan(getConfig(), { audioOff: true })).toEqual({
		mode: "none",
	});
	expect((await start()).audio).toEqual(launchAudioPlan(getConfig()));
	expect(launchAudioPlan(getConfig())).toEqual({
		mode: "default",
		inputs: twoInputsOnTheWire,
	});
	expect(await Bun.file(getConfigFilePath()).text()).toBe(saved);
});

test("Pipeline default with a saved mix still starts that mix", async () => {
	await save(twoInputs);
	await pick("Pipeline default");
	expect((await start()).audio).toEqual({
		mode: "default",
		inputs: twoInputsOnTheWire,
	});
});

test("Start sends a main input outside the saved mix first on Track 1 and leaves the saved mix as it was", async () => {
	const saved = [entry("Primary"), entry("Second", [2])];
	expect(await save(saved)).toMatchObject({ success: true });
	getConfig().asrc = "Third";
	expect((await start()).audio?.inputs).toEqual([
		{
			input_id: "hw:CARD=third",
			tracks: [1],
			gain_db: 0,
			mute: false,
			delay_ms: 0,
		},
		{
			input_id: "hw:CARD=primary",
			tracks: [1],
			gain_db: 0,
			mute: false,
			delay_ms: 0,
		},
		{
			input_id: "hw:CARD=second",
			tracks: [2],
			gain_db: 0,
			mute: false,
			delay_ms: 0,
		},
	]);
	expect(getConfig().audio_inputs).toEqual(saved);
	expect((await disk()).audio_inputs).toEqual(saved);
});

test("in a full saved mix Start gives a main input outside it the first entry's place and tracks", async () => {
	const saved = [
		entry("Primary", [1, 2]),
		entry("Second", [3]),
		entry("Third", [4]),
		entry("Fourth", [4]),
	];
	expect(await save(saved)).toMatchObject({ success: true });
	getConfig().asrc = "Fifth";
	expect((await start()).audio?.inputs).toEqual([
		{
			input_id: "hw:CARD=fifth",
			tracks: [1, 2],
			gain_db: 0,
			mute: false,
			delay_ms: 0,
		},
		{
			input_id: "hw:CARD=second",
			tracks: [3],
			gain_db: 0,
			mute: false,
			delay_ms: 0,
		},
		{
			input_id: "hw:CARD=third",
			tracks: [4],
			gain_db: 0,
			mute: false,
			delay_ms: 0,
		},
		{
			input_id: "hw:CARD=fourth",
			tracks: [4],
			gain_db: 0,
			mute: false,
			delay_ms: 0,
		},
	]);
});

test("a main input the device cannot open is not added to the mix Start sends", async () => {
	expect(await save([entry("Primary"), entry("Second", [2])])).toMatchObject({
		success: true,
	});
	getConfig().asrc = "Ghost";
	expect((await start()).audio?.inputs).toEqual([
		{
			input_id: "hw:CARD=primary",
			tracks: [1],
			gain_db: 0,
			mute: false,
			delay_ms: 0,
		},
		{
			input_id: "hw:CARD=second",
			tracks: [2],
			gain_db: 0,
			mute: false,
			delay_ms: 0,
		},
	]);
});

test("idle, a level change on a main input outside the saved mix saves the mix Start sends", async () => {
	expect(await save([entry("Primary"), entry("Second", [2])])).toMatchObject({
		success: true,
	});
	getConfig().asrc = "Third";
	expect(await change({ id: "Third", gain_db: -2 })).toMatchObject({
		success: true,
		applies_next_start: true,
		applied: { id: "Third", gain_db: -2 },
	});
	expect((await disk()).audio_inputs).toEqual([
		{ ...entry("Third"), gain_db: -2 },
		entry("Primary"),
		entry("Second", [2]),
	]);
});

test("live, a level change on a main input outside the saved mix is admitted and saved with the mix it runs in", async () => {
	expect(await save([entry("Primary"), entry("Second", [2])])).toMatchObject({
		success: true,
	});
	getConfig().asrc = "Third";
	await start();
	routeLiveProcedure();
	expect(await change({ id: "Third", gain_db: -3 })).toMatchObject({
		success: true,
		applies_next_start: false,
		applied: { id: "Third", gain_db: -3 },
	});
	expect(getConfig().audio_inputs).toEqual([
		{ ...entry("Third"), gain_db: -3 },
		entry("Primary"),
		entry("Second", [2]),
	]);
});

const pick = (asrc: string) =>
	call(
		procedures.setConfigProcedure,
		{ asrc, audio_pick: true },
		{ context: makeRpcContext() },
	);
const ids = (inputs: Array<{ id: string }> | undefined) =>
	inputs?.map((input) => input.id);
async function maxInputs(
	max_inputs: number,
	extra: Partial<GetCapabilitiesResult> = {},
) {
	clearCapabilitiesCache();
	const mix = caps.audio_mix as NonNullable<GetCapabilitiesResult["audio_mix"]>;
	await initPipelines({
		fetchEngineCapabilities: async () => ({
			caps: { ...caps, ...extra, audio_mix: { ...mix, max_inputs } },
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
}

test("an explicit pick outside a saved mix saves the pick and the mix it implies in one write", async () => {
	expect(await save([entry("Primary"), entry("Second", [2])])).toMatchObject({
		success: true,
	});
	expect(await pick("Third")).toMatchObject({
		success: true,
		applied: {
			asrc: "Third",
			audio_inputs: [entry("Third"), entry("Primary"), entry("Second", [2])],
		},
	});
	expect(await disk()).toMatchObject({
		asrc: "Third",
		audio_inputs: [entry("Third"), entry("Primary"), entry("Second", [2])],
	});
});

test("a pick already in the saved mix saves only the pick", async () => {
	const saved = [entry("Primary"), entry("Second", [2])];
	expect(await save(saved)).toMatchObject({ success: true });
	const result = await pick("Second");
	expect(result).toMatchObject({ success: true, applied: { asrc: "Second" } });
	expect(result.applied).not.toHaveProperty("audio_inputs");
	expect(await disk()).toMatchObject({ asrc: "Second", audio_inputs: saved });
});

test("picks sent without waiting compose on the saved mix: B then C keeps B", async () => {
	expect(await save([{ ...entry("Primary"), gain_db: -3 }])).toMatchObject({
		success: true,
	});
	const [b, c] = await Promise.all([pick("Second"), pick("Third")]);
	expect([b.success, c.success]).toEqual([true, true]);
	const saved = await disk();
	expect([...(ids(saved.audio_inputs) ?? [])].sort()).toEqual([
		"Primary",
		"Second",
		"Third",
	]);
	expect(saved.audio_inputs[0].id).toBe(saved.asrc);
	expect(saved.audio_inputs).toContainEqual({
		...entry("Primary"),
		gain_db: -3,
	});
});

test("a stale second tab's pick keeps the input another tab picked", async () => {
	expect(await save([{ ...entry("Primary"), gain_db: -3 }])).toMatchObject({
		success: true,
	});
	expect(await pick("Second")).toMatchObject({ success: true });
	expect(await pick("Third")).toMatchObject({ success: true });
	expect((await disk()).audio_inputs).toEqual([
		entry("Third"),
		entry("Second"),
		{ ...entry("Primary"), gain_db: -3 },
	]);
});

test("full mix, chained: a secondary picked as main keeps the mix, then a new input replaces it and keeps the first", async () => {
	await maxInputs(2);
	expect(await save([entry("Primary"), entry("Second", [2])])).toMatchObject({
		success: true,
	});
	expect((await pick("Second")).applied).not.toHaveProperty("audio_inputs");
	expect(await pick("Third")).toMatchObject({ success: true });
	expect(await disk()).toMatchObject({
		asrc: "Third",
		audio_inputs: [entry("Third", [2]), entry("Primary")],
	});
});

test("full mix with Auto resolved to a same-device input: a new pick replaces that input, keeps the other and takes its track", async () => {
	const uvc = (
		caps.sources as NonNullable<GetCapabilitiesResult["sources"]>
	)[0];
	await maxInputs(2, {
		sources: [...(caps.sources ?? []), { ...uvc, id: "libuvch264" }],
	});
	setMockAudioDevicesProvider(() => ({ ...devices, "USB audio": "Micro" }));
	await refreshEngineDeviceCache({
		fetchEngineDevices: async () =>
			({
				devices: [
					{
						input_id: "usb-cam-1",
						device_path: "/dev/video1",
						display_name: "USB Streamer",
						media_class: "video",
						kind: "uvc_h264",
						physical_group_id: "usb:10-1",
					},
					{
						input_id: "usb-audio-1",
						device_path: "",
						display_name: "RØDE AI-Micro",
						media_class: "audio",
						kind: "audio",
						alsa_card_id: "Micro",
						physical_group_id: "usb:10-1",
					},
				],
			}) as unknown as ListDevicesResult,
	});
	try {
		getConfig().source = "usb-cam-1";
		expect(
			await save([entry("Primary"), entry("USB audio", [2])]),
		).toMatchObject({ success: true });
		expect((await pick("Auto")).applied).not.toHaveProperty("audio_inputs");
		expect(primaryAudioInputId(getConfig())).toBe("USB audio");
		expect(await pick("Second")).toMatchObject({ success: true });
		expect(await disk()).toMatchObject({
			asrc: "Second",
			audio_inputs: [entry("Second", [2]), entry("Primary")],
		});
	} finally {
		resetEngineDeviceCache();
	}
});

test("picking another primary keeps a saved unplugged input and its original tracks", async () => {
	const saved = [entry("Primary"), entry("Fourth", [2])];
	expect(await save(saved)).toMatchObject({ success: true });
	const { Fourth: _unplugged, ...rest } = devices;
	setMockAudioDevicesProvider(() => rest);
	expect((await pick("Third")).success).toBe(true);
	const stored = await disk();
	expect(stored.asrc).toBe("Third");
	expect(stored.audio_inputs).toEqual([entry("Third"), ...saved]);
});

test("an asrc save without the pick marker changes no membership", async () => {
	const saved = [entry("Primary"), entry("Second", [2])];
	expect(await save(saved)).toMatchObject({ success: true });
	expect(
		await call(
			procedures.setConfigProcedure,
			{ asrc: "Third" },
			{ context: makeRpcContext() },
		),
	).toMatchObject({ success: true });
	expect((await disk()).audio_inputs).toEqual(saved);
});

type MixEntry = ReturnType<typeof entry>;
type Delta = {
	id: string;
	gain_db?: number;
	mute?: boolean;
	delay_ms?: number;
	include?: boolean;
	track?: { number: number; on: boolean };
};

test("interleaved picks and edits from two tabs with stale views never lose an accepted input or setting", async () => {
	// The reference: the mix rules in plain terms, applied in the order the device accepts them.
	const model = {
		asrc: "Primary",
		mix: [{ ...entry("Primary"), gain_db: -2 }] as MixEntry[],
	};
	const applyPick = (id: string) => {
		if (!model.mix.some((input) => input.id === id)) {
			if (model.mix.length < 4) model.mix = [entry(id), ...model.mix];
			else {
				const replaced =
					model.mix.find((input) => input.id === model.asrc) ?? model.mix[0];
				model.mix = [
					entry(id, [...(replaced?.tracks ?? [1])]),
					...model.mix.filter((input) => input !== replaced),
				];
			}
		}
		model.asrc = id;
	};
	const applyEdit = ({ id, include, track, ...values }: Delta) => {
		if (include === true && !model.mix.some((input) => input.id === id))
			model.mix = [...model.mix, entry(id)];
		if (include === false)
			model.mix = model.mix.filter((input) => input.id !== id);
		model.mix = model.mix.map((input) =>
			input.id !== id
				? input
				: {
						...input,
						...values,
						...(track === undefined
							? {}
							: {
									tracks: track.on
										? [...new Set([...input.tracks, track.number])].sort(
												(a, b) => a - b,
											)
										: input.tracks.filter((n) => n !== track.number),
								}),
					},
		);
	};
	expect(await save(model.mix)).toMatchObject({ success: true });
	// Both tabs keep the view they loaded and never hear back, like tabs whose answers are held.
	const stale = structuredClone(model.mix);
	const toggle = (id: string, n: number): Delta => ({
		id,
		track: {
			number: n,
			on: !(
				stale.find((input) => input.id === id)?.tracks.includes(n) ?? false
			),
		},
	});
	const steps: Array<[string, { pick: string } | Delta]> = [
		["tab A picks Second", { pick: "Second" }],
		["tab B, stale, sets Primary to -3 dB", { id: "Primary", gain_db: -3 }],
		["tab A picks Third", { pick: "Third" }],
		["tab B mutes Second", { id: "Second", mute: true }],
		["tab A puts Second on Track 2", toggle("Second", 2)],
		["tab B delays Third 120 ms", { id: "Third", delay_ms: 120 }],
		["tab A turns Fourth in", { id: "Fourth", include: true }],
		["tab B, stale, picks Fifth in the full mix", { pick: "Fifth" }],
		[
			"tab A takes Second off Track 1",
			{ id: "Second", track: { number: 1, on: false } },
		],
		["tab B turns Fourth out", { id: "Fourth", include: false }],
		["tab A puts Fifth on Track 3", toggle("Fifth", 3)],
		["tab B sets Second to -6 dB", { id: "Second", gain_db: -6 }],
	];
	for (const [label, step] of steps) {
		const result = "pick" in step ? await pick(step.pick) : await change(step);
		expect(result.success, label).toBe(true);
		if ("pick" in step) applyPick(step.pick);
		else applyEdit(step);
		const saved = await disk();
		expect(saved.audio_inputs, label).toEqual(model.mix);
		expect(saved.asrc, label).toBe(model.asrc);
	}
	// Both tabs send at once without waiting, each on a different input: every edit lands.
	const burst: Delta[] = [
		{ id: "Primary", mute: true },
		{ id: "Fifth", gain_db: -9 },
		toggle("Second", 3),
	];
	const results = await Promise.all(burst.map((delta) => change(delta)));
	expect(results.map((result) => result.success)).toEqual([true, true, true]);
	for (const delta of burst) applyEdit(delta);
	expect((await disk()).audio_inputs).toEqual(model.mix);
});

test("turning off the last other input clears the saved mix", async () => {
	expect(await save([entry("Primary"), entry("Second")])).toMatchObject({
		success: true,
	});
	expect(await change({ id: "Second", include: false })).toMatchObject({
		success: true,
		applies_next_start: true,
	});
	expect(await disk()).not.toHaveProperty("audio_inputs");
});

test("a level reset that leaves only the main input at its defaults clears the saved mix", async () => {
	expect(await save([{ ...entry("Primary"), gain_db: -6 }])).toMatchObject({
		success: true,
	});
	expect(await change({ id: "Primary", gain_db: 0 })).toMatchObject({
		success: true,
	});
	expect(await disk()).not.toHaveProperty("audio_inputs");
});

test("turning the main input out is refused and changes nothing", async () => {
	const saved = [entry("Primary"), entry("Second", [2])];
	expect(await save(saved)).toMatchObject({ success: true });
	expect(await change({ id: "Primary", include: false })).toEqual({
		success: false,
		error: "audio_input_primary",
	});
	expect((await disk()).audio_inputs).toEqual(saved);
});

test("turning an input in past max_inputs is refused and changes nothing", async () => {
	await maxInputs(2);
	const saved = [entry("Primary"), entry("Second", [2])];
	expect(await save(saved)).toMatchObject({ success: true });
	expect(await change({ id: "Third", include: true })).toEqual({
		success: false,
		error: "audio_inputs_too_many",
	});
	expect((await disk()).audio_inputs).toEqual(saved);
});

test("after a load whose saved mix lacks the main input, turning another input in keeps the main input first", async () => {
	expect(await save([entry("Primary"), entry("Second", [2])])).toMatchObject({
		success: true,
	});
	getConfig().asrc = "Third";
	expect(await change({ id: "Fourth", include: true })).toMatchObject({
		success: true,
	});
	expect((await disk()).audio_inputs).toEqual([
		entry("Third"),
		entry("Primary"),
		entry("Second", [2]),
		entry("Fourth"),
	]);
});
