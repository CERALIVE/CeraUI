/**
 * "Applies on next start" labelling — a thin, PURE labelling layer over the
 * restart-required policy in {@link ./streamingLockPolicy}.
 *
 * It changes NO lock logic: it only answers "should the UI badge this edited
 * field as taking effect on the next stream start?". A restart-required field
 * edited while a stream is LIVE cannot apply mid-stream, so the dialog surfaces a
 * calm `⟳ Applies on next start` hint next to it instead of silently deferring.
 */

import { RESTART_REQUIRED_FIELDS } from "./streamingLockPolicy";

const restartRequiredSet: ReadonlySet<string> = new Set(
	RESTART_REQUIRED_FIELDS,
);

/**
 * True when `field` is restart-required AND has been edited AND a stream is live
 * — the exact condition for the "applies on next start" indicator. False in
 * every other case (not streaming, untouched, or a hot-changeable field).
 */
export function appliesOnNextStart(
	field: string,
	isStreaming: boolean,
	edited: boolean,
): boolean {
	return isStreaming && edited && restartRequiredSet.has(field);
}

/**
 * True when the operator must be ASKED whether to apply now or on next start.
 *
 * Exactly the same condition as the badge above, because they answer the same
 * question — a restart-required field edited mid-stream. Deriving the choice
 * from any other predicate would let a badge appear with no choice beside it,
 * or a restart be offered for an edit that needs none.
 */
export function restartChoiceRequired(
	isStreaming: boolean,
	editedFields: readonly string[],
): boolean {
	return editedFields.some((field) =>
		appliesOnNextStart(field, isStreaming, true),
	);
}
