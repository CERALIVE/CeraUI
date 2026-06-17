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
