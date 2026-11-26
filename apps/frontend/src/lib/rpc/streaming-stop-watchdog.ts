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
 * When `stopping` persists past the timeout, the watchdog pulls authoritative
 * status instead of relying on another broadcast. If the pull still says
 * streaming, it attempts one re-dispatch and pulls again. The delay banner
 * appears if the first read cannot confirm idle; Retry re-runs the bounded
 * check, not a proven-failed Stop. The view
 * leaves live mode ONLY on an authoritative `is_streaming:false` (push OR pull) —
 * never by pretending idle while the authoritative flag still says streaming.
 *
 * Pure core (rune-free, unit-testable): the sequence is `runStopWatchdog(deps)`
 * with every effect injected. The reactive timer + wiring lives in
 * streaming-optimism.svelte.ts.
 */

/** How long `stopping` may persist (no `is_streaming` change) before the watchdog fires. */
export const STOP_WATCHDOG_TIMEOUT_MS = 15_000;

/** Bounded delay before the confirming second pull. */
export const STOP_WATCHDOG_REPULL_DELAY_MS = 2_000;

export interface StopWatchdogDeps {
	/**
	 * Pull the authoritative `is_streaming` via the status RPC. The implementation
	 * MUST route through `rpc.status.getStatus()` (the pull response bypasses the
	 * push seq drop-stale path entirely) and apply the full pulled snapshot to the
	 * reactive store before resolving with the pulled `is_streaming`.
	 */
	pullStatus: () => Promise<boolean | undefined>;
	/** The originating action still owns this cycle. */
	isCurrent?: () => boolean;
	/** Reconcile the optimism overlay from a pulled `is_streaming` value. */
	reconcile: (isStreaming: boolean) => void;
	/** Re-dispatch once if still authorized and not pending on the device. */
	redispatchStop: () => void;
	/** Bounded delay before the confirming second pull. */
	delay: () => Promise<void>;
	/** Expose/clear the truthful "stop is taking longer than expected" banner. */
	setBannerVisible: (visible: boolean) => void;
}

/**
 * Run one watchdog cycle. Unknown shows the delay banner without a retry send.
 *
 * - pull #1 says NOT streaming → reconcile to idle, NO re-dispatch, banner hidden
 *   (the "no-rebroadcast trap": the push was lost but the server is already
 *   stopped, so the PULL alone recovers the view).
 * - pull #1 says streaming → expose the banner, attempt one re-dispatch, then
 *   pull again after a bounded delay:
 *     - pull #2 NOT streaming → reconcile, banner hidden (recovered).
 *     - pull #2 streaming or unknown → delay banner stays; Retry re-runs this.
 *
 * Return true only if the confirming read still proves live for this owner.
 */
export async function runStopWatchdog(
	deps: StopWatchdogDeps,
): Promise<boolean> {
	const current = deps.isCurrent ?? (() => true);
	if (!current()) return false;
	const first = await deps.pullStatus();
	if (!current()) return false;
	if (first === undefined) {
		deps.setBannerVisible(true);
		return false;
	}
	deps.reconcile(first);
	if (!current()) return false;
	if (!first) {
		// The authoritative flag is already false: the view will leave live mode on
		// this reconcile. No re-dispatch (nothing to stop), no banner.
		deps.setBannerVisible(false);
		return false;
	}

	// Still streaming per authority, not necessarily a failed Stop.
	deps.setBannerVisible(true);
	if (!current()) return false;
	deps.redispatchStop();
	await deps.delay();
	if (!current()) return false;

	const second = await deps.pullStatus();
	if (!current() || second === undefined) return false;
	deps.reconcile(second);
	if (!current()) return false;
	if (!second) {
		// The second read recovered the missed stop confirmation.
		deps.setBannerVisible(false);
	}
	return second;
}
