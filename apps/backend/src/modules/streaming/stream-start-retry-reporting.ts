import type {
	StartFailureCaptureCause,
	StartFailureClass,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { isUpdating } from "../system/software-updates.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import {
	type CapabilitiesResult,
	getLastCapabilities,
} from "./capabilities.ts";
import {
	DEFAULT_START_RETRY_POLICY,
	type SuppressionContext,
} from "./start-failure-taxonomy.ts";
import type { StartRetryDiagnostic } from "./stream-start-retry.ts";

// `capture_source_unavailable` is retriable for exactly one of its causes
// (`device_busy`), so the retry copy names that condition directly rather than
// the class — a retry for any other cause is unreachable by construction.
const RETRY_NOTIFICATION_KEYS = {
	engine_unavailable: "notifications.streamStartEngineUnavailableRetrying",
	engine_restarting: "notifications.streamStartEngineRestartingRetrying",
	start_timeout: "notifications.streamStartTimeoutRetrying",
	capture_source_unavailable:
		"notifications.streamStartCaptureDeviceBusyRetrying",
} as const;

const RETRY_FALLBACK_MESSAGES = {
	engine_unavailable: "Streaming engine unavailable",
	engine_restarting: "Streaming engine is restarting",
	start_timeout: "Streaming engine did not answer in time",
	capture_source_unavailable: "The video input is busy",
} as const;

type RetryableStartClass = keyof typeof RETRY_NOTIFICATION_KEYS;

function isRetryableStartClass(
	failureClass: StartFailureClass,
): failureClass is RetryableStartClass {
	return failureClass in RETRY_NOTIFICATION_KEYS;
}

const TERMINAL_NOTIFICATION_KEYS: Readonly<Record<StartFailureClass, string>> =
	{
		engine_unavailable: "notifications.streamStartEngineUnavailableFailed",
		engine_restarting: "notifications.streamStartEngineRestartingFailed",
		start_timeout: "notifications.streamStartTimeoutFailed",
		start_invalid: "notifications.streamStartInvalidFailed",
		protocol_incompatible: "notifications.streamStartProtocolFailed",
		engine_internal: "notifications.streamStartInternalFailed",
		audio_source_unavailable:
			"notifications.streamStartAudioSourceUnavailableFailed",
		modem_transition_active:
			"notifications.streamStartModemTransitionActiveFailed",
		recovery_pending: "notifications.streamStartRecoveryPendingFailed",
		mutation_blocked: "notifications.streamStartMutationBlockedFailed",
		capture_source_unavailable:
			"notifications.streamStartCaptureSourceUnavailableFailed",
	};

// The class alone names no operator action — an unsupported signal format, a
// dead cable and a momentarily-held input want three different responses — so
// the terminal copy is selected by CAUSE. The class-level key above is the
// floor for a future engine that reports the class with no cause at all.
const CAPTURE_TERMINAL_NOTIFICATION_KEYS: Readonly<
	Record<StartFailureCaptureCause, string>
> = {
	negotiation_failed: "notifications.streamStartCaptureNegotiationFailed",
	no_signal: "notifications.streamStartCaptureNoSignalFailed",
	device_busy: "notifications.streamStartCaptureDeviceBusyFailed",
	"composition-unsupported":
		"notifications.streamStartCompositionUnsupportedFailed",
	"secondary-unavailable":
		"notifications.streamStartCompositionSecondaryUnavailableFailed",
};

const CAPTURE_TERMINAL_FALLBACK_MESSAGES: Readonly<
	Record<StartFailureCaptureCause, string>
> = {
	negotiation_failed:
		"Stream failed to start: the video input's signal format is not one this device can capture. Change the camera's HDMI output format, then start again.",
	no_signal:
		"Stream failed to start: the video input is not carrying a signal. Check the camera is on and the cable is connected, then start again.",
	device_busy:
		"Stream failed to start: the video input was busy and did not free up. Wait a moment, then start again.",
	"composition-unsupported":
		"Stream failed to start: this device cannot combine two video inputs. Turn off the Composition card, then start again.",
	"secondary-unavailable":
		"Stream failed to start: the second video input for the picture-in-picture layout is not available. Reconnect it or pick another one, then start again.",
};

function terminalNotificationKey(diagnostic: StartRetryDiagnostic): string {
	if (
		diagnostic.class === "capture_source_unavailable" &&
		diagnostic.captureCause !== undefined
	) {
		return CAPTURE_TERMINAL_NOTIFICATION_KEYS[diagnostic.captureCause];
	}
	return TERMINAL_NOTIFICATION_KEYS[diagnostic.class];
}

