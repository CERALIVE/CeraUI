import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
} from "bun:test";

import { call } from "@orpc/server";
import { logger } from "../helpers/logger.ts";
import { getConfig } from "../modules/config.ts";
import {
	getPipelineMigrationState,
	isPersistedPipelineUnavailable,
	PIPELINE_NOT_IN_OFFERED_SET,
	reconcilePersistedPipeline,
	resetPipelineMigrationStateForTest,
	validatePersistedPipeline,
} from "../modules/streaming/config-migration.ts";
import {
	getPipelineList,
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import { streamingStartProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// generic hardware offers: camlink, v4l_mjpeg, test — and notably NOT
// libuvch264, which makes it the migration discriminator for these tests.
const OFFERED_PIPELINE = "test";
const RETIRED_PIPELINE = "libuvch264";

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

describe("validatePersistedPipeline (pure)", () => {
	it("accepts a pipeline that is in the offered set", () => {
		expect(validatePersistedPipeline("test", ["camlink", "test"])).toEqual({
			valid: true,
		});
	});

	it("rejects a pipeline that is absent, naming the offending id", () => {
		expect(
			validatePersistedPipeline(RETIRED_PIPELINE, ["camlink", "test"]),
		).toEqual({
			valid: false,
			error: PIPELINE_NOT_IN_OFFERED_SET,
			pipeline: RETIRED_PIPELINE,
		});
	});
});

describe("reconcilePersistedPipeline (boot)", () => {
	afterEach(() => {
		resetPipelineMigrationStateForTest();
	});

	it("marks unavailable and warns when the persisted pipeline is gone", () => {
		const warnSpy = spyOn(logger, "warn");
		try {
			const result = reconcilePersistedPipeline(RETIRED_PIPELINE, [
				"camlink",
				"test",
			]);

			expect(result.valid).toBe(false);
			expect(getPipelineMigrationState()).toBe("unavailable");
			expect(isPersistedPipelineUnavailable()).toBe(true);
			expect(warnSpy).toHaveBeenCalledWith(
				`[config-migration] pipeline '${RETIRED_PIPELINE}' not in offered set`,
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("leaves state available and emits no warning for an offered pipeline", () => {
		const warnSpy = spyOn(logger, "warn");
		try {
			const result = reconcilePersistedPipeline(OFFERED_PIPELINE, [
				"camlink",
				"test",
			]);

			expect(result.valid).toBe(true);
			expect(getPipelineMigrationState()).toBe("available");
			expect(isPersistedPipelineUnavailable()).toBe(false);
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("never warns or blocks on a fresh device with no persisted pipeline", () => {
		const warnSpy = spyOn(logger, "warn");
		try {
			const result = reconcilePersistedPipeline(undefined, ["camlink", "test"]);

			expect(result.valid).toBe(true);
			expect(getPipelineMigrationState()).toBe("available");
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe("streaming.start — persisted pipeline vs offered set", () => {
	let priorPipeline: string | undefined;

	beforeEach(() => {
		setMockHardware("generic");
		initPipelines();
		priorPipeline = getConfig().pipeline;
		resetPipelineMigrationStateForTest();
	});

	afterEach(() => {
		getConfig().pipeline = priorPipeline;
		resetPipelineMigrationStateForTest();
	});

	afterAll(() => {
		setMockHardware("rk3588");
		initPipelines();
	});

	it("offered set really lacks the retired pipeline on this hardware", () => {
		const offered = Object.keys(getPipelineList());
		expect(offered).toContain(OFFERED_PIPELINE);
		expect(offered).not.toContain(RETIRED_PIPELINE);
	});

	it("blocks start with a structured error when the persisted pipeline is retired", async () => {
		getConfig().pipeline = RETIRED_PIPELINE;

		const result = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);

		expect(result.success).toBe(false);
		expect(result.is_streaming).toBe(false);
		expect(result.error).toBe(PIPELINE_NOT_IN_OFFERED_SET);
	});

	it("does not block start when the persisted pipeline is offered", async () => {
		getConfig().pipeline = OFFERED_PIPELINE;

		const result = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);

		expect(result.error).not.toBe(PIPELINE_NOT_IN_OFFERED_SET);
	});

	it("blocks start when a retired pipeline is passed in the start input", async () => {
		getConfig().pipeline = OFFERED_PIPELINE;

		const result = await call(
			streamingStartProcedure,
			{ pipeline: RETIRED_PIPELINE },
			{ context: makeContext() },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe(PIPELINE_NOT_IN_OFFERED_SET);
	});
});
