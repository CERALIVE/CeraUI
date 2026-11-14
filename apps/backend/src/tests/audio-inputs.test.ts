import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { setMockAudioDevicesProvider } from "../modules/streaming/audio.ts";
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
	getIsStreaming,
	updateStatus,
} from "../modules/streaming/streaming.ts";
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
								schema_version: SCHEMA_VERSION,
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
