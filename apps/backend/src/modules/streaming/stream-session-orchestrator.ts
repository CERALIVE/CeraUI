import {
	type EventParams,
	INTERNAL_TRANSITION_WORST_CASE_BOUND_MS,
} from "@ceralive/cerastream";
import {
	CONFIG_CHANGE_REASON_DEADLINE,
	type ConfigChangePhase,
	type ConfigChangeResult,
	type InputMode,
	isTerminalConfigChangePhase,
	type LifecycleState,
	type StartFailureClass,
	type StartResult,
	type StopResult,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import type { StreamStartUpdateAdmission } from "../system/update-orchestrator/runtime.ts";
import type { StreamStopCause } from "./armed-stream-marker.ts";
import { classifyConfigChangeDispatchError as classifyDispatchError } from "./config-change-bridge.ts";
import { withRuntimeObservationOwner } from "./engine-runtime-observation.ts";
import {
	type LifecycleAdmission,
	type LifecycleLease,
	MODEM_TRANSITION_ACTIVE,
} from "./lifecycle-admission.ts";
import {
	captureOperatorStopIntent,
	noteOperatorStopIntent,
} from "./operator-stop-intent.ts";
import {
	classifyStartFailure,
	type RetryPolicy,
	type SuppressionContext,
	typedStartFailure,
	typedUpdateInProgressFailure,
} from "./start-failure-taxonomy.ts";
import {
	ENGINE_TRANSITION_STOP_DEADLINE_MS,
	RECONFIGURE_DEADLINE_MS,
	STOP_DEADLINE_MS,
} from "./start-lifecycle-timing.ts";
import { withStreamLaunchOwnership } from "./stream-launch-ownership.ts";
import { bindStreamLiveness } from "./stream-liveness.ts";
import { createSessionCleanup } from "./stream-session-cleanup.ts";
import { createSessionOwnership } from "./stream-session-ownership.ts";
import { streamSessionProductionDeps } from "./stream-session-production.ts";
import {
	runStartWithRetry,
	type StartRetryDiagnostic,
} from "./stream-start-retry.ts";
import type { EngineRuntimeState } from "./streaming-backend.ts";

export {
	RECONFIGURE_STOP_TIMEOUT_REASON,
	STREAM_LAUNCH_ORIGINS,
	type StreamLaunchOrigin,
} from "./stream-session-contract.ts";

import {
	INTERNAL_LAUNCH_ORIGINS,
	RECONFIGURE_STOP_TIMEOUT_REASON,
	type StreamLaunchOrigin,
} from "./stream-session-contract.ts";

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
	readonly composition?:
		| import("@ceralive/cerastream").ChangeConfigParams["composition"]
		| null;
	readonly resolution?: string;
	readonly framerate?: number;
	readonly video_codec?: import("@ceralive/cerastream").ChangeConfigParams["codec"];
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
	readonly initialLiveness?: "idle" | "unknown" | (() => "idle" | "unknown");
	readonly createAttemptId: () => string;
	readonly setStreamingStatus: (streaming: boolean) => void;
	readonly getStreamingStatus?: () => boolean;
	readonly stopRuntime: (
		generation: number,
		confirmUnknown?: boolean,
	) => Promise<void>;
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
	readonly onStreamCommitted?: (current: () => boolean) => void;
	/**
	 * Called at that same commit point to ARM the restoration marker. It is a
	 * second hook rather than more work inside `onStreamCommitted` because the
	 * two answer different questions — one remembers which DEVICE went live, the
	 * other remembers that a stream WAS live — and each has to be provable on its
	 * own.
	 */
	readonly onStreamArmed?: (current: () => boolean) => void;
	/**
	 * Called with the operator-or-machine CAUSE of every stop, before the stop
	 * itself runs. The engine-loss path and an operator Stop reach the identical
	 * `stop()`, so without an explicit cause the marker cannot tell "the operator
	 * is done" from "the engine died" — and would either forget every crash or
	 * restart a stream the operator deliberately ended.
	 */
	readonly onStreamStopped?: (cause: StreamStopCause) => void;
	/**
	 * The LifecycleInterlock acquisition (`lifecycle-admission.ts`). ABSENT means
	 * "no interlock" — the lease is PROCESS-WIDE and `bun test` runs one process,
	 * so defaulting it on here would let any unit test that leaves a start
	 * pending strand every later test's admission. It is wired at the production
	 * singleton and proven through the real `streaming.start` procedure instead.
	 */
	readonly admitLifecycle?: () => LifecycleAdmission;
	/**
	 * The modem-mutation replay barrier, wired at the production singleton for
	 * the same process-wide-state reason as `admitLifecycle`.
	 *
	 * `awaitRecovery` is what an INTERNAL boot origin does instead of failing:
	 * restoration converts an unhandled refusal into a terminal `start_failed`
	 * and retires its one-shot marker, and autostart records a failed result with
	 * no retry — so refusing either of them during replay does not defer the boot
	 * intent, it destroys it. EXTERNAL arrivals get the typed `recovery_pending`
	 * refusal instead, which costs the caller only a retry.
	 */
	readonly awaitRecovery?: () => Promise<void>;
	readonly recoveryPending?: () => boolean;
	/**
	 * A modem whose failed rollback holds GLOBAL stream autostart. Fail-closed:
	 * the device cannot say what state that modem is in, so it does not bond it.
	 */
	readonly blockingMutation?: () => { readonly stableKey: string } | undefined;
	/**
	 * The update orchestrator's D8 admission check (Todo 37), consulted once
	 * every prior admission gate above has already passed — see the ordering
	 * note on `admittedStart` below for why. ABSENT means "no update
	 * orchestrator wired" (test default), matching every other admission dep
	 * on this type.
	 */
	readonly admitUpdate?: () => Promise<StreamStartUpdateAdmission>;
	/**
	 * Sets/clears `/run/ceralive/streaming` — the same sentinel the image-side
	 * `ceralive-rauc-activate.sh` (Todo 28) checks before staging an OTA
	 * activation. Set once this launch is genuinely proceeding (past every
	 * admission gate); retained through parked, failed and unknown stops.
	 * Cleared only after confirmed idle/cleanup or a failed launch that never
	 * went live; reconciliation synchronizes it with authoritative engine truth.
	 */
	readonly markStreamingForOta?: (() => boolean) | (() => void);
	readonly unmarkStreamingForOta?: (() => boolean) | (() => void);
};

