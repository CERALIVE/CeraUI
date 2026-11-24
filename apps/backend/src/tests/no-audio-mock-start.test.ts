/**
 * The mock engine's Start follows the device's rule: it uses the audio configuration
 * it was pressed with, and a choice saved while it is in flight is the next Start's.
 */
import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import {
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	getMockAudioDevices,
	getMockEngineCapabilities,
	getMockLastStartParams,
} from "../mocks/providers/streaming.ts";
import {
	getConfig,
	getConfigFilePath,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import { setMockAudioDevicesProvider } from "../modules/streaming/audio.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import { initPipelines } from "../modules/streaming/pipelines.ts";
import { noteStreamSessionEngineStatus } from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import {
	setConfigProcedure,
	streamingStartProcedure,
	streamingStopProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

const savedMode = process.env.MOCK_MODE;
let directory: string;
let previousPath: string;
let previousConfig: ReturnType<typeof getConfig>;
let reached = Promise.withResolvers<void>();
let gate = Promise.withResolvers<void>();
const context = () => ({ context: makeRpcContext() });

beforeEach(async () => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
	directory = await mkdtemp(join(tmpdir(), "no-audio-mock-"));
	previousPath = getConfigFilePath();
	previousConfig = structuredClone(getConfig());
	setConfigFilePath(join(directory, "config.json"));
	setMockAudioDevicesProvider(getMockAudioDevices);
	clearCapabilitiesCache();
	await initPipelines({
		fetchEngineCapabilities: async () => getMockEngineCapabilities(),
	});
	reached = Promise.withResolvers<void>();
	gate = Promise.withResolvers<void>();
	for (const key of Object.keys(getConfig()))
		Reflect.deleteProperty(getConfig(), key);
	Object.assign(getConfig(), { pipeline: "test", max_br: 8000 });
});

async function stop() {
	noteStreamSessionEngineStatus({
		type: "status",
		seq: 1,
		state: "idle",
		streaming: false,
	});
	await call(streamingStopProcedure, undefined, context());
}

afterEach(async () => {
	gate.resolve();
	await stop();
	jest.restoreAllMocks();
	setStreamingState(false);
	updateStatus(false);
	resetMockState();
	stopMockService();
	setMockAudioDevicesProvider(undefined);
	clearCapabilitiesCache();
	for (const key of Object.keys(getConfig()))
		Reflect.deleteProperty(getConfig(), key);
	Object.assign(getConfig(), previousConfig);
	setConfigFilePath(previousPath);
	if (savedMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMode;
	await rm(directory, { recursive: true, force: true });
});

const pickedInput = {
	id: "RØDE AI-Micro",
	tracks: [1],
	gain_db: -6,
	mute: false,
	delay_ms: 0,
};

async function startWithSaveDuringAdmission(
	payload: { asrc: string },
	saved: string,
	save: Parameters<typeof call<typeof setConfigProcedure>>[1],
) {
	getConfig().asrc = saved;
	saveConfig();
	const admission = spyOn(
		streamSessionProductionDeps,
		"admitUpdate",
	).mockImplementation(async () => {
		reached.resolve();
		await gate.promise;
		return { allowed: true };
	});
	const started = call(streamingStartProcedure, payload, context());
	await reached.promise;
	expect(await call(setConfigProcedure, save, context())).toMatchObject({
		success: true,
	});
	gate.resolve();
	const result = await started;
	expect(result).toMatchObject({ success: true });
	expect(result.applied?.asrc).toBe(payload.asrc);
	admission.mockImplementation(async () => ({ allowed: true }));
}
const startWithPickDuringAdmission = (
	payload: string,
	saved: string,
	picked: string,
) =>
	startWithSaveDuringAdmission({ asrc: payload }, saved, {
		asrc: picked,
		audio_pick: true,
	});

async function nextStart() {
	await stop();
	expect(await call(streamingStartProcedure, {}, context())).toMatchObject({
		success: true,
	});
}

test.each(["Usb audio", "Elgato Wave:3", "No audio"])(
	"No audio saved during admission (%s saved before) leaves a microphone Start as pressed and starts next time",
	async (saved) => {
		await startWithPickDuringAdmission("RØDE AI-Micro", saved, "No audio");
		expect(getMockLastStartParams()?.audio).toMatchObject({ mode: "device" });
		expect(buildInitialStatus().status.audio_off_active).toBe(false);
		expect(getConfig().asrc).toBe("No audio");
		await nextStart();
		expect(getMockLastStartParams()?.audio).toEqual({ mode: "none" });
	},
);

test.each([
	["a mix", { audio_inputs: [pickedInput] }],
	["Auto", { asrc: "Auto", audio_pick: true }],
] as const)(
	"%s saved during admission is not part of a microphone Start",
	async (_name, later) => {
		await startWithSaveDuringAdmission(
			{ asrc: "RØDE AI-Micro" },
			"RØDE AI-Micro",
			later,
		);
		expect(getMockLastStartParams()?.audio).toMatchObject({ mode: "device" });
		expect(getMockLastStartParams()?.audio?.inputs).toBeUndefined();
		expect(getConfig()).toMatchObject(
			"audio_pick" in later ? { asrc: "Auto" } : later,
		);
	},
);

test.each(["Elgato Wave:3", "RØDE AI-Micro", "No audio"])(
	"a microphone saved during admission (%s saved before) leaves an older No audio payload silent and starts next time",
	async (saved) => {
		await startWithPickDuringAdmission("No audio", saved, "RØDE AI-Micro");
		expect(getMockLastStartParams()?.audio).toEqual({ mode: "none" });
		expect(buildInitialStatus().status.audio_off_active).toBe(true);
		expect(getConfig().asrc).toBe("RØDE AI-Micro");
		await nextStart();
		expect(getMockLastStartParams()?.audio?.mode).not.toBe("none");
		expect(buildInitialStatus().status.audio_off_active).toBe(false);
	},
);
