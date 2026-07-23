import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";

import { call } from "@orpc/server";
import {
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { injectMockStreamError } from "../mocks/providers/streaming.ts";
import { getConfig } from "../modules/config.ts";
import { mapCerastreamError } from "../modules/streaming/cerastream-error-mapping.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { streamingStartProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

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

describe("streaming.start — structured failure error code (Task 16)", () => {
	let priorPipeline: string | undefined;
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;

	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService("streaming-active");
	});
	beforeEach(() => {
		// No persisted pipeline → the offered-set gate is skipped, so the start
		// reaches the mock streaming branch this suite exercises.
		priorPipeline = getConfig().pipeline;
		getConfig().pipeline = undefined;
	});
	afterEach(() => {
		getConfig().pipeline = priorPipeline;
		// The success-path start flips the streaming module's global on; clear it
		// so getIsStreaming() does not leak `true` into later files' prod tests.
		setStreamingState(false);
		updateStatus(false);
		resetMockState();
	});
	afterAll(() => {
		stopMockService();
		// Restore env so MOCK_MODE does not leak shouldUseMocks()/isDevelopment()
		// into prod-path tests in later files of the same bun-test process.
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	test("an injected Tier-2 error makes start fail with its structured error code", async () => {
		injectMockStreamError("srt_connect_failed");

		const result = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);

		expect(result).toMatchObject({
			success: false,
			is_streaming: false,
			error: "srt_connect_failed",
			result: "failed",
		});
		expect(result.attemptId).toMatch(/^att_/);
		if ("failure" in result) {
			expect(result.failure?.attemptId).toBe(result.attemptId);
		}
	});

	test("the success path is unchanged — no error field on a clean start", async () => {
		const result = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result).not.toHaveProperty("error");
		expect(result.applied).toBeDefined();
	});

	test("floors a sub-2s srt_latency in the applied echo (T2)", async () => {
		const result = await call(
			streamingStartProcedure,
			{ srt_latency: 100 },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.srt_latency).toBe(2000);
	});

	test("leaves an at/above-floor srt_latency untouched in the applied echo", async () => {
		const result = await call(
			streamingStartProcedure,
			{ srt_latency: 3000 },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.srt_latency).toBe(3000);
	});

	test("the injected error is one-shot — a retried start succeeds", async () => {
		injectMockStreamError("srtla_no_connections");

		const failed = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);
		expect(failed).toMatchObject({
			success: false,
			is_streaming: false,
			error: "srtla_no_connections",
			result: "failed",
		});

		const retried = await call(
			streamingStartProcedure,
			{},
			{ context: makeContext() },
		);
		expect(retried.success).toBe(true);
		expect(retried).not.toHaveProperty("error");
	});
});

describe("mapCerastreamError (pure)", () => {
	test("returns the code for a RuntimeErrorEvent-shaped value", () => {
		expect(
			mapCerastreamError({
				type: "error",
				code: "pipeline_stall",
				source: "engine",
			}),
		).toBe("pipeline_stall");
	});

	test("returns undefined for an unstructured failure", () => {
		expect(mapCerastreamError(new Error("boom"))).toBeUndefined();
		expect(mapCerastreamError("just a string")).toBeUndefined();
		expect(mapCerastreamError({ code: "not_a_tier2_code" })).toBeUndefined();
		expect(mapCerastreamError(undefined)).toBeUndefined();
	});
});
