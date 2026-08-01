import {
	CONFIG_CHANGE_REASON_DEADLINE,
	type ConfigChangePhase,
	type ConfigChangeResult,
	type InputMode,
	isLegalLifecycleTransition,
	isTerminalConfigChangePhase,
	type LifecycleState,
	type StartResult,
	type StopResult,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import { asrcProbeRemainingMs } from "./audio.ts";
import {
	broadcastConfigChangePhase,
	changeEngineRuntimeConfig,
	classifyConfigChangeDispatchError as classifyDispatchError,
} from "./config-change-bridge.ts";
import { queryEngineRuntimeStreaming } from "./engine-runtime-state.ts";
import {
	classifyStartFailure,
	newAttemptId,
	type RetryPolicy,
	type SuppressionContext,
} from "./start-failure-taxonomy.ts";
import {
	RECONFIGURE_DEADLINE_MS,
	STOP_DEADLINE_MS,
} from "./start-lifecycle-timing.ts";
import { updateStreamLifecycleState } from "./stream-lifecycle-status.ts";
import {
	runStartWithRetry,
	type StartRetryDiagnostic,
} from "./stream-start-retry.ts";
import {
	getStartSuppressionContext,
	reportStartRetry,
	reportStartTerminalFailure,
} from "./stream-start-retry-reporting.ts";
import { getIsStreaming, updateStatus } from "./streaming.ts";
import type { EngineRuntimeState } from "./streaming-backend.ts";
import { stopGeneration } from "./streamloop/session.ts";

export const STREAM_LAUNCH_ORIGINS = [
	"ui",
	"autostart",
	"set-profile",
	"remote-control",
] as const;
export type StreamLaunchOrigin = (typeof STREAM_LAUNCH_ORIGINS)[number];

export type StreamLaunchContext = {
	readonly attemptId: string;
	readonly generation: number;
	readonly origin: StreamLaunchOrigin;
	readonly cancelled: () => boolean;
};

export type StreamStartRequest = {
	readonly origin: StreamLaunchOrigin;
	readonly launch: (context: StreamLaunchContext) => Promise<void>;
};

export type StreamSessionSnapshot = {
	readonly state: LifecycleState;
	readonly generation: number;
};

/**
 * The apply-now delta. Deliberately the fields that are baked into the graph at
 * build time — everything else is a live `reload-config`, not a transaction.
 */
export type StreamConfigChangeDelta = {
	readonly resolution?: string;
	readonly framerate?: number;
	readonly video_codec?: string;
	readonly input_id?: string;
	readonly pipeline?: string;
	// The ENGINE owns the libuvc-release → re-enumeration-barrier → open
	// transaction a live mode switch needs, and rolls it back honestly. This
	// field is only how the operator's choice reaches it — never a second
	// transaction of CeraUI's own.
	readonly input_mode?: InputMode;
};

export type EngineConfigChangeOutcome = {
	readonly phase: ConfigChangePhase;
	readonly reason?: string;
};

export type ConfigChangePhaseEvent = {
	readonly attemptId: string;
	readonly phase: ConfigChangePhase;
	readonly reason?: string;
};

export type { StartRetryDiagnostic } from "./stream-start-retry.ts";

export type StreamSessionOrchestratorDeps = {
	readonly createAttemptId: () => string;
	readonly setStreamingStatus: (streaming: boolean) => void;
	readonly getStreamingStatus?: () => boolean;
	readonly stopRuntime: (generation: number) => Promise<void>;
	readonly queryRuntime: () => Promise<EngineRuntimeState>;
	readonly setLifecycleState?: (state: LifecycleState) => void;
	readonly invariantViolation?: (
		from: LifecycleState,
		to: LifecycleState,
	) => void;
	readonly stopDeadlineMs?: number;
	readonly reconfigureDeadlineMs?: number;
	readonly changeRuntimeConfig?: (
		delta: StreamConfigChangeDelta,
		attemptId: string,
	) => Promise<EngineConfigChangeOutcome>;
	readonly publishConfigChangePhase?: (event: ConfigChangePhaseEvent) => void;
	readonly scheduleTimeout?: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof globalThis.setTimeout> | number;
	readonly cancelTimeout?: (
		timer: ReturnType<typeof globalThis.setTimeout> | number,
	) => void;
	readonly scheduleLaunchDeadline?: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof globalThis.setTimeout> | number;
	readonly cancelLaunchDeadline?: (
		timer: ReturnType<typeof globalThis.setTimeout> | number,
	) => void;
	readonly pendingGateRemainingMs?: () => number;
	readonly retryPolicy?: RetryPolicy;
	readonly now?: () => number;
	readonly suppressionContext?: () => SuppressionContext;
	readonly reportRetry?: (diagnostic: StartRetryDiagnostic) => void;
	readonly reportTerminalFailure?: (diagnostic: StartRetryDiagnostic) => void;
	/**
	 * Called once a launch has cleared the engine's outcome gate — the single
	 * moment a start is known to have really delivered, for every origin. It is
	 * deliberately NOT called from `reconcile()`: adopting a session the engine
	 * was already running is not a new commitment to anything.
	 */
	readonly onStreamCommitted?: () => void;
};

type ActiveAttempt = {
	readonly attemptId: string;
	readonly generation: number;
	cancelled: boolean;
	cancelRetryWait?: () => void;
};

type ActiveConfigChange = {
	readonly attemptId: string;
	settled: boolean;
	readonly settle: (outcome: EngineConfigChangeOutcome) => void;
};

type QueuedStop = {
	readonly promise: Promise<StopResult>;
	readonly release: (result: StopResult | Promise<StopResult>) => void;
	readonly cancelDeadline: () => void;
};

/**
 * A stop that waited out the whole transaction budget and still had nothing to
 * answer it. Distinct from `stop_timeout`, which means the engine was asked and
 * did not finish.
 */
export const RECONFIGURE_STOP_TIMEOUT_REASON = "reconfigure_stop_timeout";

export type StreamSessionOrchestrator = {
	readonly start: (request: StreamStartRequest) => Promise<StartResult>;
	readonly stop: () => Promise<StopResult>;
	readonly reconcile: () => Promise<LifecycleState>;
	readonly snapshot: () => StreamSessionSnapshot;
	readonly changeConfig: (
		delta: StreamConfigChangeDelta,
	) => Promise<ConfigChangeResult>;
	/**
	 * Terminal-phase events observed on the ENGINE EVENT BUS, fed in so a
	 * transaction whose RPC never answers (the engine escalated and exited) still
	 * settles. Without this the `rollback_failed{teardown_timeout}` → engine-exit
	 * chain leaves the RPC rejecting on a dead socket and the UI stuck in
	 * `applying` until the outer deadline.
	 */
	readonly noteConfigChangePhase: (event: ConfigChangePhaseEvent) => void;
};

export function createStreamSessionOrchestrator(
	deps: StreamSessionOrchestratorDeps,
): StreamSessionOrchestrator {
	let state: LifecycleState = "idle";
	let generation = 0;
	let active: ActiveAttempt | undefined;
	let reconciliationEpoch = 0;
	let activeChange: ActiveConfigChange | undefined;
	let queuedStop: QueuedStop | undefined;
	const stopDeadlineMs = deps.stopDeadlineMs ?? STOP_DEADLINE_MS;
	const reconfigureDeadlineMs =
		deps.reconfigureDeadlineMs ?? RECONFIGURE_DEADLINE_MS;
	const scheduleTimeout =
		deps.scheduleTimeout ??
		((callback: () => void, delayMs: number) =>
			globalThis.setTimeout(callback, delayMs));
	const cancelTimeout =
		deps.cancelTimeout ??
		((timer: ReturnType<typeof globalThis.setTimeout> | number) =>
			globalThis.clearTimeout(timer));
	const scheduleLaunchDeadline =
		deps.scheduleLaunchDeadline ??
		((callback: () => void, delayMs: number) =>
			globalThis.setTimeout(callback, delayMs));
	const cancelLaunchDeadline =
		deps.cancelLaunchDeadline ??
		((timer: ReturnType<typeof globalThis.setTimeout> | number) =>
			globalThis.clearTimeout(timer));

	const stopWithinDeadline = (generationToStop: number): Promise<void> => {
		let timer: ReturnType<typeof globalThis.setTimeout> | number | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = scheduleTimeout(
				() => reject(new Error("stop_timeout")),
				stopDeadlineMs,
			);
		});
		return Promise.race([deps.stopRuntime(generationToStop), timeout]).finally(
			() => {
				if (timer !== undefined) cancelTimeout(timer);
			},
		);
	};

	const transition = (next: LifecycleState): boolean => {
		if (state === next) return true;
		if (!isLegalLifecycleTransition(state, next)) {
			deps.invariantViolation?.(state, next);
			return false;
		}
		state = next;
		deps.setLifecycleState?.(state);
		return true;
	};

	const finishCancelled = async (
		attempt: ActiveAttempt,
	): Promise<StartResult> => {
		await stopWithinDeadline(attempt.generation);
		if (active === attempt) {
			transition("idle");
			active = undefined;
			deps.setStreamingStatus(false);
		}
		return { result: "cancelled", attemptId: attempt.attemptId };
	};

	const start = async (request: StreamStartRequest): Promise<StartResult> => {
		const attemptId = deps.createAttemptId();
		if (
			(state === "streaming" || state === "stop_failed") &&
			deps.getStreamingStatus?.() === false
		) {
			state = "idle";
			active = undefined;
			deps.setLifecycleState?.(state);
		}
		if (state !== "idle") return { result: "busy", attemptId };

		generation += 1;
		const attempt: ActiveAttempt = {
			attemptId,
			generation,
			cancelled: false,
		};
		active = attempt;
		transition("starting");
		const deadlineCancelledLaunches = new Set<number>();

		const launchResult = await runStartWithRetry({
			attemptId,
			launch: (launchNumber) =>
				request.launch({
					attemptId,
					generation: attempt.generation,
					origin: request.origin,
					cancelled: () =>
						attempt.cancelled || deadlineCancelledLaunches.has(launchNumber),
				}),
			classifyUnknown: (error) =>
				classifyStartFailure("start-rpc", error, attemptId, {
					warn: (message, meta) => logger.warn(message, meta),
				}),
			cancelled: () => attempt.cancelled || active !== attempt,
			onLaunchTimeout: async (launchNumber) => {
				deadlineCancelledLaunches.add(launchNumber);
				try {
					await stopWithinDeadline(attempt.generation);
				} catch (error) {
					logger.error("Timed-out stream launch cleanup failed", {
						attemptId,
						generation: attempt.generation,
						launchNumber,
						error,
					});
					throw error;
				}
			},
			setCancelWait: (cancel) => {
				if (cancel === undefined) delete attempt.cancelRetryWait;
				else attempt.cancelRetryWait = cancel;
			},
			schedule: scheduleTimeout,
			cancelTimer: cancelTimeout,
			scheduleDeadline: scheduleLaunchDeadline,
			cancelDeadline: cancelLaunchDeadline,
			cleanupDeadlineMs: stopDeadlineMs,
			...(deps.pendingGateRemainingMs !== undefined
				? { pendingGateRemainingMs: deps.pendingGateRemainingMs }
				: {}),
			...(deps.retryPolicy !== undefined
				? { retryPolicy: deps.retryPolicy }
				: {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			...(deps.suppressionContext !== undefined
				? { suppressionContext: deps.suppressionContext }
				: {}),
			...(deps.reportRetry !== undefined
				? { reportRetry: deps.reportRetry }
				: {}),
			...(deps.reportTerminalFailure !== undefined
				? { reportTerminalFailure: deps.reportTerminalFailure }
				: {}),
		});
		if (launchResult.result === "cancelled") {
			return await finishCancelled(attempt);
		}
		if (launchResult.result === "failed") {
			transition("idle");
			active = undefined;
			deps.setStreamingStatus(false);
			return {
				result: "failed",
				attemptId,
				failure: launchResult.failure,
			};
		}
		transition("streaming");
		deps.setStreamingStatus(true);
		// Never let a bookkeeping failure turn a stream that IS live into a
		// reported start failure.
		try {
			deps.onStreamCommitted?.();
		} catch (error) {
			logger.warn("stream commit bookkeeping failed", { attemptId, error });
		}
		return { result: "started", attemptId };
	};

	/**
	 * A parked stop is released by the settling transaction and by NOTHING else,
	 * so the wait is bounded by that transaction's own declared budget: its full
	 * bound, plus the one stop bound the released stop still gets afterwards.
	 * That is by construction the latest instant a healthy queued stop can
	 * answer, so this deadline can only ever fire on a transaction that broke
	 * its own contract — never on slow-but-working hardware.
	 *
	 * Measured on a live board (2026-07-31): an operator Stop parked here sat
	 * unanswered while the lifecycle stayed frozen on `reconfiguring` and the
	 * journal carried not one line about it. Unbounded and unlogged, that
	 * silence had no ceiling at all.
	 */
	const parkStop = (): QueuedStop => {
		let release!: (result: StopResult | Promise<StopResult>) => void;
		const promise = new Promise<StopResult>((resolve) => {
			release = resolve;
		});
		const attemptId = activeChange?.attemptId;
		const budgetMs = reconfigureDeadlineMs + stopDeadlineMs;

		const timer = scheduleTimeout(() => {
			if (queuedStop?.promise !== promise) return;
			queuedStop = undefined;
			logger.error(
				"stream stop parked behind a config change was never released",
				{
					attemptId,
					budgetMs,
					state,
				},
			);
			// The transaction outlived every bound it declared, so the engine's
			// real state is unknown to us — adopt its truth rather than assert one.
			if (transition("reconciling")) void reconcile();
			release({
				result: "stop_failed",
				reason: RECONFIGURE_STOP_TIMEOUT_REASON,
			});
		}, budgetMs);

		logger.warn("stream stop parked behind an in-flight config change", {
			attemptId,
			budgetMs,
		});
		return { promise, release, cancelDeadline: () => cancelTimeout(timer) };
	};

	const stop = async (): Promise<StopResult> => {
		// A change transaction already owns the engine's lifecycle mutex and the
		// capture hardware. Racing a 12 s stop deadline against it would report a
		// healthy 65 s transaction as `stop_failed`, so the stop WAITS and is then
		// answered against whatever state the transaction actually settled into.
		if (state === "reconfiguring") {
			if (queuedStop === undefined) queuedStop = parkStop();
			return queuedStop.promise;
		}
		if (state === "idle") return { result: "stopped" };
		if (state === "reconciling") {
			reconciliationEpoch += 1;
			transition("idle");
			deps.setStreamingStatus(false);
			return { result: "stopped" };
		}

		const stoppedGeneration = active?.generation ?? generation;
		const cancellingStart = state === "starting";
		if (cancellingStart && active !== undefined) {
			active.cancelled = true;
			active.cancelRetryWait?.();
		}
		if (!transition("stopping")) {
			return {
				result: "stop_failed",
				reason: "illegal_lifecycle_transition",
			};
		}

		try {
			await stopWithinDeadline(stoppedGeneration);
			if (!cancellingStart) {
				active = undefined;
				transition("idle");
				deps.setStreamingStatus(false);
			}
			return { result: "stopped" };
		} catch (error) {
			transition("stop_failed");
			const reason = error instanceof Error ? error.message : "stop_failed";
			logger.error("stream stop did not settle within its deadline", {
				generation: stoppedGeneration,
				deadlineMs: stopDeadlineMs,
				reason,
			});
			return { result: "stop_failed", reason };
		}
	};

	const reconcile = async (): Promise<LifecycleState> => {
		// `stop_failed` is included deliberately: a stop we could not confirm
		// leaves the engine's real state UNKNOWN to us, and adopting its truth is
		// the only way out. Without this the state latches — `start` refuses while
		// the stale streaming status stands, and every later cycle is lost.
		if (
			state !== "idle" &&
			state !== "streaming" &&
			state !== "reconciling" &&
			state !== "stop_failed"
		)
			return state;
		if (state !== "reconciling") transition("reconciling");
		const epoch = ++reconciliationEpoch;
		const runtimeState = await deps.queryRuntime();
		if (epoch !== reconciliationEpoch) return state;
		if (runtimeState === "unknown") return state;
		transition(runtimeState);
		deps.setStreamingStatus(runtimeState === "streaming");
		return state;
	};

	const releaseQueuedStop = (): boolean => {
		const pending = queuedStop;
		if (pending === undefined) return false;
		queuedStop = undefined;
		pending.cancelDeadline();
		pending.release(stop());
		return true;
	};

	const noteConfigChangePhase = (event: ConfigChangePhaseEvent): void => {
		const change = activeChange;
		// Fence on attempt id: a phase from a superseded transaction must never
		// settle the current one.
		if (change === undefined || change.attemptId !== event.attemptId) return;
		if (!isTerminalConfigChangePhase(event.phase)) return;
		change.settle(
			event.reason === undefined
				? { phase: event.phase }
				: { phase: event.phase, reason: event.reason },
		);
	};

	const settleConfigChangeState = (
		outcome: EngineConfigChangeOutcome,
	): LifecycleState => {
		if (outcome.phase === "applied" || outcome.phase === "reverted") {
			transition("streaming");
			deps.setStreamingStatus(true);
			return "streaming";
		}
		if (outcome.reason === CONFIG_CHANGE_REASON_DEADLINE) {
			// The transaction outlived its own declared bound, so the engine's state
			// is genuinely unknown to us — adopt its truth rather than assert one.
			transition("reconciling");
			return "reconciling";
		}
		// Every other rollback_failed is the engine telling us it gave up and went
		// Idle (the `teardown_timeout` escalation is the canonical case).
		transition("idle");
		active = undefined;
		deps.setStreamingStatus(false);
		return "idle";
	};

	const changeConfig = async (
		delta: StreamConfigChangeDelta,
	): Promise<ConfigChangeResult> => {
		const runChange = deps.changeRuntimeConfig;
		if (runChange === undefined)
			return { result: "rejected", reason: "change_config_unsupported" };
		if (state !== "streaming" || activeChange !== undefined)
			return { result: "busy" };

		const attemptId = deps.createAttemptId();
		if (!transition("reconfiguring")) return { result: "busy" };

		let settleObserved!: (outcome: EngineConfigChangeOutcome) => void;
		const observed = new Promise<EngineConfigChangeOutcome>((resolve) => {
			settleObserved = resolve;
		});
		const change: ActiveConfigChange = {
			attemptId,
			settled: false,
			settle: (outcome) => {
				if (change.settled) return;
				change.settled = true;
				settleObserved(outcome);
			},
		};
		activeChange = change;
		deps.publishConfigChangePhase?.({ attemptId, phase: "applying" });

		let timer: ReturnType<typeof globalThis.setTimeout> | number | undefined;
		const deadline = new Promise<EngineConfigChangeOutcome>((resolve) => {
			timer = scheduleTimeout(
				() =>
					resolve({
						phase: "rollback_failed",
						reason: CONFIG_CHANGE_REASON_DEADLINE,
					}),
				reconfigureDeadlineMs,
			);
		});

		const dispatched = runChange(delta, attemptId).then(
			(outcome) => outcome,
			(error: unknown): EngineConfigChangeOutcome => {
				// A dead control socket rejects every in-flight call, so a rejection
				// is NOT authoritative once the bus already reported a terminal phase
				// — the race below has already picked that honest reason.
				logger.warn("config change dispatch rejected", { attemptId, error });
				return classifyDispatchError(error);
			},
		);

		let outcome: EngineConfigChangeOutcome;
		try {
			outcome = await Promise.race([observed, dispatched, deadline]);
		} finally {
			if (timer !== undefined) cancelTimeout(timer);
			activeChange = undefined;
		}

		const settled = settleConfigChangeState(outcome);
		deps.publishConfigChangePhase?.({
			attemptId,
			phase: outcome.phase,
			...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
		});

		const hadQueuedStop = releaseQueuedStop();
		if (!hadQueuedStop && settled === "reconciling") void reconcile();

		if (outcome.phase === "applied") return { result: "applied", attemptId };
		return {
			result: outcome.phase === "reverted" ? "reverted" : "rollback_failed",
			attemptId,
			...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
		};
	};

	return {
		start,
		stop,
		reconcile,
		snapshot: () => ({ state, generation }),
		changeConfig,
		noteConfigChangePhase,
	};
}

const productionOrchestrator = createStreamSessionOrchestrator({
	createAttemptId: newAttemptId,
	setStreamingStatus: updateStatus,
	getStreamingStatus: getIsStreaming,
	stopRuntime: stopGeneration,
	queryRuntime: queryEngineRuntimeStreaming,
	setLifecycleState: updateStreamLifecycleState,
	invariantViolation: (from, to) => {
		logger.error("stream-session illegal lifecycle transition", { from, to });
		notificationBroadcast(
			"stream_session_recovered",
			"warning",
			"The stream session entered an invalid lifecycle state and was recovered.",
			10,
			false,
			true,
		);
	},
	// The audio-source probe deliberately waits longer than one attempt deadline;
	// without this the generic timeout preempts it and reports a missing audio
	// device as an unanswered engine.
	pendingGateRemainingMs: () => asrcProbeRemainingMs(),
	suppressionContext: getStartSuppressionContext,
	reportRetry: reportStartRetry,
	reportTerminalFailure: reportStartTerminalFailure,
	changeRuntimeConfig: changeEngineRuntimeConfig,
	publishConfigChangePhase: broadcastConfigChangePhase,
	// Lazily imported for the reason `sources.ts` states about its own audio
	// handler: this module is already reachable FROM the source graph, so a
	// static edge back into it reorders module initialisation and leaves the
	// boot-time source build reading a half-initialised module.
	onStreamCommitted: () => {
		void import("./sources.ts")
			.then(({ noteStreamedSourceCommitted }) => noteStreamedSourceCommitted())
			.catch((error) =>
				logger.warn("stream commit bookkeeping failed", { error }),
			);
	},
});

export function startStreamSession(
	request: StreamStartRequest,
): Promise<StartResult> {
	return productionOrchestrator.start(request);
}

export function stopStreamSession(): Promise<StopResult> {
	return productionOrchestrator.stop();
}

export function reconcileStreamSession(): Promise<LifecycleState> {
	return productionOrchestrator.reconcile();
}

export function getStreamSessionSnapshot(): StreamSessionSnapshot {
	return productionOrchestrator.snapshot();
}

export function changeStreamSessionConfig(
	delta: StreamConfigChangeDelta,
): Promise<ConfigChangeResult> {
	return productionOrchestrator.changeConfig(delta);
}

export function noteStreamSessionConfigChangePhase(
	event: ConfigChangePhaseEvent,
): void {
	productionOrchestrator.noteConfigChangePhase(event);
}
