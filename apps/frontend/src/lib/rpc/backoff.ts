/**
 * Reconnect backoff — pure, time/randomness-injected (Task 5).
 *
 * The WebSocket transport ({@link ./client.ts}) retries forever; it must never
 * permanently give up, because a transient device reboot or network blip should
 * always self-heal once connectivity returns. To keep a reconnect storm from
 * hammering the device, the delay grows exponentially up to a hard cap, and
 * full ±30% jitter is applied on EVERY step (not only once capped) so a fleet of
 * clients reconnecting after the same outage spread their attempts out instead
 * of synchronising into a thundering herd.
 *
 * This function is intentionally rune-free and side-effect-free: randomness is
 * injected via `rand` (default `Math.random`) so the unit tests in
 * `backoff.test.ts` are fully deterministic — no fake timers, no global mocks.
 */

/** Jitter spread applied symmetrically around the capped base delay (±30%). */
export const JITTER_RATIO = 0.3;

/**
 * Compute the delay (ms) before reconnect attempt number `attempt`.
 *
 * `delay = min(cap, base · 2^attempt) · (1 + rand()·2·JITTER_RATIO − JITTER_RATIO)`
 *
 * - `attempt` 0-based retry index (0 = first retry). Grows without bound; the
 *   exponential term is capped so large attempts never overflow to Infinity.
 * - `base` base delay in ms (e.g. 1000).
 * - `cap` maximum un-jittered delay in ms (e.g. 30000 ≈ 30s).
 * - `rand` returns a value in [0, 1); defaults to `Math.random`.
 *
 * Guarantees a finite, non-negative number for every input — never NaN, never
 * Infinity, never null — so the caller can always schedule another retry.
 */
export function nextBackoffDelay(
	attempt: number,
	base: number,
	cap: number,
	rand: () => number = Math.random,
): number {
	// Guard against NaN / negative attempts collapsing the exponent.
	const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? attempt : 0;

	// 2^attempt can overflow to Infinity for large attempts; cap BEFORE jitter so
	// the result is always finite. min(Infinity, cap) === cap, so capping first
	// keeps attempt 6+ (and beyond) bounded without a give-up.
	const exponential = base * 2 ** safeAttempt;
	const capped = Math.min(cap, exponential);

	// ±JITTER_RATIO around the capped delay, applied on EVERY step.
	const jitterFactor = 1 + (rand() * 2 - 1) * JITTER_RATIO;
	const delay = capped * jitterFactor;

	// Final safety net: never hand back a non-finite or negative delay.
	return Number.isFinite(delay) && delay >= 0 ? delay : capped;
}
