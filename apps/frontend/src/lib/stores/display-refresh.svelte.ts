// Display-refresh hook — Task 12.
//
// The single, testable release path for the e-ink display freeze (Task 10).
// Under the `eink`/`mono` profiles the HUD/live fields are intentionally frozen
// (the staleness clock is gated, nothing re-renders on its own) so the e-ink
// panel is not driven by continuous repaints. `requestDisplayRefresh()` is the
// ONE call that releases that freeze for a single render: it bumps a reactive
// nonce that frozen derivations read, then fans out to imperative subscribers
// (the freeze itself, the HUD staleness clock) so each can re-pull current
// state and re-render exactly once.
//
// There are deliberately NO timers in this module. A refresh only ever happens
// because something explicitly CALLED `requestDisplayRefresh()` — never on a
// schedule. Auto-refresh would defeat the entire point of the e-ink freeze, so
// this module exposes no interval/auto path by construction.
//
// Architecture mirrors the rest of the stores: the pub/sub core is rune-free
// (a plain `Set` of listeners) so it is unit-testable under the node vitest
// env; only the reactive nonce uses a rune, and it is read through a thin
// getter so consumers re-derive when a refresh is requested.

type DisplayRefreshListener = () => void;

/** Imperative subscribers notified on each {@link requestDisplayRefresh}. */
const listeners = new Set<DisplayRefreshListener>();

/**
 * Reactive refresh nonce. Frozen rune-based derivations read this (via
 * {@link getDisplayRefreshNonce}) so a manual refresh forces them to re-derive
 * exactly once. Monotonic; bumped once per request and never reset in normal
 * operation (only {@link resetDisplayRefresh} for tests/HMR touches it).
 */
let refreshNonce = $state(0);

/**
 * Reactive read of the refresh nonce. A component or store that wants to
 * re-derive on every manual refresh can read this; it changes once per
 * {@link requestDisplayRefresh} call.
 */
export function getDisplayRefreshNonce(): number {
	return refreshNonce;
}

/**
 * Subscribe to manual-refresh requests. The returned function unsubscribes.
 *
 * Used by the e-ink freeze (Task 10) and the HUD staleness clock to re-pull and
 * re-render once per refresh. Listeners fire synchronously, AFTER the reactive
 * nonce has been bumped, so a listener that reads {@link getDisplayRefreshNonce}
 * sees the new value.
 */
export function onDisplayRefresh(listener: DisplayRefreshListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Request a one-shot display refresh: re-pull current state and re-render the
 * frozen HUD/live fields. This is the single release path for the e-ink freeze.
 *
 * Bumps the reactive nonce first (so rune consumers re-derive), then notifies
 * every imperative subscriber. Safe to call repeatedly — each call is exactly
 * one refresh tick, with no scheduling or coalescing.
 */
export function requestDisplayRefresh(): void {
	refreshNonce += 1;
	// Observability seam (mirrors window.__ceraAppMounted): mirror the monotonic
	// count so E2E can prove a tap increments it and that nothing auto-refreshes.
	if (typeof window !== "undefined") {
		window.__ceraDisplayRefreshCount = refreshNonce;
	}
	// Iterate a snapshot so a listener that unsubscribes (or subscribes) during
	// its own callback cannot mutate the live set mid-iteration.
	for (const listener of [...listeners]) listener();
}

/**
 * Drop every subscriber and reset the nonce. For unit tests and HMR teardown so
 * a fresh module state is observable; never needed in normal app flow.
 */
export function resetDisplayRefresh(): void {
	listeners.clear();
	refreshNonce = 0;
}
