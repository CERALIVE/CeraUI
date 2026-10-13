import { logger } from "../../helpers/logger.ts";
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

export const streamSessionProductionDeps: StreamSessionOrchestratorDeps = {
	initialLiveness: initialOtaStreamLiveness,
	createAttemptId: newAttemptId,
	setStreamingStatus: updateStatus,
	getStreamingStatus: getIsStreaming,
	stopRuntime: stopGeneration,
	queryRuntime: queryEngineRuntimeStreaming,
	seedLifecycleState: seedStreamLifecycleState,
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
	onStreamStopped: noteStreamStopped,
};
