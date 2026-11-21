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
export type StartFailureNextStep =
	| "tryAgain"
	| "restartBox"
	| "openSetup"
	| "openNetwork";

const ENGINE_CLASSES: ReadonlySet<string> = new Set([
	"engine_internal",
	"engine_unavailable",
	"start_timeout",
]);

/** Whether a failure belongs to the engine group that escalates to Restart box. */
export function isEngineStartFailure(failure: StartFailureCopyInput): boolean {
	return ENGINE_CLASSES.has(failure.class);
}

export function startFailureNextStep(
	failure: StartFailureCopyInput,
	repeated = false,
): StartFailureNextStep | undefined {
	if (ENGINE_CLASSES.has(failure.class))
		return repeated ? "restartBox" : "tryAgain";
	if (failure.class === "start_invalid") return "openSetup";
	if (failure.class === "mutation_blocked") return "openNetwork";
	return undefined;
}

const NEXT_STEP_SUFFIX: Partial<Record<StartFailureNextStep, MessageKey>> = {
	tryAgain: "live.startFailure.next.tryAgain",
	restartBox: "live.startFailure.next.restartBox",
	openSetup: "live.startFailure.next.openSetup",
};

export const NEXT_STEP_ACTION: Record<StartFailureNextStep, MessageKey> = {
	tryAgain: "live.startFailure.action.tryAgain",
	restartBox: "live.startFailure.action.restartBox",
	openSetup: "live.startFailure.action.openSetup",
	openNetwork: "live.startFailure.action.openNetwork",
};

function classReason(failure: StartFailureCopyInput): string {
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
	repeated = false,
): string {
	const reason = classReason(failure);
	const step = startFailureNextStep(failure, repeated);
	if (step !== undefined) {
		// The reason already names the fix for these two; the button carries it.
		const suffix = NEXT_STEP_SUFFIX[step];
		return suffix === undefined ? reason : `${reason} ${m[suffix]()}`;
	}
	return `${reason} ${m[startFailureRetryKey(failure)]()}`;
}
