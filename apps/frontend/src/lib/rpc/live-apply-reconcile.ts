/**
 * Pure apply/reconcile decisions for the Live destination — Task 15.
 *
 * Two decisions the Live view makes when an optimistic write settles, both
 * rune-free so they are unit-testable under plain (non-Svelte) vitest, mirroring
 * the pure cores in {@link ./reconcile-inflight} and {@link ./dirty-registry.svelte}:
 *
 *   1. {@link resolveAppliedBitrate} — which value to release the `max_br`
 *      field-lock to once `setBitrate` settles, given the T9 envelope
 *      (`{ success, applied }`). The lock is released to the **server-applied**
 *      value, never the optimistic value the client sent.
 *   2. {@link reconcileSwitchingInput} — whether a stuck live-switch latch
 *      should be cleared on a reconnect edge so the input picker reconciles to
 *      the server-reported active input instead of a stale optimistic value.
 *      (A `switchInput` that forces a pipeline reconnect can orphan its RPC
 *      promise — the socket is replaced on reconnect, so the handler's `finally`
 *      may never clear the latch.)
 */
import type { BitrateOutput } from "@ceraui/rpc/schemas";

import type { ConnectionState } from "./client";
import { shouldReconcileOnReconnect } from "./reconcile-inflight";

/**
 * The authoritative value to release the `max_br` field-lock to after a
 * `setBitrate` RPC settles (T9 envelope `{ success, applied }`).
 *
 *  - **success** → `result.applied` (the post-hardware-clamp server truth).
 *    Falls back to `intended` only if the server omitted `applied`.
 *  - **success:false** → `serverValue` (the last-known authoritative value) —
 *    NEVER the optimistic value the client sent, so a rejected write clears to
 *    server truth instead of sticking on the typed value. Falls back to
 *    `intended` only when no server value is known.
 *
 * The corresponding REJECT path (the RPC threw) is handled by the caller, which
 * releases the lock to `serverValue` directly — there is no envelope to inspect.
 */
export function resolveAppliedBitrate(
	result: BitrateOutput,
	intended: number,
	serverValue: number | undefined,
): number {
	if (result.success) return result.applied ?? intended;
	return serverValue ?? intended;
}

/**
 * Reconcile a live input-switch latch against a connection-state transition.
 *
 * Returns `undefined` (clear the latch) only on a genuine reconnect edge while a
 * switch is in flight — the `switchInput` RPC that forced the reconnect was
 * orphaned, so the picker must reconcile to the server-reported active input
 * rather than stay on the stale "switching" state. Otherwise the latch is
 * returned unchanged (a steady `connected` tick or the disconnect edge keeps the
 * normally-settling RPC in charge of its own lifecycle).
 *
 * @param previous       The last-observed connection state.
 * @param next           The newly-observed connection state.
 * @param switchingInput The current in-flight switch latch (`undefined` = none).
 */
export function reconcileSwitchingInput(
	previous: ConnectionState,
	next: ConnectionState,
	switchingInput: string | undefined,
): string | undefined {
	return shouldReconcileOnReconnect(previous, next, switchingInput !== undefined)
		? undefined
		: switchingInput;
}
