import { describe, expect, test } from "bun:test";

import {
	createStreamSessionOrchestrator,
	type StreamLaunchContext,
} from "../modules/streaming/stream-session-orchestrator.ts";
import { StreamStartFailure } from "../modules/streaming/start-failure-taxonomy.ts";

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: () => resolvePromise?.(),
	};
}

function attemptIds(): () => string {
	let next = 0;
	return () => `attempt-${++next}`;
}

describe("stream session orchestrator", () => {
	test("characterizes merged one-shot behavior for a retriable connect failure", async () => {
		// Given merged Todo 27 behavior and a connect-phase engine outage.
		let launches = 0;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
		});

		// When the only launch attempt reports a retriable typed failure.
		const result = await orchestrator.start({
			origin: "ui",
			launch: async ({ attemptId }) => {
				launches += 1;
				throw new StreamStartFailure({
					attemptId,
					phase: "connect",
					class: "engine_unavailable",
					retriable: true,
				});
			},
		});

		// Then the merged baseline is one-shot and immediately terminal.
		expect(launches).toBe(1);
		expect(result).toEqual({
			result: "failed",
			attemptId: "attempt-1",
			failure: {
				attemptId: "attempt-1",
				phase: "connect",
				class: "engine_unavailable",
				retriable: true,
			},
		});
	});

	test("parallel starts launch once and return one busy result", async () => {
		// Given a first launch held at a deterministic engine barrier.
		const engineConfirmed = deferred();
		let launches = 0;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
		});
		const launch = async (_context: StreamLaunchContext) => {
			launches += 1;
			await engineConfirmed.promise;
		};

		// When UI and autostart enter concurrently.
		const uiStart = orchestrator.start({ origin: "ui", launch });
		const autostart = await orchestrator.start({ origin: "autostart", launch });
		engineConfirmed.resolve();
		const uiResult = await uiStart;

		// Then exactly one engine launch occurs and the loser is typed busy.
		expect(launches).toBe(1);
		expect(uiResult).toEqual({ result: "started", attemptId: "attempt-1" });
		expect(autostart).toEqual({ result: "busy", attemptId: "attempt-2" });
	});

	test("stop during start cancels the attempt and cleans a late completion", async () => {
		// Given an engine start that can complete only after stop has run.
		const engineConfirmed = deferred();
		let engineStreaming = false;
		const stoppedGenerations: number[] = [];
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async (generation) => {
				stoppedGenerations.push(generation);
				engineStreaming = false;
			},
			queryRuntime: async () => (engineStreaming ? "streaming" : "idle"),
		});
		const start = orchestrator.start({
			origin: "ui",
			launch: async () => {
				await engineConfirmed.promise;
				engineStreaming = true;
			},
		});

		// When stop races the in-flight launch and the old launch completes late.
		const stopResult = await orchestrator.stop();
		engineConfirmed.resolve();
		const startResult = await start;

		// Then cancellation is explicit and generation cleanup leaves no stream.
		expect(stopResult).toEqual({ result: "stopped" });
		expect(startResult).toEqual({
			result: "cancelled",
			attemptId: "attempt-1",
		});
		expect(stoppedGenerations).toEqual([1, 1]);
		expect(engineStreaming).toBe(false);
		expect(orchestrator.snapshot().state).toBe("idle");
	});

	test("stop after a confirmed start returns the session to idle", async () => {
		// Given a generation that has reached the confirmed streaming state.
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
		});
		expect(
			await orchestrator.start({ origin: "ui", launch: async () => {} }),
		).toMatchObject({ result: "started" });

		// When the confirmed stream is stopped.
		const result = await orchestrator.stop();

		// Then no late start completion is required to settle the lifecycle.
		expect(result).toEqual({ result: "stopped" });
		expect(orchestrator.snapshot().state).toBe("idle");
	});

	test("a stuck runtime stop returns stop_failed after the configured bound", async () => {
		const stopBarrier = deferred();
		let deadlineCallback: (() => void) | undefined;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: () => stopBarrier.promise,
			queryRuntime: async () => "idle",
			stopDeadlineMs: 12_000,
			scheduleTimeout: (callback) => {
				deadlineCallback = callback;
				return 1;
			},
			cancelTimeout: () => {},
		});
		await orchestrator.start({ origin: "ui", launch: async () => {} });

		const stopping = orchestrator.stop();
		deadlineCallback?.();

		expect(await stopping).toEqual({
			result: "stop_failed",
			reason: "stop_timeout",
		});
		expect(orchestrator.snapshot().state).toBe("stop_failed");
	});

	test("a cancelled generation cannot cancel the next start", async () => {
		// Given generation one cancelled before its engine confirmation.
		const firstBarrier = deferred();
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
		});
		const first = orchestrator.start({
			origin: "ui",
			launch: async () => firstBarrier.promise,
		});
		await orchestrator.stop();
		firstBarrier.resolve();
		expect(await first).toEqual({
			result: "cancelled",
			attemptId: "attempt-1",
		});

		// When generation two starts after generation one's late cleanup.
		const second = await orchestrator.start({
			origin: "remote-control",
			launch: async () => {},
		});

		// Then the fresh generation reaches streaming independently.
		expect(second).toEqual({ result: "started", attemptId: "attempt-2" });
		expect(orchestrator.snapshot()).toEqual({
			state: "streaming",
			generation: 2,
		});
	});

	test("restart reconciliation adopts an engine-held stream", async () => {
		// Given a fresh backend whose engine reports a live runtime session.
		const statusEdges: boolean[] = [];
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: (streaming) => statusEdges.push(streaming),
			stopRuntime: async () => {},
			queryRuntime: async () => "streaming",
		});

		// When boot reconciliation queries the engine.
		const state = await orchestrator.reconcile();

		// Then reconciling resolves to streaming without a false-idle edge.
		expect(state).toBe("streaming");
		expect(statusEdges).toEqual([true]);
		expect(orchestrator.snapshot().state).toBe("streaming");
	});

	test("unknown runtime state remains reconciling until a heal adopts streaming", async () => {
		const runtimeStates: Array<"unknown" | "streaming"> = [
			"unknown",
			"streaming",
		];
		const statusEdges: boolean[] = [];
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: (streaming) => statusEdges.push(streaming),
			stopRuntime: async () => {},
			queryRuntime: async () => runtimeStates.shift() ?? "unknown",
		});

		expect(await orchestrator.reconcile()).toBe("reconciling");
		expect(statusEdges).toEqual([]);
		expect(await orchestrator.reconcile()).toBe("streaming");
		expect(statusEdges).toEqual([true]);
	});

	test("unknown runtime state remains reconciling until a heal adopts idle", async () => {
		const runtimeStates: Array<"unknown" | "idle"> = ["unknown", "idle"];
		const statusEdges: boolean[] = [];
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: (streaming) => statusEdges.push(streaming),
			stopRuntime: async () => {},
			queryRuntime: async () => runtimeStates.shift() ?? "unknown",
		});

		expect(await orchestrator.reconcile()).toBe("reconciling");
		expect(statusEdges).toEqual([]);
		expect(await orchestrator.reconcile()).toBe("idle");
		expect(statusEdges).toEqual([false]);
	});
});
