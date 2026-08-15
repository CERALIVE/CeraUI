import type { MessageFn, MessageKey } from "@ceraui/i18n/svelte";
import {
	CONFIG_CHANGE_REASON_DEADLINE,
	CONFIG_CHANGE_REASON_ENGINE_LOST,
	CONFIG_CHANGE_REASON_REJECTED,
	CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT,
	type ConfigChangeResult,
} from "@ceraui/rpc/schemas";

/** The subset of the facade's `m` these pure helpers need: keyed lookup only. */
type Messages = Readonly<Record<MessageKey, MessageFn>>;

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
function reasonSentence(reason: string | undefined, msg: Messages): string {
	if (reason === CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT)
		return msg["live.encoder.applyPhase.reasonTeardownTimeout"]();
	if (reason === CONFIG_CHANGE_REASON_DEADLINE)
		return msg["live.encoder.applyPhase.reasonDeadlineExceeded"]();
	if (reason === CONFIG_CHANGE_REASON_ENGINE_LOST)
		return msg["live.encoder.applyPhase.reasonEngineLost"]();
	if (reason === CONFIG_CHANGE_REASON_REJECTED)
		return msg["live.encoder.applyPhase.reasonRejected"]();
	return msg["live.encoder.applyPhase.reasonUnknown"]();
}

export function configChangeReport(
	change: ConfigChangeResult,
	msg: Messages,
): ConfigChangeReport {
	if (change.result === "applied") {
		return {
			level: "success",
			message: msg["live.encoder.applyPhase.applied"](),
		};
	}
	if (change.result === "reverted") {
		return {
			level: "warning",
			message: `${msg["live.encoder.applyPhase.reverted"]()} ${reasonSentence(change.reason, msg)}`,
		};
	}
	if (change.result === "rollback_failed") {
		return {
			level: "error",
			message: `${msg["live.encoder.applyPhase.rollbackFailed"]()} ${reasonSentence(change.reason, msg)}`,
		};
	}
	// `busy` / `rejected` mean the transaction never started, so nothing about
	// the running stream changed — report it as a plain failed save.
	return { level: "error", message: msg["notifications.saveFailed"]() };
}
