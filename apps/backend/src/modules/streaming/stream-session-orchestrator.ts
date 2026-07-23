import {
	isLegalLifecycleTransition,
	type LifecycleState,
	type StartResult,
	type StopResult,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import { queryEngineRuntimeStreaming } from "./engine-runtime-state.ts";
import {
	classifyStartFailure,
	newAttemptId,
	StreamStartFailure,
} from "./start-failure-taxonomy.ts";
import { STOP_DEADLINE_MS } from "./start-lifecycle-timing.ts";
import { updateStreamLifecycleState } from "./stream-lifecycle-status.ts";
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
	readonly scheduleTimeout?: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof globalThis.setTimeout> | number;
	readonly cancelTimeout?: (
		timer: ReturnType<typeof globalThis.setTimeout> | number,
	) => void;
};

type ActiveAttempt = {
	readonly attemptId: string;
	readonly generation: number;
	cancelled: boolean;
};

export type StreamSessionOrchestrator = {
	readonly start: (request: StreamStartRequest) => Promise<StartResult>;
	readonly stop: () => Promise<StopResult>;
	readonly reconcile: () => Promise<LifecycleState>;
	readonly snapshot: () => StreamSessionSnapshot;
};

export function createStreamSessionOrchestrator(
	deps: StreamSessionOrchestratorDeps,
): StreamSessionOrchestrator {
	let state: LifecycleState = "idle";
	let generation = 0;
	let active: ActiveAttempt | undefined;
	let reconciliationEpoch = 0;
	const stopDeadlineMs = deps.stopDeadlineMs ?? STOP_DEADLINE_MS;
	const scheduleTimeout =
		deps.scheduleTimeout ??
		((callback: () => void, delayMs: number) =>
			globalThis.setTimeout(callback, delayMs));
	const cancelTimeout =
		deps.cancelTimeout ??
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
		const context: StreamLaunchContext = {
			attemptId,
			generation: attempt.generation,
			origin: request.origin,
			cancelled: () => attempt.cancelled,
		};

		try {
			await request.launch(context);
			if (attempt.cancelled || active !== attempt) {
				return await finishCancelled(attempt);
			}
			transition("streaming");
			deps.setStreamingStatus(true);
			return { result: "started", attemptId };
		} catch (error) {
			if (attempt.cancelled || active !== attempt) {
				return await finishCancelled(attempt);
			}
			transition("idle");
			active = undefined;
			deps.setStreamingStatus(false);
			return {
				result: "failed",
				attemptId,
				failure:
					error instanceof StreamStartFailure
						? error.failure
						: classifyStartFailure("start-rpc", error, attemptId, {
								warn: (message, meta) => logger.warn(message, meta),
							}),
			};
		}
	};

	const stop = async (): Promise<StopResult> => {
		if (state === "idle") return { result: "stopped" };
		if (state === "reconciling") {
			reconciliationEpoch += 1;
			transition("idle");
			deps.setStreamingStatus(false);
			return { result: "stopped" };
		}

		const stoppedGeneration = active?.generation ?? generation;
		const cancellingStart = state === "starting";
		if (cancellingStart && active !== undefined) active.cancelled = true;
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
			return {
				result: "stop_failed",
				reason: error instanceof Error ? error.message : "stop_failed",
			};
		}
	};

	const reconcile = async (): Promise<LifecycleState> => {
		if (state !== "idle" && state !== "streaming" && state !== "reconciling")
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

	return {
		start,
		stop,
		reconcile,
		snapshot: () => ({ state, generation }),
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
