/**
 * Under mocks, Start hands the mock engine the composition the device saved,
 * the way the engine adapter hands it to cerastream at a real start (after
 * `validateConfig` drops one the engine does not advertise), so what the mock
 * engine runs can be read back and compared with what is saved.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type { CompositionConfig } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	getMockState,
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { getMockEngineDevices } from "../mocks/providers/streaming.ts";
import { getConfig } from "../modules/config.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import { initPipelines } from "../modules/streaming/pipelines.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { streamingStartProcedure } from "../rpc/procedures/streaming.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

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
	sources: [],
};

const savedMode = process.env.MOCK_MODE;
let previousComposition: CompositionConfig | undefined;

async function engineFeatures(features: string[]): Promise<void> {
	clearCapabilitiesCache();
	await initPipelines({
		fetchEngineCapabilities: async () => ({
			caps: { ...CAPS, features },
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
}

/** A custom placement of a second capture the mock engine has. */
function savedPlacement(): CompositionConfig {
	const videos = getMockEngineDevices().devices.filter(
		(device) => device.media_class === "video",
	);
	const second = videos[1]?.input_id;
	if (second === undefined) throw new Error("the mock has one capture");
	return {
		secondary_input_id: second,
		layout: "custom",
		alpha: 0.7,
		rect: { x: 0.05, y: 0.45, width: 0.35, height: 0.35 },
	};
}

const start = () =>
	call(streamingStartProcedure, {}, { context: makeRpcContext() });

beforeEach(() => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
	previousComposition = getConfig().composition;
});

afterEach(() => {
	setStreamingState(false);
	updateStatus(false);
	resetMockState();
	stopMockService();
	clearCapabilitiesCache();
	getConfig().composition = previousComposition;
	if (savedMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMode;
});

test("Start runs the composition the device saved, a custom rectangle included", async () => {
	await engineFeatures(["composition", "composition-geometry"]);
	const saved = savedPlacement();
	getConfig().composition = saved;

	expect(await start()).toMatchObject({ success: true });
	expect(getMockState().engineStart?.composition).toEqual(saved);
	expect(getMockState().engineStart?.composition).toEqual(
		getConfig().composition,
	);
});

test("Start without a saved composition leaves the engine without one, as before", async () => {
	await engineFeatures(["composition", "composition-geometry"]);
	getConfig().composition = undefined;

	expect(await start()).toMatchObject({ success: true });
	expect(getMockState().engineStart).not.toBeNull();
	expect(getMockState().engineStart).not.toHaveProperty("composition");
});

test("a composition saved for an engine that does not advertise composition does not reach it, as at a real start", async () => {
	await engineFeatures([]);
	getConfig().composition = savedPlacement();

	expect(await start()).toMatchObject({ success: true });
	expect(getMockState().engineStart).not.toBeNull();
	expect(getMockState().engineStart).not.toHaveProperty("composition");
});
