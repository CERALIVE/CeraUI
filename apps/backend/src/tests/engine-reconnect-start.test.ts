import { describe, expect, test } from "bun:test";
import {
	StreamStartFailure,
	typedStartFailure,
} from "../modules/streaming/start-failure-taxonomy.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { PREVIEW_ENCODE_REPLAY_FAILED } from "../modules/streaming/streamloop/start-stream.ts";

// A start that cannot reach the engine is the only evidence of an engine that
// went away while no session held a connection. The hook sits where every
// start origin's failure is classified, so it also covers starts that fail
// before the engine backend is ever asked (the preview-encoder replay).

function orchestratorWith(onEngineUnavailable: () => void) {
	let next = 0;
	return createStreamSessionOrchestrator({
		createAttemptId: () => `attempt-${++next}`,
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		retryPolicy: {
			maxAttempts: 1,
			totalBudgetMs: 60_000,
			baseDelayMs: 2_000,
			maxDelayMs: 16_000,
		},
		onEngineUnavailable,
	});
}

describe("a start that cannot reach the engine re-arms the engine reconnect", () => {
	test("the preview-encoder replay finding the engine gone is reported", async () => {
		let reported = 0;
		const orchestrator = orchestratorWith(() => {
			reported += 1;
		});
		// The shape every origin builds from start-stream's early return.
		const result = await orchestrator.start({
			origin: "ui",
			launch: async ({ attemptId }) => {
				throw new StreamStartFailure(
					typedStartFailure(
						attemptId,
						"connect",
						"engine_unavailable",
						PREVIEW_ENCODE_REPLAY_FAILED,
					),
				);
			},
		});
		expect(result.result).toBe("failed");
		expect(reported).toBe(1);
	});

	test("an engine that answers and refuses the start is not reported", async () => {
		let reported = 0;
		const orchestrator = orchestratorWith(() => {
			reported += 1;
		});
		await orchestrator.start({
			origin: "ui",
			launch: async ({ attemptId }) => {
				throw new StreamStartFailure(
					typedStartFailure(
						attemptId,
						"start-rpc",
						"engine_internal",
						"transport connect failed",
					),
				);
			},
		});
		expect(reported).toBe(0);
	});

	test("an operator Stop that closes a pending start is not reported", async () => {
		let reported = 0;
		const orchestrator = orchestratorWith(() => {
			reported += 1;
		});
		const entered = Promise.withResolvers<void>();
		const pending = Promise.withResolvers<void>();
		const start = orchestrator.start({
			origin: "ui",
			launch: async ({ attemptId }) => {
				entered.resolve();
				await pending.promise;
				// Our own Stop closed the start's connection under it.
				throw new StreamStartFailure(
					typedStartFailure(attemptId, "connect", "engine_unavailable"),
				);
			},
		});
		await entered.promise;
		const stop = orchestrator.stop("operator");
		pending.resolve();
		const result = await start;
		await stop;
		expect(result.result).toBe("cancelled");
		expect(reported).toBe(0);
	});

	test("a throwing hook does not change the start's outcome", async () => {
		const orchestrator = orchestratorWith(() => {
			throw new Error("reconnect bookkeeping failed (test)");
		});
		const result = await orchestrator.start({
			origin: "ui",
			launch: async ({ attemptId }) => {
				throw new StreamStartFailure(
					typedStartFailure(attemptId, "connect", "engine_unavailable"),
				);
			},
		});
		expect(result.result).toBe("failed");
	});
});
