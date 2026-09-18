import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import { cerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import {
	changeEngineRuntimeConfig,
	setApplyNowGateForTest,
} from "../modules/streaming/config-change-bridge.ts";
import {
	clearStagedConfigChange,
	defaultStagingDeps,
	getStagedConfigChange,
	judgeInflightMarker,
} from "../modules/streaming/config-change-staging.ts";
import { setConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

const composition = {
	secondary_input_id: "camera-b",
	layout: "pip-top-right",
	alpha: 1,
} as const;
let dir: string;
let priorPath: string;
let priorComposition: ReturnType<typeof getConfig>["composition"];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "composition-disable-"));
	priorPath = getConfigFilePath();
	setConfigFilePath(join(dir, "config.json"));
	priorComposition = getConfig().composition;
	getConfig().composition = composition;
	spyOn(defaultStagingDeps, "writeMarker").mockImplementation(() => {});
	spyOn(defaultStagingDeps, "removeMarker").mockImplementation(() => {});
});
afterEach(async () => {
	setApplyNowGateForTest(null);
	clearStagedConfigChange();
	spyOn(defaultStagingDeps, "writeMarker").mockRestore();
	spyOn(defaultStagingDeps, "removeMarker").mockRestore();
	getConfig().composition = priorComposition;
	setConfigFilePath(priorPath);
	await rm(dir, { recursive: true, force: true });
});

test("live composition disable reaches the engine before config is cleared", async () => {
	const requests: unknown[] = [];
	const dispatch = spyOn(cerastreamBackend, "changeConfig").mockImplementation(
		async (params, clear) => {
			requests.push({ params, clear });
			expect(getConfig().composition).toEqual(composition);
			expect(getStagedConfigChange()?.candidate).toEqual({ composition: null });
			return {
				attempt_id: "engine-clear",
				phase: "applied",
				state: "streaming",
			};
		},
	);
	setApplyNowGateForTest({
		isStreamLive: () => true,
		dispatch: async (delta) => {
			const result = await changeEngineRuntimeConfig(delta, "clear");
			expect(result.phase).toBe("applied");
			return { result: "applied", attemptId: "clear" };
		},
	});
	try {
		const result = await call(
			setConfigProcedure,
			{ composition: null, apply_now: true },
			{ context: makeRpcContext() },
		);
		expect(requests).toEqual([{ params: {}, clear: true }]);
		expect(result.configChange?.result).toBe("applied");
		expect(result.applied?.composition).toBeNull();
		expect(getConfig().composition).toBeUndefined();
	} finally {
		dispatch.mockRestore();
	}
});

test("a refused live disable preserves the composed config", async () => {
	setApplyNowGateForTest({
		isStreamLive: () => true,
		dispatch: async () => ({
			result: "reverted",
			attemptId: "clear",
			reason: "change_rejected",
		}),
	});
	const result = await call(
		setConfigProcedure,
		{ composition: null, apply_now: true },
		{ context: makeRpcContext() },
	);
	expect(result.configChange?.result).toBe("reverted");
	expect(getConfig().composition).toEqual(composition);
	expect(result.applied?.composition).toBeUndefined();
});

test("deferred disable keeps the existing save-only contract", async () => {
	let calls = 0;
	setApplyNowGateForTest({
		isStreamLive: () => true,
		dispatch: async () => {
			calls += 1;
			return { result: "applied", attemptId: "unused" };
		},
	});
	await call(
		setConfigProcedure,
		{ composition: null },
		{ context: makeRpcContext() },
	);
	expect(calls).toBe(0);
	expect(getConfig().composition).toBeUndefined();
});

test("geometry alone cannot falsely confirm a composition-clear crash marker", () => {
	const marker = {
		attemptId: "clear",
		startedAt: 1,
		candidate: { composition: null },
		previous: { composition },
	};
	const engine = { streaming: true, pipelinePlaying: true, framesEmitted: 20 };
	expect(judgeInflightMarker(marker, engine)).toEqual({ action: "wait" });
	expect(judgeInflightMarker(marker, { ...engine, switching: true })).toEqual({
		action: "persist_candidate",
	});
});