type ActiveAttempt = {
	readonly attemptId: string;
	readonly generation: number;
	cancelled: boolean;
	launchAdmitted: boolean;
	cancelCause?: StreamStopCause;
	cancelStop?: Promise<boolean>;
	cancelRetryWait?: () => void;
};

type ActiveConfigChange = {
	readonly attemptId: string;
	settled: boolean;
	readonly settle: (outcome: EngineConfigChangeOutcome) => void;
};

type QueuedStop = {
	readonly promise: Promise<StopResult>;
	readonly cause: StreamStopCause;
	readonly release: (result: StopResult | Promise<StopResult>) => void;
	readonly cancelDeadline: () => void;
};

export type StreamSessionOrchestrator = {
	readonly streamLiveness: () => "streaming" | "idle" | "unknown";
	readonly start: (request: StreamStartRequest) => Promise<StartResult>;
	readonly stop: (cause: StreamStopCause) => Promise<StopResult>;
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
	readonly noteEngineStatus: (
		event: Extract<EventParams, { type: "status" }>,
	) => void;
};

export function createStreamSessionOrchestrator(
	deps: StreamSessionOrchestratorDeps,
): StreamSessionOrchestrator {
	const ownership = createSessionOwnership(deps);
	let active: ActiveAttempt | undefined;
	let reconciliationEpoch = 0;
	let runtimeObservations = 0;
	let activeChange: ActiveConfigChange | undefined;
	let queuedStop: QueuedStop | undefined;
	let engineTransitionLatched = false;
	let engineTransitionTimer:
		| ReturnType<typeof globalThis.setTimeout>
		| number
		| undefined;
	let engineQueuedStop: QueuedStop | undefined;
	let stopFlight: Promise<StopResult> | undefined;
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

	const cleanup = createSessionCleanup(deps, {
		schedule: scheduleTimeout,
		cancel: cancelTimeout,
		deadlineMs: stopDeadlineMs,
	});
	const stopWithinDeadline = cleanup.run;
	const transition = ownership.transition;

	const finishCancelled = async (
		attempt: ActiveAttempt,
		liveness: "idle" | "unknown",
	): Promise<StartResult> => {
		if (active !== attempt)
			return { result: "cancelled", attemptId: attempt.attemptId };
		const owner = ownership.capture();
		try {
			if (liveness !== "idle" || (await attempt.cancelStop) !== true)
				await stopWithinDeadline(
					attempt.generation,
					attempt.cancelCause === "operator",
				);
			if (active === attempt && ownership.commit(owner, "idle", "idle"))
				active = undefined;
		} catch (error) {
			if (ownership.owns(owner)) {
				if (ownership.state === "stopping") transition("stop_failed");
				ownership.commit(owner, "reconciling", "unknown");
			}
			logger.warn("cancelled stream cleanup remains unknown", {
				attemptId: attempt.attemptId,
				error,
			});
		}
		return { result: "cancelled", attemptId: attempt.attemptId };
	};

	const refuseStart = (
		attemptId: string,
		failureClass: StartFailureClass,
		code: string,
	): StartResult => ({
		result: "failed",
		attemptId,
		failure: typedStartFailure(attemptId, "params", failureClass, code),
	});

	const start = async (request: StreamStartRequest): Promise<StartResult> => {
		const currentIntent = captureOperatorStopIntent();
		const attemptId = deps.createAttemptId();

		// The barrier is consulted BEFORE the duplicate-start check, because it is
		// the only gate whose internal answer is to WAIT: awaiting first means an
		// internal origin is judged against the state replay left behind rather
		// than the one it raced.
		if (INTERNAL_LAUNCH_ORIGINS.has(request.origin)) {
			await deps.awaitRecovery?.();
		} else if (deps.recoveryPending?.() === true) {
			return refuseStart(attemptId, "recovery_pending", "recovery_pending");
		}

		if (!currentIntent()) return { result: "cancelled", attemptId };
		const blocked = deps.blockingMutation?.();
		if (blocked !== undefined) {
			return refuseStart(attemptId, "mutation_blocked", blocked.stableKey);
		}
		if (
			ownership.generation === 0 &&
			ownership.state === "reconciling" &&
			runtimeObservations === 0 &&
			!cleanup.pending &&
			stopFlight === undefined
		)
			await reconcile();
		if (
			!cleanup.pending &&
			stopFlight === undefined &&
			!ownership.launchPending &&
			ownership.state === "streaming" &&
			deps.getStreamingStatus?.() === false
		)
			await reconcile();

		if (!currentIntent()) return { result: "cancelled", attemptId };
		if (
			ownership.state !== "idle" ||
			ownership.streamLiveness() !== "idle" ||
			cleanup.pending ||
			stopFlight !== undefined ||
			ownership.launchPending
		)
			return { result: "busy", attemptId };

		// The interlock is consulted HERE and nowhere else: after the
		// duplicate-start rejection above (so a genuine duplicate keeps its own
		// `busy` → START_IN_PROGRESS rather than decaying into a generic
		// lease-busy answer) and before the attempt goes in-flight below, because
		// a modem re-enumeration admitted alongside it would tear a bond link out
		// from under a launch that has already spawned the sender.
		const admitLifecycle = deps.admitLifecycle;
		if (admitLifecycle === undefined)
			return await admittedStart(attemptId, request);

		const admission = admitLifecycle();
		if (!admission.admitted) {
			// `start_invalid` renders as "check your settings", which is wrong
			// advice for a modem that is re-enumerating — nothing is misconfigured.
			const failureClass =
				admission.refusal === MODEM_TRANSITION_ACTIVE
					? "modem_transition_active"
					: "start_invalid";
			return {
				result: "failed",
				attemptId,
				failure: typedStartFailure(
					attemptId,
					"params",
					failureClass,
					admission.refusal,
				),
			};
		}
		return await releasingLease(admission.lease, () =>
			admittedStart(attemptId, request),
		);
	};

	/**
	 * The lease is released on EVERY exit of the admission — including a throw —
	 * so a launch that blows up mid-flight can never leave a modem transition
	 * permanently refused.
	 */
	const releasingLease = async (
		lease: LifecycleLease,
		run: () => Promise<StartResult>,
	): Promise<StartResult> => {
		try {
			return await run();
		} finally {
			lease.release();
		}
	};

	const admittedStart = async (
		attemptId: string,
		request: StreamStartRequest,
	): Promise<StartResult> => {
		const owner = ownership.begin();
		const attempt: ActiveAttempt = {
			attemptId,
			generation: owner.generation,
			cancelled: false,
			launchAdmitted: false,
		};
		active = attempt;
		transition("starting");
		// D8 may yield even on an idle device. Stop must own this generation
		// before that await, and a cancelled admission must never mark or launch.
		try {
			const updateAdmission =
				deps.admitUpdate === undefined ? undefined : await deps.admitUpdate();
			if (attempt.cancelled || active !== attempt || !ownership.owns(owner))
				return { result: "cancelled", attemptId };
			if (updateAdmission !== undefined && !updateAdmission.allowed) {
				return {
					result: "failed",
					attemptId,
					failure: typedUpdateInProgressFailure(attemptId, updateAdmission),
				};
			}
			attempt.launchAdmitted = true;
		} finally {
			if (
				!attempt.launchAdmitted &&
				active === attempt &&
				ownership.owns(owner)
			) {
				if (transition("idle")) active = undefined;
			}
		}
		ownership.protect();
		const deadlineCancelledLaunches = new Set<number>();

		const launchResult = await runStartWithRetry({
			attemptId,
			launch: (launchNumber) => {
				const context: StreamLaunchContext = {
					attemptId,
					generation: attempt.generation,
					origin: request.origin,
					cancelled: () =>
						attempt.cancelled ||
						active !== attempt ||
						deadlineCancelledLaunches.has(launchNumber),
				};
				return ownership.trackLaunch(
					withStreamLaunchOwnership(context, () => request.launch(context)),
				);
			},
			classifyUnknown: (error) =>
				classifyStartFailure("start-rpc", error, attemptId, {
					warn: (message, meta) => logger.warn(message, meta),
				}),
			cancelled: () => attempt.cancelled || active !== attempt,
			onLaunchTimeout: async (launchNumber) => {
				deadlineCancelledLaunches.add(launchNumber);
				if (active !== attempt) return;
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
			return await finishCancelled(attempt, launchResult.liveness);
		}
		if (launchResult.result === "failed") {
			if (active !== attempt || !ownership.owns(owner))
				return { result: "cancelled", attemptId };
			if (launchResult.liveness === "unknown") {
				ownership.commit(owner, "reconciling", "unknown");
			} else if (ownership.commit(owner, "idle", "idle")) active = undefined;
			return {
				result: "failed",
				attemptId,
				failure: launchResult.failure,
			};
		}
		if (
			active !== attempt ||
			!ownership.commit(owner, "streaming", "streaming")
		)
			return { result: "cancelled", attemptId };
		// Never let a bookkeeping failure turn a stream that IS live into a
		// reported start failure.
		try {
			deps.onStreamCommitted?.(
				() => active === attempt && ownership.owns(owner),
			);
		} catch (error) {
			logger.warn("stream commit bookkeeping failed", { attemptId, error });
		}
		try {
			deps.onStreamArmed?.(() => active === attempt && ownership.owns(owner));
		} catch (error) {
			logger.warn("stream restoration arming failed", { attemptId, error });
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
	const parkStop = (cause: StreamStopCause): QueuedStop => {
		let release!: (result: StopResult | Promise<StopResult>) => void;
		const promise = new Promise<StopResult>((resolve) => {
			release = resolve;
		});
		const attemptId = activeChange?.attemptId;
		const owner = ownership.capture();
		const budgetMs = reconfigureDeadlineMs + stopDeadlineMs;

		const timer = scheduleTimeout(() => {
			if (queuedStop?.promise !== promise || !ownership.owns(owner)) return;
			queuedStop = undefined;
			logger.error(
				"stream stop parked behind a config change was never released",
				{
					attemptId,
					budgetMs,
					state: ownership.state,
				},
			);
			// The transaction outlived every bound it declared, so the engine's
			// real state is unknown to us — adopt its truth rather than assert one.
			if (ownership.commit(owner, "reconciling", "unknown")) void reconcile();
			release({
				result: "stop_failed",
				reason: RECONFIGURE_STOP_TIMEOUT_REASON,
			});
		}, budgetMs);

		logger.warn("stream stop parked behind an in-flight config change", {
			attemptId,
			budgetMs,
		});
		return {
			promise,
			cause,
			release,
			cancelDeadline: () => cancelTimeout(timer),
		};
	};

	const releaseEngineStop = (): void => {
		const pending = engineQueuedStop;
		if (pending === undefined) return;
		engineQueuedStop = undefined;
		pending.cancelDeadline();
		pending.release(stop(pending.cause));
	};

	const clearEngineTransition = (): void => {
		engineTransitionLatched = false;
		if (engineTransitionTimer !== undefined)
			cancelTimeout(engineTransitionTimer);
		engineTransitionTimer = undefined;
		releaseEngineStop();
	};

	const noteEngineStatus = (
		event: Extract<EventParams, { type: "status" }>,
	): void => {
		if (event.state === "idle" && event.streaming === false) {
			if (
				(ownership.state === "streaming" ||
					ownership.state === "stop_failed" ||
					ownership.state === "idle" ||
					ownership.state === "reconciling") &&
				!cleanup.pending &&
				!ownership.launchPending
			) {
				const owner = ownership.invalidate();
				if (
					transition("reconciling") &&
					ownership.commit(owner, "idle", "idle")
				)
					active = undefined;
			}
			clearEngineTransition();
			return;
		}
		if (
			event.state === "streaming" &&
			event.streaming &&
			ownership.state === "streaming"
		)
			ownership.protect();
		if (event.active_encode?.capture?.transition !== undefined) {
			if (!engineTransitionLatched) {
				engineTransitionLatched = true;
				const timer = scheduleTimeout(() => {
					if (engineTransitionTimer === timer) clearEngineTransition();
				}, INTERNAL_TRANSITION_WORST_CASE_BOUND_MS);
				engineTransitionTimer = timer;
			}
		} else if (event.streaming && event.active_encode !== undefined) {
			clearEngineTransition();
		}
	};

	const parkEngineStop = (cause: StreamStopCause): QueuedStop => {
		let resolveStop:
			| ((result: StopResult | Promise<StopResult>) => void)
			| undefined;
		const promise = new Promise<StopResult>((resolve) => {
			resolveStop = resolve;
		});
		const timer = scheduleTimeout(() => {
			if (engineQueuedStop?.promise === promise) clearEngineTransition();
		}, ENGINE_TRANSITION_STOP_DEADLINE_MS);
		logger.warn("stream stop parked behind an engine capture transition", {
			budgetMs: ENGINE_TRANSITION_STOP_DEADLINE_MS,
		});
		return {
			promise,
			cause,
			release: (result) => resolveStop?.(result),
			cancelDeadline: () => cancelTimeout(timer),
		};
	};

	const stop = (cause: StreamStopCause): Promise<StopResult> => {
		if (cause === "operator") noteOperatorStopIntent();
		deps.onStreamStopped?.(cause);
		if (cause === "operator") {
			if (active?.cancelled) active.cancelCause = cause;
			if (queuedStop !== undefined) queuedStop = { ...queuedStop, cause };
			if (engineQueuedStop !== undefined)
				engineQueuedStop = { ...engineQueuedStop, cause };
		}
		if (stopFlight !== undefined) return stopFlight;
		const reserved = Promise.withResolvers<StopResult>();
		stopFlight = reserved.promise;
		const retire = () => {
			if (stopFlight === reserved.promise) stopFlight = undefined;
		};
		void runStop(cause).then(
			(result) => {
				retire();
				reserved.resolve(result);
			},
			(error: unknown) => {
				retire();
				reserved.reject(error);
			},
		);
		return reserved.promise;
	};
	const runStop = async (cause: StreamStopCause): Promise<StopResult> => {
		const intentOwner = ownership.capture();
		void import("./capture-resilience.ts").then(({ noteCaptureStatus }) => {
			if (ownership.owns(intentOwner)) noteCaptureStatus(undefined, false);
		});
		// A change transaction already owns the engine's lifecycle mutex and the
		// capture hardware. Racing a 12 s stop deadline against it would report a
		// healthy 65 s transaction as `stop_failed`, so the stop WAITS and is then
		// answered against whatever state the transaction actually settled into.
		if (ownership.state === "reconfiguring") {
			stopFlight = undefined;
			if (queuedStop === undefined) queuedStop = parkStop(cause);
			return queuedStop.promise;
		}
		if (engineTransitionLatched) {
			stopFlight = undefined;
			if (engineQueuedStop === undefined)
				engineQueuedStop = parkEngineStop(cause);
			return engineQueuedStop.promise;
		}
		if (ownership.state === "idle" && ownership.streamLiveness() !== "idle")
			ownership.commit(ownership.capture(), "reconciling", "unknown");
		if (ownership.state === "idle") {
			ownership.commit(ownership.capture(), "idle", "idle");
			return { result: "stopped" };
		}
		if (ownership.state === "reconciling") {
			reconciliationEpoch += 1;
			const owner = ownership.invalidate();
			try {
				await stopWithinDeadline(
					active?.generation ?? ownership.generation,
					cause === "operator",
				);
			} catch (error) {
				const reason = error instanceof Error ? error.message : "stop_failed";
				logger.error("stream stop failed during reconciliation", { reason });
				return { result: "stop_failed", reason };
			}
			if (!ownership.launchPending && ownership.commit(owner, "idle", "idle"))
				active = undefined;
			return { result: "stopped" };
		}

		const stoppedGeneration = active?.generation ?? ownership.generation;
		const cancellingStart = ownership.state === "starting";
		if (cancellingStart && active !== undefined) {
			active.cancelled = true;
			active.cancelCause = cause;
			active.cancelRetryWait?.();
			if (!active.launchAdmitted) {
				ownership.invalidate();
				if (transition("idle")) active = undefined;
				return { result: "stopped" };
			}
		}
		if (!transition("stopping")) {
			return {
				result: "stop_failed",
				reason: "illegal_lifecycle_transition",
			};
		}
		const owner = ownership.invalidate();

		try {
			const stopping = stopWithinDeadline(
				stoppedGeneration,
				cause === "operator",
			);
			if (cancellingStart && active !== undefined)
				active.cancelStop = stopping.then(
					() => true,
					() => false,
				);
			await stopping;
			if (!cancellingStart && ownership.commit(owner, "idle", "idle"))
				active = undefined;
			return { result: "stopped" };
		} catch (error) {
			ownership.commit(owner, "stop_failed", "unknown");
			const reason = error instanceof Error ? error.message : "stop_failed";
			logger.error(
				reason === "stop_timeout"
					? "stream stop did not settle within its deadline"
					: "stream stop failed",
				{
					generation: stoppedGeneration,
					deadlineMs: stopDeadlineMs,
					reason,
				},
			);
			return { result: "stop_failed", reason };
		}
	};

	const reconcile = async (): Promise<LifecycleState> => {
		if (stopFlight !== undefined || cleanup.pending || ownership.launchPending)
			return ownership.state;
		// `stop_failed` is included deliberately: a stop we could not confirm
		// leaves the engine's real state UNKNOWN to us, and adopting its truth is
		// the only way out. Without this the state latches — `start` refuses while
		// the stale streaming status stands, and every later cycle is lost.
		if (
			ownership.state !== "idle" &&
			ownership.state !== "streaming" &&
			ownership.state !== "reconciling" &&
			ownership.state !== "stop_failed"
		)
			return ownership.state;
		const owner = ownership.invalidate();
		if (!ownership.commit(owner, "reconciling", "unknown"))
			return ownership.state;
		const epoch = ++reconciliationEpoch;
		runtimeObservations++;
		let runtimeState: EngineRuntimeState;
		try {
			runtimeState = await withRuntimeObservationOwner(
				() => ownership.owns(owner),
				deps.queryRuntime,
				ownership.protect,
			).catch(() => "unknown" as const);
		} finally {
			runtimeObservations--;
		}
		if (
			epoch !== reconciliationEpoch ||
			!ownership.owns(owner) ||
			cleanup.pending ||
			stopFlight !== undefined
		)
			return ownership.state;
		if (
			runtimeState !== "unknown" &&
			ownership.commit(owner, runtimeState, runtimeState) &&
			runtimeState === "idle"
		)
			active = undefined;
		if (runtimeState === "unknown")
			ownership.settleUnprotectedObservation(owner);
		return ownership.state;
	};

	const releaseQueuedStop = (): boolean => {
		const pending = queuedStop;
		if (pending === undefined) return false;
		queuedStop = undefined;
		pending.cancelDeadline();
		pending.release(stop(pending.cause));
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
			ownership.commit(ownership.capture(), "streaming", "streaming");
			return ownership.state;
		}
		if (
			outcome.reason === CONFIG_CHANGE_REASON_DEADLINE ||
			outcome.reason === "engine_connection_lost"
		) {
			// The transaction outlived its own declared bound, so the engine's state
			// is genuinely unknown to us — adopt its truth rather than assert one.
			ownership.commit(ownership.capture(), "reconciling", "unknown");
			return ownership.state;
		}
		// Every other rollback_failed is the engine telling us it gave up and went
		// Idle (the `teardown_timeout` escalation is the canonical case). This is
		// a genuine stream-end that never routes through stop() — clear the OTA
		// sentinel here too.
		if (ownership.commit(ownership.capture(), "idle", "idle"))
			active = undefined;
		return ownership.state;
	};

	const changeConfig = async (
		delta: StreamConfigChangeDelta,
	): Promise<ConfigChangeResult> => {
		const runChange = deps.changeRuntimeConfig;
		if (runChange === undefined)
			return { result: "rejected", reason: "change_config_unsupported" };
		if (
			ownership.state !== "streaming" ||
			activeChange !== undefined ||
			cleanup.pending ||
			stopFlight !== undefined
		)
			return { result: "busy" };

		const attemptId = deps.createAttemptId();
		if (!transition("reconfiguring")) return { result: "busy" };
		const owner = ownership.invalidate();

		let settleObserved!: (outcome: EngineConfigChangeOutcome) => void;
		const observed = new Promise<EngineConfigChangeOutcome>((resolve) => {
			settleObserved = resolve;
		});
		const change: ActiveConfigChange = {
			attemptId,
			settled: false,
			settle: (outcome) => {
				if (change.settled || activeChange !== change || !ownership.owns(owner))
					return;
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

		const dispatched = (async () => runChange(delta, attemptId))().then(
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
			if (activeChange === change) activeChange = undefined;
		}
		if (!ownership.owns(owner)) return { result: "busy" };

		const settled = settleConfigChangeState(outcome);
		deps.publishConfigChangePhase?.({
			attemptId,
			phase: outcome.phase,
			...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
		});

		const hadQueuedStop = releaseQueuedStop();
		if (!hadQueuedStop && settled === "reconciling") await reconcile();

		if (outcome.phase === "applied") return { result: "applied", attemptId };
		return {
			result: outcome.phase === "reverted" ? "reverted" : "rollback_failed",
			attemptId,
			...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
		};
	};

	return {
		streamLiveness: ownership.streamLiveness,
		start,
		stop,
		reconcile,
		snapshot: () => ({
			state: ownership.state,
			generation: ownership.generation,
		}),
		changeConfig,
		noteConfigChangePhase,
		noteEngineStatus,
	};
}

const productionOrchestrator = createStreamSessionOrchestrator(
	streamSessionProductionDeps,
);
bindStreamLiveness(productionOrchestrator.streamLiveness);

export function startStreamSession(
	request: StreamStartRequest,
): Promise<StartResult> {
	return productionOrchestrator.start(request);
}

export function stopStreamSession(cause: StreamStopCause): Promise<StopResult> {
	return productionOrchestrator.stop(cause);
}

export function reconcileStreamSession(): Promise<LifecycleState> {
	return productionOrchestrator.reconcile();
}

export function getStreamSessionSnapshot(): StreamSessionSnapshot {
	return productionOrchestrator.snapshot();
}

export function streamLiveness(): "streaming" | "idle" | "unknown" {
	return productionOrchestrator.streamLiveness();
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

export function noteStreamSessionEngineStatus(
	event: Extract<EventParams, { type: "status" }>,
): void {
	productionOrchestrator.noteEngineStatus(event);
}
