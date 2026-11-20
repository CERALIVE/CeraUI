import { logger } from "../../helpers/logger.ts";
import { emitEvent } from "../events/emit.ts";
import { admitAndPrepareStreamStart } from "../system/update-orchestrator/runtime.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import { noteStreamStopped } from "./armed-stream-marker.ts";
import { asrcProbeRemainingMs } from "./audio.ts";
import {
	broadcastConfigChangePhase,
	changeEngineRuntimeConfig,
} from "./config-change-bridge.ts";
import { queryEngineRuntimeStreaming } from "./engine-runtime-state.ts";
import {
	streamingBlockingMutation,
	tryAcquireLifecycle,
} from "./lifecycle-admission.ts";
import {
	clearOtaStreamingMarker,
	initialOtaStreamLiveness,
	setOtaStreamingMarker,
} from "./ota-streaming-marker.ts";
import { awaitRecoveryBarrier, isRecoveryPending } from "./recovery-barrier.ts";
import { newAttemptId } from "./start-failure-taxonomy.ts";
import {
	getStreamLifecycleState,
	seedStreamLifecycleState,
	updateStreamLifecycleState,
} from "./stream-lifecycle-status.ts";
import type { StreamSessionOrchestratorDeps } from "./stream-session-orchestrator.ts";
import {
	getStartSuppressionContext,
	reportStartRetry,
	reportStartTerminalFailure,
} from "./stream-start-retry-reporting.ts";
import { getIsStreaming, updateStatus } from "./streaming.ts";
import { stopGeneration } from "./streamloop/session.ts";

function recordEvent(publish: () => void): void {
	try {
		publish();
	} catch {
		// Event history must not alter stream control or later hooks.
	}
}

let streamStartedAt: number | undefined;

export const streamSessionProductionDeps: StreamSessionOrchestratorDeps = {
	initialLiveness: initialOtaStreamLiveness,
	createAttemptId: newAttemptId,
	setStreamingStatus: updateStatus,
	getStreamingStatus: getIsStreaming,
	stopRuntime: stopGeneration,
	queryRuntime: queryEngineRuntimeStreaming,
	seedLifecycleState: (state) => {
		streamStartedAt = undefined;
		seedStreamLifecycleState(state);
	},
	setLifecycleState: (state) => {
		const previous = getStreamLifecycleState();
		updateStreamLifecycleState(state);
		if (previous === "starting" && state === "streaming") {
			streamStartedAt = Date.now();
			recordEvent(() => emitEvent("stream_started", {}));
		}
		if (previous !== "stop_failed" && state === "stop_failed")
			recordEvent(() => emitEvent("stream_stop_failed", {}));
		if (
			previous === "reconfiguring" &&
			(state === "streaming" || state === "idle" || state === "reconciling")
		)
			recordEvent(() => emitEvent("stream_reconfigured", { outcome: state }));
	},
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
	pendingGateRemainingMs: () => asrcProbeRemainingMs(),
	suppressionContext: getStartSuppressionContext,
	reportRetry: reportStartRetry,
	reportTerminalFailure: reportStartTerminalFailure,
	changeRuntimeConfig: changeEngineRuntimeConfig,
	publishConfigChangePhase: broadcastConfigChangePhase,
	// Lazy graph edges retain initialization order; ownership is checked after import.
	onStreamCommitted: (current) => {
		void import("./sources.ts")
			.then(({ noteStreamedSourceCommitted }) => {
				if (current()) noteStreamedSourceCommitted();
			})
			.catch((error) =>
				logger.warn("stream commit bookkeeping failed", { error }),
			);
	},
	onStreamArmed: (current) => {
		void import("./stream-restoration.ts")
			.then(({ armStreamRestoration }) => {
				if (current()) armStreamRestoration();
			})
			.catch((error) =>
				logger.warn("stream restoration arming failed", { error }),
			);
	},
	admitLifecycle: () => tryAcquireLifecycle("streaming"),
	awaitRecovery: awaitRecoveryBarrier,
	recoveryPending: isRecoveryPending,
	blockingMutation: streamingBlockingMutation,
	admitUpdate: admitAndPrepareStreamStart,
	markStreamingForOta: setOtaStreamingMarker,
	unmarkStreamingForOta: clearOtaStreamingMarker,
	onStreamStopped: (cause) => {
		noteStreamStopped(cause);
		recordEvent(() =>
			emitEvent("stream_stopped", {
				cause,
				durationSec:
					streamStartedAt === undefined
						? 0
						: Math.max(0, (Date.now() - streamStartedAt) / 1000),
			}),
		);
		streamStartedAt = undefined;
	},
};
