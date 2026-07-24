import { describe, expect, test } from "bun:test";
import { StreamStartFailure } from "../modules/streaming/start-failure-taxonomy.ts";
import {
	createStreamSessionOrchestrator,
	type StartRetryDiagnostic,
	type StreamLaunchContext,
} from "../modules/streaming/stream-session-orchestrator.ts";

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

function retriableFailure(attemptId: string): StreamStartFailure {
	return new StreamStartFailure({
		attemptId,
		phase: "connect",
		class: "engine_unavailable",
		retriable: true,
	});
}

async function settleMicrotasks(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
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
			retryPolicy: {
				maxAttempts: 1,
				totalBudgetMs: 60_000,
				baseDelayMs: 2_000,
				maxDelayMs: 16_000,
			},
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

	test("retries a refused connect until the socket appears and succeeds without a terminal report", async () => {
		// Given an engine boot window and deterministic retry timers.
		const retryCallbacks: Array<() => void> = [];
		const diagnostics: StartRetryDiagnostic[] = [];
		const terminal: StartRetryDiagnostic[] = [];
		let launches = 0;
		let nowMs = 0;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
			now: () => nowMs,
			scheduleTimeout: (callback) => {
				retryCallbacks.push(callback);
				return retryCallbacks.length;
			},
			cancelTimeout: () => {},
			suppressionContext: () => ({
				softwareUpdateActive: false,
				engineRestartWindow: false,
				bootWindow: true,
				cancelledByStop: false,
			}),
			reportRetry: (diagnostic) => diagnostics.push(diagnostic),
			reportTerminalFailure: (diagnostic) => terminal.push(diagnostic),
		});

		// When two refused connects are followed by a successful socket connection.
		const resultPromise = orchestrator.start({
			origin: "ui",
			launch: async ({ attemptId }) => {
				launches += 1;
				if (launches < 3) throw retriableFailure(attemptId);
			},
		});
		await settleMicrotasks();
		nowMs = 2_000;
		retryCallbacks.shift()?.();
		await settleMicrotasks();
		nowMs = 6_000;
		retryCallbacks.shift()?.();
		const result = await resultPromise;

		// Then retrying remains calm and the eventual start has no terminal alert.
		expect(result).toEqual({ result: "started", attemptId: "attempt-1" });
		expect(launches).toBe(3);
		expect(diagnostics.map((entry) => entry.retry.state)).toEqual([
			"scheduled",
			"scheduled",
		]);
		expect(diagnostics.every((entry) => entry.retry.suppressed)).toBe(true);
		expect(terminal).toEqual([]);
	});

	test("budget exhaustion reports one terminal diagnostic with the attempt count", async () => {
		// Given a three-attempt policy and an engine that remains unavailable.
		const retryCallbacks: Array<() => void> = [];
		const terminal: StartRetryDiagnostic[] = [];
		let nowMs = 0;
		let launches = 0;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
			now: () => nowMs,
			retryPolicy: {
				maxAttempts: 3,
				totalBudgetMs: 20,
				baseDelayMs: 5,
				maxDelayMs: 10,
			},
			scheduleTimeout: (callback) => {
				retryCallbacks.push(callback);
				return retryCallbacks.length;
			},
			cancelTimeout: () => {},
			reportTerminalFailure: (diagnostic) => terminal.push(diagnostic),
		});

		// When every bounded attempt fails.
		const resultPromise = orchestrator.start({
			origin: "ui",
			launch: async ({ attemptId }) => {
				launches += 1;
				throw retriableFailure(attemptId);
			},
		});
		await settleMicrotasks();
		nowMs = 5;
		retryCallbacks.shift()?.();
		await settleMicrotasks();
		nowMs = 15;
		retryCallbacks.shift()?.();
		const result = await resultPromise;

		// Then one truthful exhausted diagnostic carries the final class and count.
		expect(result).toMatchObject({
			result: "failed",
			failure: { class: "engine_unavailable" },
		});
		expect(launches).toBe(3);
		expect(terminal).toHaveLength(1);
		expect(terminal[0]?.retry).toMatchObject({
			state: "exhausted",
			attempt: 3,
			maxAttempts: 3,
		});
	});

	test("deadlines an in-flight launch, cleans its generation, and releases the start slot", async () => {
		// Given a launch that never settles on its own and a deterministic deadline.
		const launchBarrier = deferred();
		const timers: Array<{ callback: () => void; delayMs: number }> = [];
		const events: string[] = [];
		const terminal: StartRetryDiagnostic[] = [];
		let nowMs = 0;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async (generation) => {
				events.push(`cleanup-${generation}`);
			},
			queryRuntime: async () => "idle",
			retryPolicy: {
				maxAttempts: 5,
				totalBudgetMs: 10,
				baseDelayMs: 5,
				maxDelayMs: 10,
				attemptTimeoutMs: 10,
			},
			now: () => nowMs,
			scheduleLaunchDeadline: (callback, delayMs) => {
				timers.push({ callback, delayMs });
				return timers.length;
			},
			cancelTimeout: () => {},
			reportTerminalFailure: (diagnostic) => terminal.push(diagnostic),
		});
		const firstStart = orchestrator.start({
			origin: "ui",
			launch: async ({ cancelled }) => {
				await launchBarrier.promise;
				events.push(`launch-settled-cancelled-${cancelled()}`);
			},
		});
		let resultSettled = false;
		void firstStart.then(() => {
			resultSettled = true;
		});

		await settleMicrotasks();
		const deadline = timers.find((timer) => timer.delayMs === 10);
		try {
			// When the per-attempt deadline expires.
			expect(deadline).toBeDefined();
			nowMs = 10;
			deadline?.callback();
			await Bun.sleep(0);
			expect(resultSettled).toBe(false);
			launchBarrier.resolve();
			const result = await firstStart;

			// Then cleanup precedes one terminal timeout and the slot is reusable.
			expect(result).toMatchObject({
				result: "failed",
				failure: {
					phase: "connect",
					class: "start_timeout",
					code: "start_attempt_deadline",
				},
			});
			expect(events).toEqual(["cleanup-1", "launch-settled-cancelled-true"]);
			expect(terminal).toHaveLength(1);
			expect(terminal[0]?.retry).toMatchObject({
				state: "exhausted",
				attempt: 1,
			});
			expect(
				await orchestrator.start({ origin: "ui", launch: async () => {} }),
			).toMatchObject({ result: "started" });
		} finally {
			launchBarrier.resolve();
			await firstStart;
		}
		await settleMicrotasks();
		expect(events).toEqual(["cleanup-1", "launch-settled-cancelled-true"]);
	});

	test("does not retry when a timed-out launch remains unsettled after cleanup", async () => {
		// Given an in-flight launch that survives both generation cleanup and its bound.
		const launchBarrier = deferred();
		const deadlineTimers: Array<{ callback: () => void; delayMs: number }> = [];
		const retryDelays: number[] = [];
		const terminal: StartRetryDiagnostic[] = [];
		let nowMs = 0;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
			stopDeadlineMs: 12,
			retryPolicy: {
				maxAttempts: 5,
				totalBudgetMs: 60,
				baseDelayMs: 5,
				maxDelayMs: 10,
				attemptTimeoutMs: 10,
			},
			now: () => nowMs,
			scheduleTimeout: (_callback, delayMs) => {
				retryDelays.push(delayMs);
				return retryDelays.length;
			},
			cancelTimeout: () => {},
			scheduleLaunchDeadline: (callback, delayMs) => {
				deadlineTimers.push({ callback, delayMs });
				return deadlineTimers.length;
			},
			cancelLaunchDeadline: () => {},
			reportTerminalFailure: (diagnostic) => terminal.push(diagnostic),
		});
		const starting = orchestrator.start({
			origin: "ui",
			launch: async () => launchBarrier.promise,
		});

		try {
			// When the launch deadline and the subsequent cleanup-settlement bound expire.
			await settleMicrotasks();
			nowMs = 10;
			deadlineTimers.find((timer) => timer.delayMs === 10)?.callback();
			await settleMicrotasks();
			nowMs = 22;
			deadlineTimers.find((timer) => timer.delayMs === 12)?.callback();
			const result = await starting;

			// Then cleanup incompleteness is terminal and no retry backoff is armed.
			expect(result).toMatchObject({
				result: "failed",
				failure: {
					class: "start_timeout",
					code: "start_cleanup_timeout",
					retriable: false,
				},
			});
			expect(retryDelays).not.toContain(5);
			expect(terminal).toHaveLength(1);
			expect(terminal[0]?.retry).toMatchObject({
				state: "not_retriable",
				attempt: 1,
			});
		} finally {
			launchBarrier.resolve();
			await starting;
		}
	});

	test("ignores a stale launch deadline after its generation has started", async () => {
		// Given a successful launch whose cancelled deadline callback is retained.
		let deadlineCallback: (() => void) | undefined;
		let cleanups = 0;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async () => {
				cleanups += 1;
			},
			queryRuntime: async () => "idle",
			scheduleLaunchDeadline: (callback) => {
				deadlineCallback = callback;
				return 1;
			},
			cancelLaunchDeadline: () => {},
		});
		const result = await orchestrator.start({
			origin: "ui",
			launch: async () => {},
		});

		// When the stale timer callback fires after the start has settled.
		deadlineCallback?.();
		await settleMicrotasks();

		// Then it cannot cancel or clean the active generation.
		expect(result).toMatchObject({ result: "started" });
		expect(orchestrator.snapshot()).toMatchObject({ state: "streaming" });
		expect(cleanups).toBe(0);
	});

	test("a deterministic start error is terminal without scheduling a retry", async () => {
		// Given a non-retriable engine rejection.
		const retryDiagnostics: StartRetryDiagnostic[] = [];
		const terminal: StartRetryDiagnostic[] = [];
		let launches = 0;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
			reportRetry: (diagnostic) => retryDiagnostics.push(diagnostic),
			reportTerminalFailure: (diagnostic) => terminal.push(diagnostic),
		});

		// When start parameters are rejected.
		const result = await orchestrator.start({
			origin: "ui",
			launch: async ({ attemptId }) => {
				launches += 1;
				throw new StreamStartFailure({
					attemptId,
					phase: "start-rpc",
					class: "start_invalid",
					code: -32602,
					retriable: false,
				});
			},
		});

		// Then the failure is immediate and its diagnostic says no retry.
		expect(result).toMatchObject({
			result: "failed",
			failure: { class: "start_invalid", code: -32602 },
		});
		expect(launches).toBe(1);
		expect(retryDiagnostics).toEqual([]);
		expect(terminal[0]?.retry.state).toBe("not_retriable");
	});

	test("stop cancels a scheduled retry without a terminal notification", async () => {
		// Given a failed first attempt waiting on its retry timer.
		const terminal: StartRetryDiagnostic[] = [];
		let launches = 0;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
			scheduleTimeout: () => 1,
			cancelTimeout: () => {},
			reportTerminalFailure: (diagnostic) => terminal.push(diagnostic),
		});
		const start = orchestrator.start({
			origin: "ui",
			launch: async ({ attemptId }) => {
				launches += 1;
				throw retriableFailure(attemptId);
			},
		});
		await Promise.resolve();

		// When stop interrupts the pending backoff.
		expect(await orchestrator.stop()).toEqual({ result: "stopped" });
		const result = await start;

		// Then no stale timer launches again and cancellation notifies nothing.
		expect(result).toEqual({ result: "cancelled", attemptId: "attempt-1" });
		expect(launches).toBe(1);
		expect(terminal).toEqual([]);
	});

	test("awaits failed-attempt rollback before scheduling the next launch", async () => {
		// Given a launch whose rejection follows an observable rollback barrier.
		const events: string[] = [];
		let retryCallback: (() => void) | undefined;
		let launches = 0;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
			scheduleTimeout: (callback) => {
				retryCallback = callback;
				events.push("scheduled");
				return 1;
			},
			cancelTimeout: () => {},
		});

		// When attempt one rolls back and attempt two succeeds.
		const start = orchestrator.start({
			origin: "ui",
			launch: async ({ attemptId }) => {
				launches += 1;
				events.push(`launch-${launches}`);
				if (launches === 1) {
					await Promise.resolve();
					events.push("rollback-complete");
					throw retriableFailure(attemptId);
				}
			},
		});
		await settleMicrotasks();
		expect(retryCallback).toBeDefined();
		retryCallback?.();
		expect(await start).toMatchObject({ result: "started" });

		// Then cleanup completion precedes both scheduling and the next launch.
		expect(events).toEqual([
			"launch-1",
			"rollback-complete",
			"scheduled",
			"launch-2",
		]);
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
