/**
 * Reconnect-aware in-flight reconciliation — Task 29.
 *
 * An optimistic toggle (e.g. {@link BondToggle}) holds a local `pending` latch
 * while its `rpc.*` write is in flight, showing the requested `target` instead
 * of the authoritative server value. If the WebSocket drops *mid-operation* the
 * owning promise can be orphaned — the socket is replaced on reconnect, so its
 * `finally` may never run, leaving the control stuck in a pending state that no
 * longer reflects reality.
 *
 * On reconnect the subscription layer re-hydrates authoritative status
 * (`reauthenticateAndHydrate` → `getStatus`), so the safe recovery is to drop
 * any stuck `pending` the moment the transport returns to `connected`: the
 * control then snaps back to its authoritative prop (the subscription getter),
 * never to a stale optimistic value.
 *
 * This decision is a *pure* function so it is unit-testable under the plain
 * (non-Svelte) vitest environment, mirroring the rune-free cores in
 * `dirty-registry.svelte.ts` and `connection-ux.svelte.ts`. The component wires
 * it into a `$effect` that reads `getConnectionState()`.
 */
import type { ConnectionState } from "./client";

/**
 * Whether an in-flight toggle should reconcile (clear its `pending` latch)
 * given a raw connection-state transition.
 *
 * Returns `true` only on a genuine *reconnect edge* while a request is pending:
 * the previous state was NOT `connected` and the next state IS `connected`. A
 * steady `connected → connected` tick (e.g. an unrelated re-render) does not
 * reconcile, so a normally-settling RPC keeps ownership of its own `pending`
 * lifecycle and we never race its `finally`.
 *
 * @param previous The last-observed connection state.
 * @param next     The newly-observed connection state.
 * @param pending  Whether a toggle request is currently in flight.
 */
export function shouldReconcileOnReconnect(
	previous: ConnectionState,
	next: ConnectionState,
	pending: boolean,
): boolean {
	if (!pending) return false;
	return previous !== "connected" && next === "connected";
}
