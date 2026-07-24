/**
 * Starting watchdog — Todo 29 (device-quality-wave2)
 *
 * Bounded, ACTIVE, PULL-BASED recovery for a start that never confirms —
 * the sibling of the stopping watchdog (streaming-stop-watchdog.ts).
 *
 * Why this exists
 * ---------------
 * The Live view enters live mode on the OPTIMISTIC `starting` edge and only
 * settles back once the authoritative `is_streaming` flag arrives, normally via
 * a single push `status` broadcast on the idle→streaming state change. Two
 * things can strand the optimistic `starting` state forever:
 *
 *   1. A SUCCESS whose `is_streaming=true` push is lost client-side (dropped by
 *      the per-type seq drop-stale guard, or a socket blip at the confirm edge).
 *      The awaited start RPC reply is `{success:true}` and never re-broadcasts,
 *      so the spinner sticks — the exact "infinite spinner" bug (LiveView can
 *      stay in the starting cockpit with an empty telemetry strip forever).
 *   2. A terminal FAILURE whose `{success:false}` RPC reply is lost — no revert
 *      ever fires.
 *
 * A re-dispatch cannot recover either: the engine already settled, so it emits
 * no new change-broadcast. Only a fresh authoritative PULL via
 * `rpc.status.getStatus` (seq-less, bypassing the drop-stale path) recovers.
 *
 * This module is that recovery guarantee. When `starting` persists past the
 * contract budget with no confirmation, it PULLS authoritative status and
 * reconciles:
 *   - pull says streaming  → the start succeeded; the reconcile confirms
 *     `starting`→`idle` (the lost-success case). No revert.
 *   - pull says NOT streaming → the start never confirmed within the budget
 *     (lost failure reply, or a wedged attempt); revert the stuck spinner to
 *     `idle` with a timeout reason so the operator can retry.
 *
 * Pure core (rune-free, unit-testable): `runStartWatchdog(deps)` with every
 * effect injected. The reactive timer + wiring lives in
 * streaming-optimism.svelte.ts.
 */

/**
 * How long `starting` may persist (no `is_streaming` confirmation) before the
 * watchdog fires. It must sit ABOVE the whole start-lifecycle budget so a
 * legitimately-retrying start is never cut short: the backend runs bounded
 * connect retry (DEFAULT_START_RETRY_POLICY — 5 attempts / 60s total budget)
 * plus the final attempt's phase deadlines (subscribe 10s, start-rpc 10s,
 * playing-wait 5s). 90s clears that worst case with margin — the watchdog is a
 * lost-signal safety net, never the primary path (the awaited start RPC reply
 * is). Shrinkable in e2e via `window.__ceraStartWatchdogMs`.
 */
export const START_WATCHDOG_TIMEOUT_MS = 90_000;

export interface StartWatchdogDeps {
	/**
	 * Pull the authoritative `is_streaming` via the status RPC. The implementation
	 * MUST route through `rpc.status.getStatus()` (the pull bypasses the push seq
	 * drop-stale path entirely) and apply the full pulled snapshot to the reactive
	 * store before resolving with the pulled `is_streaming`.
	 */
	pullStatus: () => Promise<boolean>;
	/** Reconcile the optimism overlay from a pulled `is_streaming` value. */
	reconcile: (isStreaming: boolean) => void;
	/**
	 * Revert `starting`→`idle` with a reason. Called ONLY when the pull proves the
	 * start never reached streaming — `reconcile(false)` deliberately keeps
	 * `starting` (contradicting-push rule), so an explicit revert is required to
	 * clear the stuck spinner.
	 */
	revert: (reason: string) => void;
}

/** Reason surfaced when the watchdog reverts an unconfirmed start. */
export const START_WATCHDOG_REVERT_REASON = "start_timeout";

/**
 * Run ONE watchdog cycle: pull → (streaming ? confirm-via-reconcile : revert).
 *
 * - pull says streaming → reconcile confirms `starting`→`idle` (the success push
 *   was lost; the pull recovered the view). No revert.
 * - pull says NOT streaming → reconcile is a no-op on `starting` (contradicting
 *   push), so revert explicitly to `idle` with a timeout reason.
 */
export async function runStartWatchdog(deps: StartWatchdogDeps): Promise<void> {
	const streaming = await deps.pullStatus();
	deps.reconcile(streaming);
	if (streaming) return;
	deps.revert(START_WATCHDOG_REVERT_REASON);
}
