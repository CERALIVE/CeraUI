/**
 * The audio-probe gate must OWN its own failure.
 *
 * Found live on a board: with the operator's selected audio input missing, the
 * 15 s audio-probe grace window (`asrcProbe`, AUDIO_PROBE_TIMEOUT_MS) sat inside
 * the SHORTER 10 s generic per-attempt launch deadline. The deadline won the
 * race, so a permanently-absent audio device was reported as a retriable
 * connect-phase `start_timeout` — "Streaming engine did not answer in time —
 * retrying (N/5)…" for up to a minute — even though no engine `start` was ever
 * dispatched (the probe runs BEFORE any engine IPC).
 *
 * These tests pin the corrected contract: the probe window completes, the
 * failure is the non-retriable `audio_source_unavailable`, and nothing about the
 * engine is claimed.
 */

import { describe, expect, test } from "bun:test";
import {
	isRetriableStartFailure,
	START_FAILURE_PHASES,
	type StartFailure,
} from "@ceraui/rpc/schemas";

import { getConfig } from "../modules/config.ts";
import { AudioProbeTimeoutError } from "../modules/streaming/audio.ts";
import { AUDIO_PROBE_TIMEOUT_MS } from "../modules/streaming/constants.ts";
import type { Pipeline } from "../modules/streaming/pipelines.ts";
import {
	DEFAULT_START_RETRY_POLICY,
	StreamStartFailure,
	typedStartFailure,
} from "../modules/streaming/start-failure-taxonomy.ts";
import {
	runStartWithRetry,
	type StartRetryDiagnostic,
} from "../modules/streaming/stream-start-retry.ts";
import { getStreamingProcesses } from "../modules/streaming/streamloop/process-runner.ts";
import {
	AUDIO_SOURCE_PROBE_FAILED,
	startStream,
} from "../modules/streaming/streamloop/start-stream.ts";

const audioPipeline = {
	source: "hdmi",
	name: "Test HDMI",
	hardware: "rk3588",
	description: "test pipeline",
	supportsAudio: true,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audio_kind: "selectable",
} as Pipeline;

// A deterministic virtual clock: every scheduled callback is queued against a
// wall-clock offset and fired in order, so the 10 s deadline vs 15 s probe race
// is exercised exactly, in milliseconds, without waiting for real time.
function createVirtualClock() {
	let now = 0;
	let seq = 0;
	const queue = new Map<
		number,
		{ readonly at: number; readonly seq: number; readonly run: () => void }
	>();

	return {
		now: () => now,
		schedule(run: () => void, delayMs: number): number {
			const id = ++seq;
			queue.set(id, { at: now + Math.max(0, delayMs), seq: id, run });
			return id;
		},
		cancel(id: number | ReturnType<typeof globalThis.setTimeout>): void {
			queue.delete(id as number);
		},
		/** Drain queued timers until `promise` settles or the queue empties. */
		async settle<T>(promise: Promise<T>): Promise<T> {
			let done = false;
			const tracked = promise.finally(() => {
				done = true;
			});
			for (let guard = 0; guard < 10_000 && !done; guard += 1) {
				// Let already-resolved microtasks run before advancing the clock.
				await Promise.resolve();
				await new Promise((resolve) => setImmediate(resolve));
				if (done) break;
				const next = [...queue.values()].sort(
					(a, b) => a.at - b.at || a.seq - b.seq,
				)[0];
				if (next === undefined) break;
				now = Math.max(now, next.at);
				for (const [id, entry] of queue) {
					if (entry === next) queue.delete(id);
				}
				next.run();
			}
			return tracked;
		},
	};
}

type ProbeLaunchRun = {
	readonly result: Awaited<ReturnType<typeof runStartWithRetry>>;
	readonly engineStartCalls: number;
	readonly retries: StartRetryDiagnostic[];
	readonly terminal: StartRetryDiagnostic[];
};

/**
 * Drive the real retry runner over a launch shaped like the production one: a
 * bounded audio-probe gate that never resolves, followed by the engine start.
 */
