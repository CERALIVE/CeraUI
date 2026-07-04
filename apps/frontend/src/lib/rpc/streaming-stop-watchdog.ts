/**
 * Stopping watchdog — Task T0 (live-experience-refinement)
 *
 * Bounded, ACTIVE, PULL-BASED recovery for a stop that never confirms.
 *
 * Why this exists
 * ---------------
 * The Live view leaves live mode ONLY on the authoritative `is_streaming` flag
 * (LiveView.svelte:88/102/107-109/157). That flag is normally delivered by a
 * SINGLE push `status` broadcast produced on the streaming→stopped state CHANGE
 * (backend `updateStatus` in streaming.ts:81-93 — it broadcasts ONLY on a
 * change). If that one push is lost client-side — dropped by the per-type seq
 * drop-stale guard (subscriptions.svelte.ts → seq-guard.ts), or lost to a socket
 * blip at the stop edge — the flag stays `true` forever and the UI is stranded in
 * LiveCockpit. Crucially, a re-dispatched stop cannot recover it: the server is
 * already stopped, so `updateStatus(false)` produces NO new change-broadcast. Only
 * a full reload — which does a fresh authoritative PULL via `rpc.status.getStatus`
 * (status.procedure.ts, seq-less, bypassing the drop-stale path) — recovers. That
 * is the "stuck after stop until reload" field bug.
 *
 * This module is the recovery guarantee. When `stopping` persists past the
 * timeout with no flag change, it PULLS authoritative status (never trusting a
 * flag echo, never depending on a new broadcast) and reconciles the store from the
 * pulled value. If the pull still says streaming it re-dispatches stop ONCE
 * (idempotent) and pulls again; if it is STILL streaming, a truthful bounded
 * banner is exposed with a Retry that re-runs the same pull→stop→pull. The view
 * leaves live mode ONLY on an authoritative `is_streaming:false` (push OR pull) —
 * never by pretending idle while the authoritative flag still says streaming.
 *
 * Pure core (rune-free, unit-testable): the sequence is `runStopWatchdog(deps)`
 * with every effect injected. The reactive timer + wiring lives in
 * streaming-optimism.svelte.ts.
 */

/** How long `stopping` may persist (no `is_streaming` change) before the watchdog fires. */
export const STOP_WATCHDOG_TIMEOUT_MS = 15_000;

/** Bounded delay between the re-dispatched stop and the confirming second pull. */
export const STOP_WATCHDOG_REPULL_DELAY_MS = 2_000;

export interface StopWatchdogDeps {
	/**
	 * Pull the authoritative `is_streaming` via the status RPC. The implementation
	 * MUST route through `rpc.status.getStatus()` (the pull response bypasses the
	 * push seq drop-stale path entirely) and apply the full pulled snapshot to the
	 * reactive store before resolving with the pulled `is_streaming`.
	 */
	pullStatus: () => Promise<boolean>;
	/** Reconcile the optimism overlay from a pulled `is_streaming` value. */
	reconcile: (isStreaming: boolean) => void;
	/** Re-dispatch stop ONCE via the DIRECT rpc path (NEVER the window global). */
	redispatchStop: () => void;
	/** Bounded delay before the confirming second pull. */
	delay: () => Promise<void>;
	/** Expose/clear the truthful "stop is taking longer than expected" banner. */
	setBannerVisible: (visible: boolean) => void;
}

/**
 * Run ONE watchdog cycle: pull → (still streaming ? redispatch → pull) → banner.
 *
 * - pull #1 says NOT streaming → reconcile to idle, NO re-dispatch, banner hidden
 *   (the "no-rebroadcast trap": the push was lost but the server is already
 *   stopped, so the PULL alone recovers the view).
 * - pull #1 says streaming → expose the banner, re-dispatch stop ONCE, then pull
 *   again after a bounded delay:
 *     - pull #2 NOT streaming → reconcile, banner hidden (recovered).
 *     - pull #2 streaming → banner stays (genuinely stuck; Retry re-runs this).
 */
export async function runStopWatchdog(deps: StopWatchdogDeps): Promise<void> {
	const first = await deps.pullStatus();
	deps.reconcile(first);
	if (!first) {
		// The authoritative flag is already false: the view will leave live mode on
		// this reconcile. No re-dispatch (nothing to stop), no banner.
		deps.setBannerVisible(false);
		return;
	}

	// Still streaming per authority: surface the truthful banner while we retry.
	deps.setBannerVisible(true);
	// Backend stop is idempotent; a second stop is safe even if the first landed.
	deps.redispatchStop();
	await deps.delay();

	const second = await deps.pullStatus();
	deps.reconcile(second);
	if (!second) {
		// Recovered after the re-dispatch.
		deps.setBannerVisible(false);
	}
	// else: genuinely stuck — the banner stays and the user can Retry.
}
