import { logger } from "../../helpers/logger.ts";

/**
 * LifecycleInterlock (Phase B, T5.5) — the single mutual-exclusion guard between
 * STREAMING ADMISSION and MODEM LIFECYCLE mutations.
 *
 * Two operations must never run concurrently against a bonded modem link:
 *
 *  - `"streaming"` — a stream is being ADMITTED (the pre-engine window in
 *    `streaming.start`, before `getIsStreaming()` flips true). The interlock is
 *    held only across that admission window; once the stream is live, the live
 *    guard (`getIsStreaming()`) takes over — so a crash mid-admission can never
 *    strand the interlock (it is released in the admission `finally`).
 *  - `"modem-transition"` — a USB-composition-mode switch (`modems.setUsbMode`)
 *    or a future, DEFAULT-DISABLED autonomous cellular recovery / USB-reset
 *    action. Both re-enumerate a modem, tearing its bond link down mid-flight.
 *
 * Letting either start while the other is mid-flight breaks the bond math (a link
 * vanishing during admission, or an admitted stream losing a link to a reset), so
 * the two are mutually exclusive in BOTH race orders. This is the real interlock
 * the plan calls "LifecycleInterlock".
 *
 * Design mirrors `network/state/device-lock.ts`: a minimal in-flight guard, no
 * queue, no scheduler, no dependencies. Acquisition is FAIL-FAST — a caller that
 * cannot acquire is refused immediately (it maps that to its own typed refusal),
 * never blocked/queued. Release is guaranteed via `finally` and idempotent, so a
 * throwing guarded operation can never leave the interlock permanently held.
 *
 * NOTE: this ships the interlock plumbing only. No autonomous recovery loop is
 * wired here or anywhere by this todo — cellular recovery stays default-disabled.
 */
export type LifecycleHolder = "streaming" | "modem-transition";

/** A held interlock. `release()` is idempotent — safe to call from a `finally`. */
export interface LifecycleLease {
	readonly holder: LifecycleHolder;
	release(): void;
}

/** Result of a `withLifecycleLock` run: the guarded value, or a contention miss. */
export type LifecycleOutcome<T> =
	| { acquired: true; result: T }
	| { acquired: false };

/** The single interlock holder, or `undefined` when free. */
let holder: LifecycleHolder | undefined;

/**
 * Try to acquire the interlock for `who`. Returns a lease when the interlock is
 * free, or `null` when the OTHER lifecycle operation currently holds it. Never
 * blocks; the caller converts a `null` into its own typed refusal.
 */
export function tryAcquireLifecycle(
	who: LifecycleHolder,
): LifecycleLease | null {
	if (holder !== undefined) {
		logger.debug(
			`LifecycleInterlock held by ${holder}; refusing concurrent ${who}`,
		);
		return null;
	}

	holder = who;
	let released = false;
	return {
		holder: who,
		release() {
			// Idempotent so an outer `finally` may release after the body already
			// did, and so a double-release is a no-op — never frees another holder.
			if (released) return;
			released = true;
			if (holder === who) holder = undefined;
		},
	};
}

/**
 * Run `fn` while holding the interlock for `who`, releasing in a `finally` on ANY
 * exit (return OR throw). Returns `{ acquired: false }` WITHOUT running `fn` when
 * the other lifecycle operation holds the interlock. A throw from `fn` propagates
 * to the caller AFTER the interlock is released — the core no-deadlock guarantee.
 */
export async function withLifecycleLock<T>(
	who: LifecycleHolder,
	fn: () => Promise<T>,
): Promise<LifecycleOutcome<T>> {
	const lease = tryAcquireLifecycle(who);
	if (lease === null) {
		return { acquired: false };
	}
	try {
		return { acquired: true, result: await fn() };
	} finally {
		lease.release();
	}
}

/** True while either lifecycle operation holds the interlock. */
export function isLifecycleHeld(): boolean {
	return holder !== undefined;
}

/** The current holder, or `undefined` when the interlock is free (diagnostics). */
export function currentLifecycleHolder(): LifecycleHolder | undefined {
	return holder;
}

/** Test-only: force-release the interlock so a suite starts from a free state. */
export function resetLifecycleInterlock(): void {
	holder = undefined;
}