async function runLaunchWithUnavailableAudio(): Promise<ProbeLaunchRun> {
	const clock = createVirtualClock();
	const retries: StartRetryDiagnostic[] = [];
	const terminal: StartRetryDiagnostic[] = [];
	let engineStartCalls = 0;
	let probeDeadlineAt: number | undefined;

	const result = await clock.settle(
		runStartWithRetry({
			attemptId: "att_test",
			launch: async () => {
				// Phase 1 — the audio-source grace window (start-stream.ts probes
				// BEFORE it spawns the sender or touches the engine).
				probeDeadlineAt = clock.now() + AUDIO_PROBE_TIMEOUT_MS;
				await new Promise<never>((_resolve, reject) => {
					clock.schedule(() => {
						probeDeadlineAt = undefined;
						reject(
							new StreamStartFailure(
								typedStartFailure(
									"att_test",
									"params",
									"audio_source_unavailable",
									AUDIO_SOURCE_PROBE_FAILED,
								),
							),
						);
					}, AUDIO_PROBE_TIMEOUT_MS);
				});
				// Phase 2 — never reached for an unavailable audio device.
				engineStartCalls += 1;
			},
			classifyUnknown: (): StartFailure =>
				typedStartFailure("att_test", "start-rpc", "engine_internal"),
			cancelled: () => false,
			onLaunchTimeout: async () => {
				probeDeadlineAt = undefined;
			},
			setCancelWait: () => {},
			schedule: (callback, delayMs) => clock.schedule(callback, delayMs),
			cancelTimer: (timer) => clock.cancel(timer as number),
			scheduleDeadline: (callback, delayMs) =>
				clock.schedule(callback, delayMs),
			cancelDeadline: (timer) => clock.cancel(timer as number),
			cleanupDeadlineMs: 12_000,
			now: () => clock.now(),
			pendingGateRemainingMs: () =>
				probeDeadlineAt === undefined
					? 0
					: Math.max(0, probeDeadlineAt - clock.now()),
			reportRetry: (diagnostic) => retries.push(diagnostic),
			reportTerminalFailure: (diagnostic) => terminal.push(diagnostic),
		}),
	);

	return { result, engineStartCalls, retries, terminal };
}

describe("audio_source_unavailable is a first-class, non-retriable start failure", () => {
	test("the taxonomy never retries it, on any phase", () => {
		for (const phase of START_FAILURE_PHASES) {
			expect(isRetriableStartFailure("audio_source_unavailable", phase)).toBe(
				false,
			);
		}
	});

	test("the audio-probe grace window outlives the generic per-attempt deadline", () => {
		// The ordering invariant the live bug violated. If the generic deadline is
		// ever shortened below the probe window again, the probe is preempted and
		// its typed failure is replaced by `start_timeout`.
		expect(DEFAULT_START_RETRY_POLICY.attemptTimeoutMs).toBeLessThan(
			AUDIO_PROBE_TIMEOUT_MS,
		);
	});
});

describe("an unavailable audio source fails the start truthfully, not as a timeout", () => {
	test("no engine start is dispatched and the failure is the typed audio reason", async () => {
		const run = await runLaunchWithUnavailableAudio();

		// (a) the engine was never contacted.
		expect(run.engineStartCalls).toBe(0);

		// (b) the operator-facing failure is the audio reason, not `start_timeout`.
		expect(run.result.result).toBe("failed");
		if (run.result.result !== "failed") return;
		expect(run.result.failure.class).toBe("audio_source_unavailable");
		expect(run.result.failure.retriable).toBe(false);
		expect(run.result.failure.code).toBe(AUDIO_SOURCE_PROBE_FAILED);
	});

	test("no misleading 'engine did not answer' retry round is reported", async () => {
		const run = await runLaunchWithUnavailableAudio();

		// (c) zero retry notifications — a device that is gone does not come back
		// because we asked the engine five more times.
		expect(run.retries).toEqual([]);
		expect(run.terminal).toHaveLength(1);
		expect(run.terminal[0]?.class).toBe("audio_source_unavailable");
		expect(run.terminal[0]?.retry.state).toBe("not_retriable");
	});
});

describe("startStream self-classifies the probe failure", () => {
	test("the probe-failure result carries the typed class alongside the legacy reason", async () => {
		const config = getConfig();
		const savedAsrc = config.asrc;
		config.asrc = "HDMI";
		try {
			const result = await startStream(
				audioPipeline,
				"192.0.2.10",
				5000,
				"sid",
				{
					probe: () => Promise.reject(new AudioProbeTimeoutError("HDMI")),
				},
			);

			expect(result).toEqual({
				success: false,
				error: AUDIO_SOURCE_PROBE_FAILED,
				reason: AUDIO_SOURCE_PROBE_FAILED,
				phase: "params",
				failureClass: "audio_source_unavailable",
			});
			expect(getStreamingProcesses().length).toBe(0);
		} finally {
			config.asrc = savedAsrc;
		}
	});
});
