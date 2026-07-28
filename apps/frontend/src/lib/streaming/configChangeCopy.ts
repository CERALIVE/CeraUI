import type { Svelte5Translation } from "@ceraui/i18n";
import {
	CONFIG_CHANGE_REASON_DEADLINE,
	CONFIG_CHANGE_REASON_ENGINE_LOST,
	CONFIG_CHANGE_REASON_REJECTED,
	CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT,
	type ConfigChangeResult,
} from "@ceraui/rpc/schemas";

export type ConfigChangeReport = {
	level: "success" | "warning" | "error";
	message: string;
};

/**
 * Resolve a keyed operator sentence for a machine reason.
 *
 * The engine's `reason` is a machine-stable token, never operator copy — the
 * repo's operator-copy gate exists because raw engine strings (ALSA device
 * paths, unit names) have shipped to an audience with no console. An unmapped
 * reason therefore points at the in-app log viewer rather than leaking itself.
 */
function reasonSentence(
	reason: string | undefined,
	LL: Svelte5Translation,
): string {
	const phase = LL.live.encoder.applyPhase;
	if (reason === CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT)
		return phase.reasonTeardownTimeout();
	if (reason === CONFIG_CHANGE_REASON_DEADLINE)
		return phase.reasonDeadlineExceeded();
	if (reason === CONFIG_CHANGE_REASON_ENGINE_LOST)
		return phase.reasonEngineLost();
	if (reason === CONFIG_CHANGE_REASON_REJECTED) return phase.reasonRejected();
	return phase.reasonUnknown();
}

export function configChangeReport(
	change: ConfigChangeResult,
	LL: Svelte5Translation,
): ConfigChangeReport {
	const phase = LL.live.encoder.applyPhase;
	if (change.result === "applied") {
		return { level: "success", message: phase.applied() };
	}
	if (change.result === "reverted") {
		return {
			level: "warning",
			message: `${phase.reverted()} ${reasonSentence(change.reason, LL)}`,
		};
	}
	if (change.result === "rollback_failed") {
		return {
			level: "error",
			message: `${phase.rollbackFailed()} ${reasonSentence(change.reason, LL)}`,
		};
	}
	// `busy` / `rejected` mean the transaction never started, so nothing about
	// the running stream changed — report it as a plain failed save.
	return { level: "error", message: LL.notifications.saveFailed() };
}
