// Setter-contract for the streaming router (S3): every mutation procedure
// returns a contains-envelope — the result CONTAINS `{ success: boolean }`.
// The check is a contains-predicate, not rigid equality: domain-rich mutations
// (start / switchAudio / reloadAudioDelay) legitimately carry extra fields and
// are NOT forced into a `{ success, applied }` shape. setBitrate exposes the
// applied bitrate as `applied`; failure paths carry `error`, never `reason`.

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
} from "../../mocks/mock-service.ts";
import { injectMockStreamError } from "../../mocks/providers/streaming.ts";
import { getConfig } from "../../modules/config.ts";
import { updateStatus } from "../../modules/streaming/streaming.ts";
import {
	reloadAudioDelayProcedure,
	setBitrateProcedure,
	setConfigProcedure,
	setMockHardwareProcedure,
	streamingStartProcedure,
	streamingStopProcedure,
	switchAudioProcedure,
	switchInputProcedure,
} from "./streaming.procedure.ts";
import { appRouter } from "../router.ts";
import type { AppWebSocket, RPCContext } from "../types.ts";

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

// Drive each setter from a deterministic idle baseline so a prior `start` does
// not leak a streaming state into the next call.
function resetStreamingIdle(): void {
	setStreamingState(false);
	updateStatus(false);
}

async function callMutation(
	procedure: unknown,
	args: unknown,
): Promise<Record<string, unknown>> {
	const result = await call(
		procedure as typeof streamingStartProcedure,
		args as never,
		{ context: makeContext() },
	);
	return result as unknown as Record<string, unknown>;
}

// Every streaming MUTATION paired with a valid argument for it. The set must
// match the router's setter procedures exactly (enforced below).
const MUTATIONS: ReadonlyArray<{
	readonly name: string;
	readonly procedure: unknown;
	readonly args: unknown;
}> = [
	{ name: "start", procedure: streamingStartProcedure, args: {} },
	{ name: "stop", procedure: streamingStopProcedure, args: undefined },
	{ name: "setBitrate", procedure: setBitrateProcedure, args: { max_br: 5000 } },
	{ name: "setConfig", procedure: setConfigProcedure, args: { max_br: 5000 } },
	{
		name: "switchInput",
		procedure: switchInputProcedure,
		args: { input_id: "video0" },
	},
	{
		name: "switchAudio",
		procedure: switchAudioProcedure,
		args: { audio_input_id: "default" },
	},
	{
		name: "reloadAudioDelay",
		procedure: reloadAudioDelayProcedure,
		args: { delay_ms: 100 },
	},
	{
		name: "setMockHardware",
		procedure: setMockHardwareProcedure,
		args: { hardware: "generic" },
	},
];

// Read-only streaming procedures — excluded from the setter contract.
const STREAMING_QUERIES = new Set([
	"getPipelines",
	"getAudioCodecs",
	"getConfig",
	"streamHealth",
	"getEngine",
	"listDevices",
	"getMockHardware",
]);

describe("streaming setter-contract — contains-envelope (S3)", () => {
	let priorPipeline: string | undefined;
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;

	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService("streaming-active");
	});
	beforeEach(() => {
		// No persisted pipeline → the offered-set gate is skipped, so `start`
		// reaches the mock streaming branch.
		priorPipeline = getConfig().pipeline;
		getConfig().pipeline = undefined;
	});
	afterEach(() => {
		getConfig().pipeline = priorPipeline;
		resetStreamingIdle();
		resetMockState();
	});
	afterAll(() => {
		stopMockService();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	test("the mutation table covers exactly the streaming router's setters", () => {
		const routerMutations = Object.keys(appRouter.streaming)
			.filter((name) => !STREAMING_QUERIES.has(name))
			.sort();
		const tableMutations = MUTATIONS.map((m) => m.name).sort();
		expect(tableMutations).toEqual(routerMutations);
	});

	test("every streaming mutation result contains success: boolean", async () => {
		for (const mutation of MUTATIONS) {
			resetStreamingIdle();
			const result = await callMutation(mutation.procedure, mutation.args);
			expect(typeof result.success).toBe("boolean");
		}
	});

	test("setBitrate exposes the applied bitrate on success", async () => {
		resetStreamingIdle();
		const result = await callMutation(setBitrateProcedure, { max_br: 5000 });
		expect(result.success).toBe(true);
		expect(result).toHaveProperty("applied");
		expect(result.applied).toBe(5000);
	});

	test("a failed mutation carries an error and never a reason key", async () => {
		injectMockStreamError("srt_connect_failed");
		const result = await callMutation(streamingStartProcedure, {});
		expect(result.success).toBe(false);
		expect(result).not.toHaveProperty("reason");
		expect(result.error).toBeDefined();
	});

	test("domain-rich mutations carry success WITHOUT a forced applied field", async () => {
		resetStreamingIdle();
		const audio = await callMutation(switchAudioProcedure, {
			audio_input_id: "default",
		});
		expect(audio.success).toBe(true);
		expect(audio).not.toHaveProperty("applied");
		expect(audio).toHaveProperty("active_audio_input");

		const delay = await callMutation(reloadAudioDelayProcedure, {
			delay_ms: 100,
		});
		expect(delay.success).toBe(true);
		expect(delay).not.toHaveProperty("applied");
		expect(delay).toHaveProperty("delay_ms");
	});
});
