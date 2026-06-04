/**
 * Pending-guard logic for {@link AsyncSwitch}.
 *
 * Extracted as a framework-agnostic helper so the single-flight + revert
 * behaviour is unit-testable in the `node` vitest environment without mounting
 * a Svelte component (the project has no DOM testing-library and adds no new
 * deps). The `.svelte` wrapper wires its `$state` pending flag into a
 * {@link PendingRef} and delegates here.
 */

/** Mutable accessor over the component's `$state` pending flag. */
export interface PendingRef {
	get(): boolean;
	set(value: boolean): void;
}

/**
 * Pessimistic, single-flight guard for an async toggle.
 *
 * - Re-entrant calls are ignored while a previous call is in-flight, so a rapid
 *   double-click never fires `onCheckedChange` twice (no double-RPC).
 * - The pending lock is always released in `finally`, so the control re-enables
 *   on both resolve and reject (never stuck disabled).
 * - The controlled `checked` prop is never mutated here: a failed call leaves
 *   the switch on its prior visual state (revert), and a successful call only
 *   advances once the caller's `onCheckedChange` has resolved.
 * - Rejections are swallowed after resetting the lock and surfaced via the
 *   optional `onError`, so a failed RPC never becomes an unhandled rejection.
 */
export async function guardedToggle(
	next: boolean,
	onCheckedChange: (value: boolean) => Promise<void>,
	pending: PendingRef,
	onError?: (error: unknown) => void,
): Promise<void> {
	if (pending.get()) return;
	pending.set(true);
	try {
		await onCheckedChange(next);
	} catch (error) {
		onError?.(error);
	} finally {
		pending.set(false);
	}
}
