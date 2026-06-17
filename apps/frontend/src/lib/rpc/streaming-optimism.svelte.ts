/**
 * Streaming Optimism Helper — Task 6
 *
 * Dedicated store for optimistic streaming state transitions. Reflects user intent
 * immediately on Start/Stop click (`starting`/`stopping` transient), then reconciles
 * to the authoritative `is_streaming` from the `status` broadcast.
 *
 * This is its OWN store — NOT the dirty-registry (G4). Status fields must NOT go
 * into the dirty-registry; this helper provides the optimistic transient layer
 * without polluting that registry.
 *
 * Architecture
 * -----------
 * Pure core functions (rune-free, unit-testable) handle state transitions and
 * reconciliation. The reactive layer uses Svelte 5 runes and is created lazily
 * on first selector access.
 */

// ============================================
// Types
// ============================================

export type StreamingOptimismState = "idle" | "starting" | "stopping";

export interface StreamingOptimismStore {
	/** Current optimistic state. */
	state: StreamingOptimismState;
	/** Stop reason (if start failed). */
	stopReason?: string;
}

// ============================================
// Pure core (rune-free, unit-testable)
// ============================================

/**
 * Create an empty optimism store.
 */
export function createOptimismStore(): StreamingOptimismStore {
	return { state: "idle" };
}

/**
 * Transition to `starting` state. Called when the user clicks Start.
 */
export function transitionToStarting(
	store: StreamingOptimismStore,
): StreamingOptimismStore {
	return { ...store, state: "starting", stopReason: undefined };
}

/**
 * Transition to `stopping` state. Called when the user clicks Stop.
 */
export function transitionToStopping(
	store: StreamingOptimismStore,
): StreamingOptimismStore {
	return { ...store, state: "stopping", stopReason: undefined };
}

/**
 * Reconcile the optimistic state to the authoritative `is_streaming` broadcast.
 * - If `is_streaming` is true and we're in `starting`, move to `idle` (success).
 * - If `is_streaming` is false and we're in `stopping`, move to `idle` (success).
 * - Otherwise, move to `idle` (reconciled to truth).
 */
export function reconcileToAuthority(
	store: StreamingOptimismStore,
	isStreaming: boolean,
): StreamingOptimismStore {
	// Already at truth — no-op.
	if (
		(isStreaming && store.state === "idle") ||
		(!isStreaming && store.state === "idle")
	) {
		return store;
	}

	// Reconcile to truth.
	return { ...store, state: "idle", stopReason: undefined };
}

/**
 * Revert to `idle` with a stop reason (start failed). Called when the start RPC
 * rejects or the backend reports a failure.
 */
export function revertWithReason(
	store: StreamingOptimismStore,
	reason: string,
): StreamingOptimismStore {
	return { ...store, state: "idle", stopReason: reason };
}

/**
 * Clear the stop reason (e.g., when the user dismisses the error toast).
 */
export function clearStopReason(
	store: StreamingOptimismStore,
): StreamingOptimismStore {
	return { ...store, stopReason: undefined };
}

// ============================================
// Reactive store (runes — never run by unit tests)
// ============================================

interface ReactiveOptimismStore {
	getState: () => StreamingOptimismState;
	getStopReason: () => string | undefined;
	transitionToStarting: () => void;
	transitionToStopping: () => void;
	reconcileToAuthority: (isStreaming: boolean) => void;
	revertWithReason: (reason: string) => void;
	clearStopReason: () => void;
	getStore: () => StreamingOptimismStore;
}

/**
 * Create the reactive optimism store. Uses runes, so this only runs inside
 * the Svelte app — never in the rune-free unit tests.
 */
function createReactiveOptimismStore(): ReactiveOptimismStore {
	let store = $state<StreamingOptimismStore>(createOptimismStore());

	return {
		getState: () => store.state,
		getStopReason: () => store.stopReason,
		transitionToStarting: () => {
			store = transitionToStarting(store);
		},
		transitionToStopping: () => {
			store = transitionToStopping(store);
		},
		reconcileToAuthority: (isStreaming: boolean) => {
			store = reconcileToAuthority(store, isStreaming);
		},
		revertWithReason: (reason: string) => {
			store = revertWithReason(store, reason);
		},
		clearStopReason: () => {
			store = clearStopReason(store);
		},
		getStore: () => store,
	};
}

let singleton: ReactiveOptimismStore | null = null;

function store(): ReactiveOptimismStore {
	singleton ??= createReactiveOptimismStore();
	return singleton;
}

// ============================================
// Public selectors
// ============================================

/**
 * Get the current optimistic streaming state.
 */
export function getStreamingOptimismState(): StreamingOptimismState {
	return store().getState();
}

/**
 * Get the stop reason (if start failed).
 */
export function getStreamingStopReason(): string | undefined {
	return store().getStopReason();
}

/**
 * Transition to `starting` state (user clicked Start).
 */
export function startStreamingOptimism(): void {
	store().transitionToStarting();
}

/**
 * Transition to `stopping` state (user clicked Stop).
 */
export function stopStreamingOptimism(): void {
	store().transitionToStopping();
}

/**
 * Reconcile to the authoritative `is_streaming` broadcast.
 */
export function reconcileStreamingOptimism(isStreaming: boolean): void {
	store().reconcileToAuthority(isStreaming);
}

/**
 * Revert to `idle` with a stop reason (start failed).
 */
export function revertStreamingOptimism(reason: string): void {
	store().revertWithReason(reason);
}

/**
 * Clear the stop reason (e.g., when the user dismisses the error toast).
 */
export function clearStreamingStopReason(): void {
	store().clearStopReason();
}

/**
 * Tear down the reactive store. For tests/HMR.
 */
export function destroyStreamingOptimism(): void {
	singleton = null;
}
