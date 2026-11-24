/**
 * Toast copy for a typed start failure (Todo 29). The class, or for
 * `capture_source_unavailable` its cause, names WHAT failed; a suffix names the
 * retry state. The engine's raw diagnostic is deliberately never appended: it
 * reaches the backend logger and Settings → System Logs instead.
 *
 * `update_in_progress` is neither "kept failing after retries" nor "won't
 * recover by retrying": it clears by itself when the update finishes, so its
 * suffix tells the operator to start again then (C-m2). Nothing here retries
 * automatically; `retriable` stays the backend's verdict.
 */
import { m } from "@ceraui/i18n/svelte";
import type { StartFailure } from "@ceraui/rpc/schemas";

type StartFailureCopyInput = Pick<
	StartFailure,
	"class" | "retriable" | "captureCause" | "phase" | "code"
>;

/** The retry-state suffix's key; two of the three send the operator to System Logs. */
/**
 * What the operator can do next, as one button on the toast. A refusal that
 * used to end in "Open Settings → System Logs" now ends in an action:
 *
 * - the engine classes and a start timeout: Try again, and Restart box when
 *   the same kind of failure comes back right after a retry;
 * - `start_invalid`: Open stream setup;
 * - `mutation_blocked`: Open Network, where the modem controls live.
 *
 * Every other class keeps its existing copy and View logs.
 */
type StartFailureNextStep =
	| "tryAgain"
	| "restartBox"
	| "openSetup"
	| "openNetwork";

function startFailureNextStep(
	failure: StartFailureCopyInput,
	repeated: boolean,
	admitted: boolean,
): StartFailureNextStep | "blockedEngine" | undefined {
	switch (failure.class) {
		case "engine_unavailable":
		case "start_timeout":
			if (!admitted) return "blockedEngine";
			if (repeated) return "restartBox";
			return failure.phase === "connect" ||
				(failure.class === "engine_unavailable" && failure.phase === "hello")
				? "tryAgain"
				: "blockedEngine";
		case "engine_internal":
			if (!admitted || failure.code === -32002) return "blockedEngine";
			return repeated ? "restartBox" : "tryAgain";
		case "start_invalid":
			return "openSetup";
		case "mutation_blocked":
			return "openNetwork";
		case "engine_restarting":
		case "attempt_capacity":
		case "protocol_incompatible":
		case "audio_source_unavailable":
		case "modem_transition_active":
		case "recovery_pending":
		case "capture_source_unavailable":
		case "update_in_progress":
			return undefined;
	}
}

function classReason(failure: StartFailureCopyInput): string {
	if (
		failure.class === "capture_source_unavailable" &&
		failure.captureCause === undefined
	)
		return m["notifications.streamStartCaptureSourceUnavailableFailed"]();
	if (failure.class === "audio_source_unavailable")
		return m["notifications.streamStartAudioSourceUnavailableFailed"]();
	const key =
		failure.class === "mutation_blocked"
			? "live.startFailure.mutationBlockedNetwork"
			: failure.captureCause !== undefined
				? `live.startFailure.class.${failure.class}.${failure.captureCause}`
				: `live.startFailure.class.${failure.class}`;
	const cls = m[key];
	return typeof cls === "function" ? cls() : m["live.startFailed.generic"]();
}

export function startFailureMessage(
	failure: StartFailureCopyInput,
	repeated: boolean,
	admitted: boolean,
	blockedReason?: string,
) {
	if (failure.class === "attempt_capacity")
		return {
			step: undefined,
			message: m["notifications.streamStartAttemptCapacity"](),
		};
	const reason = classReason(failure);
	const next = startFailureNextStep(failure, repeated, admitted);
	if (next && next !== "blockedEngine") {
		return {
			step: next,
			message:
				next === "openNetwork"
					? reason
					: `${reason} ${m[`live.startFailure.next.${next}`]()}`,
		};
	}
	const logKey = `live.startFailure.${
		failure.class === "update_in_progress"
			? "waitForUpdate"
			: failure.retriable
				? "retriedThenFailed"
				: "notRetriable"
	}` as const;
	const suffix = (next === "blockedEngine" && blockedReason) || m[logKey]();
	return { step: undefined, message: `${reason} ${suffix}`, logKey };
}
