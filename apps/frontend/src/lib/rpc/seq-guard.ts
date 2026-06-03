/**
 * Sequence number guard — Task 11
 *
 * Pure drop-stale + reset-on-reconnect logic for per-type message filtering.
 *
 * Design:
 * - Per-type Map<string, number> tracking lastSeen seq for each message type
 * - Drop if incomingSeq <= lastSeen (stale or duplicate)
 * - Accept if incomingSeq > lastSeen (newer, gaps are fine)
 * - Reset lastSeen on reconnect (server restart → seq back to 0 must be accepted)
 * - Messages WITHOUT seq bypass drop-stale (handled in Task 13 wiring)
 *
 * This module is pure (no Date.now, no timers, no Svelte runes) — fully
 * unit-testable under plain vitest. Time/thresholds are injected as parameters.
 */

/**
 * Decide whether to drop an incoming message based on its sequence number.
 *
 * @param incomingSeq The sequence number from the incoming message
 * @param lastSeen The last-seen sequence number for this message type
 * @param opts Optional configuration
 * @param opts.reset If true, accept the message regardless (post-reconnect reset)
 * @returns true if the message should be dropped (stale/duplicate), false if accepted
 */
export function shouldDropMessage(
	incomingSeq: number,
	lastSeen: number,
	opts?: { reset?: boolean },
): boolean {
	// Post-reconnect reset: accept regardless
	if (opts?.reset) {
		return false;
	}

	// Drop if stale or duplicate (incomingSeq <= lastSeen)
	return incomingSeq <= lastSeen;
}

/**
 * A per-type sequence tracker with methods to check, advance, and reset.
 */
export interface SeqTracker {
	/** Check if a message should be dropped for the given type. */
	shouldDrop(type: string, incomingSeq: number): boolean;
	/** Update the lastSeen sequence for the given type. */
	advance(type: string, seq: number): void;
	/** Clear all lastSeen values (called on reconnect). */
	resetOnReconnect(): void;
}

/**
 * Create a per-type sequence tracker.
 *
 * @returns A tracker with shouldDrop, advance, and resetOnReconnect methods
 */
export function createSeqTracker(): SeqTracker {
	const lastSeen = new Map<string, number>();

	return {
		shouldDrop(type: string, incomingSeq: number): boolean {
			const prevSeen = lastSeen.get(type) ?? -1;
			return shouldDropMessage(incomingSeq, prevSeen);
		},

		advance(type: string, seq: number): void {
			lastSeen.set(type, seq);
		},

		resetOnReconnect(): void {
			lastSeen.clear();
		},
	};
}
