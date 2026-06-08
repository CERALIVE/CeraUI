/**
 * Test-only reactive stand-in for `$lib/rpc/subscriptions.svelte`'s connection
 * getter (Task 29).
 *
 * BondToggle reads `getConnectionState()` inside a `$effect` to drive
 * reconnect-aware reconciliation. To exercise that effect deterministically the
 * reconnect test mocks `$lib/rpc/subscriptions.svelte` with this module: a
 * module-level Svelte `$state` (compiled by the svelte vitest plugin because the
 * file ends in `.svelte.ts`) that the test mutates via {@link setConnectionState}.
 * Reading it through `getConnectionState()` inside the component's effect tracks
 * the signal, so a write here schedules the effect — the same cross-module
 * reactive wiring the real `subscriptions.svelte` relies on.
 */
import type { ConnectionState } from "$lib/rpc/client";

let state = $state<ConnectionState>("connected");

/** Mirrors the real `subscriptions.svelte` getter consumed by BondToggle. */
export function getConnectionState(): ConnectionState {
	return state;
}

/** Drive the connection state from a test (disconnect / reconnect simulation). */
export function setConnectionState(next: ConnectionState): void {
	state = next;
}

/** Reset to the default connected baseline between tests. */
export function resetConnectionState(): void {
	state = "connected";
}
