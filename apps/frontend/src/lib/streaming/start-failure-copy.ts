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
import { type MessageKey, m } from "@ceraui/i18n/svelte";

export interface StartFailureCopyInput {
	readonly class: string;
	readonly retriable: boolean;
	readonly captureCause?: string;
}

/** The retry-state suffix's key; two of the three send the operator to System Logs. */
export function startFailureRetryKey(
	failure: StartFailureCopyInput,
): MessageKey {
	if (failure.class === "update_in_progress")
		return "live.startFailure.waitForUpdate";
	return failure.retriable
		? "live.startFailure.retriedThenFailed"
		: "live.startFailure.notRetriable";
}

export function startFailureMessage(failure: StartFailureCopyInput): string {
	const key =
		failure.captureCause !== undefined
			? `live.startFailure.class.${failure.class}.${failure.captureCause}`
			: `live.startFailure.class.${failure.class}`;
	const cls = m[key];
	const reason =
		typeof cls === "function" ? cls() : m["live.startFailed.generic"]();
	return `${reason} ${m[startFailureRetryKey(failure)]()}`;
}
