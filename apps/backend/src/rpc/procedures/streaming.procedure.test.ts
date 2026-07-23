import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";

import { call } from "@orpc/server";

import { getConfig } from "../../modules/config.ts";
import { updateStatus } from "../../modules/streaming/streaming.ts";
import * as streamloop from "../../modules/streaming/streamloop.ts";
import type { AppWebSocket, RPCContext } from "../types.ts";

const STREAMLOOP_PATH = "../../modules/streaming/streamloop.ts";

// Snapshot the real barrel so afterAll can restore it — later suites in the same
// `bun test` process drive the real launch and must not inherit our spy.
const realStreamloop = { ...streamloop };

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

// The launch performs two effects we count separately to prove the guard stops a
// double: srtla_send spawn (start-stream.ts spawnStreamingLoop) and the engine
// IPC start (start-stream.ts getStreamingBackend().start). The mocked `start`
// stands in for that launch and parks on a gate so a second call overlaps it.
const spawnSpy = mock(() => {});
const engineStartSpy = mock(() => {});
let releaseStart: () => void = () => {};

const startSpy = mock(async () => {
	spawnSpy();
	engineStartSpy();
	await new Promise<void>((resolve) => {
		releaseStart = resolve;
	});
	return { success: true as const };
});

let streamingStartProcedure: Awaited<
	typeof import("./streaming.procedure.ts")
>["streamingStartProcedure"];
let streamingStopProcedure: Awaited<
	typeof import("./streaming.procedure.ts")
>["streamingStopProcedure"];

describe("streaming.start — in-flight re-entry guard (S5)", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;
	let priorPipeline: string | undefined;

	beforeAll(async () => {
		// Force the real (non-mock) launch path: shouldUseMocks() needs
		// isDevelopment(), which we disable so the handler reaches startStream.
		delete process.env.MOCK_MODE;
		process.env.NODE_ENV = "test";

		mock.module(STREAMLOOP_PATH, () => ({
			...realStreamloop,
			start: startSpy,
			stop: () => {},
		}));

		({ streamingStartProcedure, streamingStopProcedure } = await import(
			"./streaming.procedure.ts"
		));
	});

	afterAll(() => {
		mock.module(STREAMLOOP_PATH, () => ({ ...realStreamloop }));
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	beforeEach(() => {
		updateStatus(false);
		// No persisted pipeline → the offered-set gate is skipped so start reaches
		// the launch path.
		priorPipeline = getConfig().pipeline;
		getConfig().pipeline = undefined;
		spawnSpy.mockClear();
		engineStartSpy.mockClear();
		startSpy.mockClear();
		releaseStart = () => {};
	});

	afterEach(() => {
		getConfig().pipeline = priorPipeline;
		releaseStart();
	});

	test("two overlapping starts spawn srtla_send once and start the engine once; the second returns busy", async () => {
		const context = makeContext();

		// First start: left in-flight (the mocked launch parks on its gate).
		const first = call(streamingStartProcedure, {}, { context });

		// Drain the microtask queue so the first call reaches the parked await and
		// has set the in-flight flag before the second call arrives.
		await new Promise((resolve) => setTimeout(resolve, 0));

		const second = await call(streamingStartProcedure, {}, { context });
		expect(second.success).toBe(false);
		expect(second.error).toBe("START_IN_PROGRESS");

		// The guard let the launch run exactly once: one spawn, one engine start.
		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(engineStartSpy).toHaveBeenCalledTimes(1);
		expect(startSpy).toHaveBeenCalledTimes(1);

		releaseStart();
		const firstResult = await first;
		expect(firstResult.success).toBe(true);

		// Still exactly one spawn + one engine start after the first resolves.
		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(engineStartSpy).toHaveBeenCalledTimes(1);
	});

	test("the guard releases after a start completes so a later start runs again", async () => {
		const context = makeContext();

		const first = call(streamingStartProcedure, {}, { context });
		await new Promise((resolve) => setTimeout(resolve, 0));
		releaseStart();
		await first;
		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(
			await call(streamingStopProcedure, undefined, { context }),
		).toMatchObject({ result: "stopped" });

		const second = call(streamingStartProcedure, {}, { context });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(spawnSpy).toHaveBeenCalledTimes(2);
		expect(engineStartSpy).toHaveBeenCalledTimes(2);
		releaseStart();
		await second;
	});
});
