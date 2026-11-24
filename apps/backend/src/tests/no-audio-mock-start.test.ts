/**
 * The mock engine's Start honors the same order as the device's: an audio choice
 * saved while Start waits to be admitted is newer than the Start payload's own.
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
import { getMockLastStartParams } from "../mocks/providers/streaming.ts";
import {
	getConfig,
	getConfigFilePath,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
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
const context = () => ({ context: makeRpcContext() });

beforeEach(async () => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
	directory = await mkdtemp(join(tmpdir(), "no-audio-mock-"));
	previousPath = getConfigFilePath();
	previousConfig = structuredClone(getConfig());
	setConfigFilePath(join(directory, "config.json"));
	clearCapabilitiesCache();
	await initPipelines();
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
	await stop();
	jest.restoreAllMocks();
	setStreamingState(false);
	updateStatus(false);
	resetMockState();
	stopMockService();
	clearCapabilitiesCache();
	for (const key of Object.keys(getConfig()))
		Reflect.deleteProperty(getConfig(), key);
	Object.assign(getConfig(), previousConfig);
	setConfigFilePath(previousPath);
	if (savedMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMode;
	await rm(directory, { recursive: true, force: true });
});

async function startWithPickDuringAdmission(
	payload: string,
	saved: string,
	picked: string,
) {
	getConfig().asrc = saved;
	saveConfig();
	const reached = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const admission = spyOn(
		streamSessionProductionDeps,
		"admitUpdate",
	).mockImplementation(async () => {
		reached.resolve();
		await gate.promise;
		return { allowed: true };
	});
	const started = call(streamingStartProcedure, { asrc: payload }, context());
	await reached.promise;
	expect(
		await call(
			setConfigProcedure,
			{ asrc: picked, audio_pick: true },
			context(),
		),
	).toMatchObject({ success: true });
	gate.resolve();
	const result = await started;
	expect(result).toMatchObject({ success: true });
	expect(result.applied?.asrc).not.toBe(payload);
	admission.mockImplementation(async () => ({ allowed: true }));
}

async function nextStart() {
	await stop();
	expect(await call(streamingStartProcedure, {}, context())).toMatchObject({
		success: true,
	});
}

test.each(["Usb audio", "Elgato Wave:3", "No audio"])(
	"No audio saved during admission (%s saved before) beats an older microphone payload, now and at the next Start",
	async (saved) => {
		await startWithPickDuringAdmission("RØDE AI-Micro", saved, "No audio");
		expect(getMockLastStartParams()?.audio).toEqual({ mode: "none" });
		expect(buildInitialStatus().status.audio_off_active).toBe(true);
		expect(getConfig().asrc).toBe("No audio");
		await nextStart();
		expect(getMockLastStartParams()?.audio).toEqual({ mode: "none" });
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