function terminalFallbackMessage(
	diagnostic: StartRetryDiagnostic,
): string | undefined {
	if (
		diagnostic.class === "capture_source_unavailable" &&
		diagnostic.captureCause !== undefined
	) {
		return CAPTURE_TERMINAL_FALLBACK_MESSAGES[diagnostic.captureCause];
	}
	return TERMINAL_FALLBACK_MESSAGES[diagnostic.class];
}

// A class whose terminal cause has nothing to do with the engine needs its own
// untranslated fallback — the generic one points at the in-app log viewer.
const TERMINAL_FALLBACK_MESSAGES: Partial<Record<StartFailureClass, string>> = {
	audio_source_unavailable:
		"Stream failed to start: the selected audio input is not available. Reconnect it or choose another audio source.",
	modem_transition_active:
		"Stream failed to start: a modem is switching USB mode and its link is about to change. Wait for the switch to finish, then start again.",
	recovery_pending:
		"Stream failed to start: the device is still finishing modem recovery after a restart. Try again in a moment.",
	mutation_blocked:
		"Stream failed to start: a modem change could not be undone, so its state is unknown. Review the blocked modem in Settings before streaming.",
	capture_source_unavailable:
		"Stream failed to start: the video input could not be used. Check the camera and cable, then start again.",
};

function notificationParams(
	diagnostic: StartRetryDiagnostic,
): Record<string, unknown> {
	return {
		attemptId: diagnostic.attemptId,
		phase: diagnostic.phase,
		class: diagnostic.class,
		...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
		...(diagnostic.message !== undefined
			? { message: diagnostic.message }
			: {}),
		...(diagnostic.captureCause !== undefined
			? { captureCause: diagnostic.captureCause }
			: {}),
		retryState: diagnostic.retry.state,
		attempt: diagnostic.retry.attempt,
		maxAttempts: diagnostic.retry.maxAttempts,
		...(diagnostic.retry.state === "scheduled"
			? {
					nextAttempt: diagnostic.retry.nextAttempt,
					delayMs: diagnostic.retry.delayMs,
					suppressed: diagnostic.retry.suppressed,
				}
			: { suppressed: false }),
	};
}

export function reportStartRetry(diagnostic: StartRetryDiagnostic): void {
	logger.warn("stream start retry scheduled", diagnostic);
	if (diagnostic.retry.state !== "scheduled" || diagnostic.retry.suppressed)
		return;
	if (!isRetryableStartClass(diagnostic.class)) {
		logger.error("stream start retry invariant violated", diagnostic);
		return;
	}
	const key = RETRY_NOTIFICATION_KEYS[diagnostic.class];
	notificationBroadcast(
		"stream_start_retry",
		"warning",
		`${RETRY_FALLBACK_MESSAGES[diagnostic.class]}; retrying (${diagnostic.retry.nextAttempt}/${diagnostic.retry.maxAttempts}).`,
		5,
		false,
		true,
		true,
		key,
		notificationParams(diagnostic),
	);
}

export function reportStartTerminalFailure(
	diagnostic: StartRetryDiagnostic,
): void {
	logger.error("stream start failed", diagnostic);
	notificationRemove("stream_start_retry");
	// Deliberately NOT persistent: a capture failure already has its own standing
	// mechanism (`hdmi_error`, raised and retracted by the signal watcher), and a
	// second permanent band for the same physical condition is one an operator
	// has to dismiss twice.
	notificationBroadcast(
		"stream_start_failed",
		"error",
		terminalFallbackMessage(diagnostic) ??
			`Stream failed to start (${diagnostic.class}) after ${diagnostic.retry.attempt}/${diagnostic.retry.maxAttempts} attempts. Open Settings → System Logs for details.`,
		0,
		false,
		true,
		true,
		terminalNotificationKey(diagnostic),
		notificationParams(diagnostic),
	);
}

type StartSuppressionSignals = {
	readonly softwareUpdateActive: boolean;
	readonly capabilities:
		| Pick<CapabilitiesResult, "engineUnavailable" | "engineStarting">
		| undefined;
	readonly uptimeMs: number;
};

export function deriveStartSuppressionContext(
	signals: StartSuppressionSignals,
): SuppressionContext {
	return {
		softwareUpdateActive: signals.softwareUpdateActive,
		engineRestartWindow:
			signals.capabilities?.engineUnavailable === true &&
			signals.capabilities.engineStarting !== true,
		bootWindow:
			signals.capabilities?.engineStarting === true ||
			signals.uptimeMs < DEFAULT_START_RETRY_POLICY.totalBudgetMs,
		cancelledByStop: false,
	};
}

export function getStartSuppressionContext(): SuppressionContext {
	return deriveStartSuppressionContext({
		softwareUpdateActive: isUpdating(),
		capabilities: getLastCapabilities(),
		uptimeMs: process.uptime() * 1_000,
	});
}
