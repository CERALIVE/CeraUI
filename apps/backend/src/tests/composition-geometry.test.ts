/**
 * Free placement of the second picture input (`composition.rect`).
 *
 * The device decides the composition a placement writes: a `composition_rect`
 * delta is composed on the composition the device has saved at that moment, in
 * the same synchronous write, so quick placements and a stale second tab
 * compose with every other change instead of overwriting it. A rectangle is
 * accepted only with the `custom` layout, only when the engine advertises
 * `composition-geometry`, and only when it fits the frame.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChangeConfigParams,
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type { StreamingSetConfigInput } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import { cerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import {
	changeEngineRuntimeConfig,
	setApplyNowGateForTest,
} from "../modules/streaming/config-change-bridge.ts";
import {
	clearStagedConfigChange,
	defaultStagingDeps,
} from "../modules/streaming/config-change-staging.ts";
import { initPipelines } from "../modules/streaming/pipelines.ts";
import { setConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
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
const GEOMETRY = ["composition", "composition-geometry"];

const SAVED = {
	secondary_input_id: "camera-b",
	layout: "pip-top-right",
	alpha: 0.4,
} as const;
const PLACED = { x: 0.05, y: 0.45, width: 0.5, height: 0.5 };
const placedAt = (rect: typeof PLACED) =>
	({ ...SAVED, layout: "custom", rect }) as const;

let directory: string;
let previousPath: string;
let previousConfig: ReturnType<typeof getConfig>;

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

const save = (input: StreamingSetConfigInput) =>
	call(setConfigProcedure, input, { context: makeRpcContext() });
const disk = async () =>
	(await Bun.file(getConfigFilePath()).exists())
		? ((await Bun.file(getConfigFilePath()).json()) as Record<string, unknown>)
		: {};

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "composition-geometry-"));
	previousPath = getConfigFilePath();
	previousConfig = structuredClone(getConfig());
	setConfigFilePath(join(directory, "config.json"));
	getConfig().composition = { ...SAVED };
	spyOn(defaultStagingDeps, "writeMarker").mockImplementation(() => {});
	spyOn(defaultStagingDeps, "removeMarker").mockImplementation(() => {});
	await engineFeatures(GEOMETRY);
});

afterEach(async () => {
	setApplyNowGateForTest(null);
	clearStagedConfigChange();
	spyOn(defaultStagingDeps, "writeMarker").mockRestore();
	spyOn(defaultStagingDeps, "removeMarker").mockRestore();
	clearCapabilitiesCache();
	for (const key of Object.keys(getConfig()))
		Reflect.deleteProperty(getConfig(), key);
	Object.assign(getConfig(), previousConfig);
	setConfigFilePath(previousPath);
	await rm(directory, { recursive: true, force: true });
});

test("a rectangle without the composition-geometry capability is refused before anything is written", async () => {
	await engineFeatures(["composition"]);
	for (const input of [
		{ composition_rect: PLACED },
		{ composition: { ...SAVED, layout: "custom", rect: PLACED } },
		{ composition: { ...SAVED, layout: "custom" } },
	] satisfies StreamingSetConfigInput[]) {
		expect(await save(input)).toMatchObject({
			success: false,
			error: "composition_geometry_unsupported",
		});
	}
	expect(getConfig().composition).toEqual(SAVED);
	expect(await disk()).toEqual({});
});

test("a placement is composed on the device's own saved composition", async () => {
	const result = await save({ composition_rect: PLACED });
	const placed = placedAt(PLACED);
	expect(result).toMatchObject({
		success: true,
		applied: { composition: placed },
	});
	expect(getConfig().composition).toEqual(placed);
	expect((await disk()).composition).toEqual(placed);
});

test("quick placements and a stale second tab compose with the device's newer saved values", async () => {
	await save({ composition_rect: PLACED });
	// Another tab changes the opacity and the second input after this one last heard the config.
	await save({
		composition: {
			secondary_input_id: "camera-c",
			layout: "custom",
			alpha: 0.9,
		},
	});
	// The stale tab's next placement, then a quicker one right behind it.
	await save({ composition_rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } });
	await save({ composition_rect: { x: 0.6, y: 0.6, width: 0.4, height: 0.4 } });
	expect(getConfig().composition).toEqual({
		secondary_input_id: "camera-c",
		layout: "custom",
		alpha: 0.9,
		rect: { x: 0.6, y: 0.6, width: 0.4, height: 0.4 },
	});
});

test("a custom write without a rectangle keeps the one the device saved", async () => {
	await save({ composition_rect: PLACED });
	const result = await save({
		composition: { secondary_input_id: "camera-b", layout: "custom", alpha: 1 },
	});
	expect(result).toMatchObject({
		success: true,
		applied: {
			composition: {
				secondary_input_id: "camera-b",
				layout: "custom",
				alpha: 1,
				rect: PLACED,
			},
		},
	});
});

test("a preset drops the saved rectangle", async () => {
	await save({ composition_rect: PLACED });
	await save({ composition: { ...SAVED, layout: "pbp-left-right" } });
	expect(getConfig().composition).toEqual({
		...SAVED,
		layout: "pbp-left-right",
	});
});

test("a rectangle the engine would refuse is refused with its own token and nothing is written", async () => {
	for (const input of [
		{ composition_rect: { x: 0.6, y: 0, width: 0.5, height: 0.5 } },
		{ composition_rect: { x: 0, y: 0, width: 0.1, height: 0.5 } },
		{ composition: { ...SAVED, rect: PLACED } },
		{ composition: { ...SAVED, layout: "custom" } },
	] satisfies StreamingSetConfigInput[]) {
		expect(await save(input)).toMatchObject({
			success: false,
			error: "composition_rect_invalid",
		});
	}
	getConfig().composition = undefined;
	expect(await save({ composition_rect: PLACED })).toMatchObject({
		success: false,
		error: "composition_rect_invalid",
	});
	expect(await disk()).toEqual({});
});

test("without the composition feature a placement is refused as composition_unsupported", async () => {
	await engineFeatures([]);
	expect(await save({ composition_rect: PLACED })).toMatchObject({
		success: false,
		error: "composition_unsupported",
	});
	expect(getConfig().composition).toEqual(SAVED);
});

test("live, a placement is one apply-now change carrying the composed rectangle to the engine", async () => {
	const sent: ChangeConfigParams[] = [];
	const dispatch = spyOn(cerastreamBackend, "changeConfig").mockImplementation(
		async (params) => {
			sent.push(params);
			expect(getConfig().composition).toEqual(SAVED);
			return {
				attempt_id: "engine-place",
				phase: "applied",
				state: "streaming",
			};
		},
	);
	setApplyNowGateForTest({
		isStreamLive: () => true,
		dispatch: async (delta) => {
			const outcome = await changeEngineRuntimeConfig(delta, "place");
			return {
				result: outcome.phase === "applied" ? "applied" : "reverted",
				attemptId: "place",
			};
		},
	});
	try {
		const result = await save({ composition_rect: PLACED, apply_now: true });
		const placed = placedAt(PLACED);
		expect(sent).toEqual([{ composition: placed }]);
		expect(result).toMatchObject({
			success: true,
			applied: { composition: placed },
			configChange: { result: "applied" },
		});
		expect(getConfig().composition).toEqual(placed);
	} finally {
		dispatch.mockRestore();
	}
});

test("live, a refused placement leaves the running composition saved", async () => {
	setApplyNowGateForTest({
		isStreamLive: () => true,
		dispatch: async () => ({
			result: "reverted",
			attemptId: "place",
			reason: "change_rejected",
		}),
	});
	const result = await save({ composition_rect: PLACED, apply_now: true });
	expect(result.configChange?.result).toBe("reverted");
	expect(getConfig().composition).toEqual(SAVED);
});
