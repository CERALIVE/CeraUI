import type { StartFailureClass } from "@ceraui/rpc/schemas";

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

const RETRY_NOTIFICATION_KEYS = {
	engine_unavailable: "notifications.streamStartEngineUnavailableRetrying",
	engine_restarting: "notifications.streamStartEngineRestartingRetrying",
	start_timeout: "notifications.streamStartTimeoutRetrying",
} as const;

const RETRY_FALLBACK_MESSAGES = {
	engine_unavailable: "Streaming engine unavailable",
	engine_restarting: "Streaming engine is restarting",
	start_timeout: "Streaming engine did not answer in time",
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
	};

function notificationParams(
	diagnostic: StartRetryDiagnostic,
): Record<string, unknown> {
	return {
		attemptId: diagnostic.attemptId,
		phase: diagnostic.phase,
		class: diagnostic.class,
		...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
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
	notificationBroadcast(
		"stream_start_failed",
		"error",
		`Stream failed to start (${diagnostic.class}) after ${diagnostic.retry.attempt}/${diagnostic.retry.maxAttempts} attempts. Check journalctl -u cerastream.service.`,
		0,
		false,
		true,
		true,
		TERMINAL_NOTIFICATION_KEYS[diagnostic.class],
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
