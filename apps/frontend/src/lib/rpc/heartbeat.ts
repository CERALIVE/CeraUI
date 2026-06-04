/**
 * Pure heartbeat staleness / half-open socket detection (Task 12).
 *
 * Background:
 *   A TCP/WebSocket connection can go "half-open" — the socket reports `OPEN`
 *   but the peer is gone and no `close`/`error` ever fires. The client already
 *   sends its own keepalive (see `client.ts:187-191`), and the backend now emits
 *   server→client pings (see `@ceraui/rpc` heartbeat.schema.ts). This module
 *   turns the timestamp of the last observed inbound traffic into a deterministic
 *   "is the link dead?" verdict so the connection layer can force a reconnect.
 *
 * Design constraints (deliberate):
 *   - PURE: no timers, no `Date.now()`, no side effects. Time is injected via an
 *     explicit `now: number` argument, mirroring the dirty-registry pattern. This
 *     keeps the logic trivially testable and flake-free.
 *   - The socket wiring (recording traffic, scheduling checks, triggering the
 *     reconnect) lives elsewhere (Task 14). This file is logic only.
 */

/**
 * Staleness threshold in milliseconds.
 *
 * ≈3 missed 5s server pings. If no inbound traffic arrives within this window,
 * the connection is treated as dead even when the socket still reports `OPEN`.
 */
export const HEARTBEAT_THRESHOLD_MS = 15000;

/**
 * Returns `true` when the connection is considered stale, i.e. strictly more
 * than `threshold` milliseconds have elapsed since the last observed traffic.
 *
 * The comparison is strict (`>`): being exactly at the threshold is still fresh,
 * which makes the boundary deterministic and easy to reason about in tests.
 *
 * @param lastSeenAt Timestamp (ms) of the most recent inbound traffic.
 * @param now        Current timestamp (ms), injected by the caller.
 * @param threshold  Maximum allowed gap (ms) before the link is stale.
 */
export function isHeartbeatStale(lastSeenAt: number, now: number, threshold: number): boolean {
	return now - lastSeenAt > threshold;
}

/**
 * State holder returned by {@link createHeartbeatTracker}.
 */
export interface HeartbeatTracker {
	/** Record that inbound traffic was observed at `now` (ms). */
	recordTraffic(now: number): void;
	/**
	 * Whether the connection is stale as of `now` (ms). Falls back to
	 * {@link HEARTBEAT_THRESHOLD_MS} when no explicit threshold is given.
	 */
	isStale(now: number, threshold?: number): boolean;
	/** The timestamp (ms) of the last recorded traffic. */
	getLastSeenAt(): number;
}

/**
 * Creates a minimal, side-effect-free heartbeat tracker.
 *
 * It holds a single mutable `lastSeenAt` and defers all staleness math to
 * {@link isHeartbeatStale}. There are no timers and no implicit clock reads —
 * every decision is driven by the `now` value the caller passes in.
 */
export function createHeartbeatTracker(): HeartbeatTracker {
	let lastSeenAt = 0;

	return {
		recordTraffic(now: number): void {
			lastSeenAt = now;
		},
		isStale(now: number, threshold: number = HEARTBEAT_THRESHOLD_MS): boolean {
			return isHeartbeatStale(lastSeenAt, now, threshold);
		},
		getLastSeenAt(): number {
			return lastSeenAt;
		},
	};
}
