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

import type { StartFailure } from "@ceraui/rpc/schemas";

import { stopStreaming as directStopStreaming } from "$lib/helpers/SystemHelper";

import { rpc } from "./client";
import {
	runStartWatchdog,
	START_WATCHDOG_TIMEOUT_MS,
	type StartWatchdogDeps,
} from "./streaming-start-watchdog";
import {
	runStopWatchdog,
	STOP_WATCHDOG_REPULL_DELAY_MS,
	STOP_WATCHDOG_TIMEOUT_MS,
	type StopWatchdogDeps,
} from "./streaming-stop-watchdog";

// ============================================
// Types
// ============================================

export type StreamingOptimismState = "idle" | "starting" | "stopping";

export interface StreamingOptimismStore {
	/** Current optimistic state. */
	state: StreamingOptimismState;
	/** Stop reason (if start failed) — a legacy code string. */
	stopReason?: string;
	/** Typed start failure (phase + class + retriable), when the reason is one. */
	failure?: StartFailure;
	/**
	 * Monotonic attempt generation. Bumped on every `transitionToStarting`; a
	 * revert carrying an older generation is a stale response from a superseded
	 * attempt and is ignored.
	 */
	generation: number;
}

// ============================================
// Pure core (rune-free, unit-testable)
// ============================================

/**
 * Create an empty optimism store.
 */
export function createOptimismStore(): StreamingOptimismStore {
	return { state: "idle", generation: 0 };
}

/**
 * Transition to `starting` state. Called when the user clicks Start. Mints a new
 * attempt `generation` so a late response from a superseded attempt is fenced.
 */
export function transitionToStarting(
	store: StreamingOptimismStore,
): StreamingOptimismStore {
	return {
		...store,
		state: "starting",
		stopReason: undefined,
		failure: undefined,
		generation: store.generation + 1,
	};
}

/**
 * Transition to `stopping` state. Called when the user clicks Stop.
 */
export function transitionToStopping(
	store: StreamingOptimismStore,
): StreamingOptimismStore {
	return {
		...store,
		state: "stopping",
		stopReason: undefined,
		failure: undefined,
	};
}

/**
 * Reconcile the optimistic state to the authoritative `is_streaming` broadcast.
 *
 * A transient state is cleared ONLY by a push that CONFIRMS the pending
 * intent; a push that contradicts it is a stale mid-transition frame and is
 * ignored so the Live destination never flickers back through `idle`.
 *
 * | state    | is_streaming | result                              |
 * |----------|--------------|-------------------------------------|
 * | starting | true         | idle (start confirmed)              |
 * | starting | false        | starting (ignore contradicting push)|
 * | stopping | false        | idle (stop confirmed)               |
 * | stopping | true         | stopping (ignore contradicting push)|
 * | idle     | any          | idle (no-op)                        |
 *
 * `idle + true` (autostart / remote start) is owned by the authoritative
 * `getIsStreaming()` store, NOT this optimism overlay — the overlay only
 * bridges a user-initiated start/stop, so it stays a no-op here.
 *
 * On a confirmed transition `stopReason` is cleared; while a transient state
 * is kept the store is returned untouched, preserving `stopReason`.
 */
export function reconcileToAuthority(
	store: StreamingOptimismStore,
	isStreaming: boolean,
): StreamingOptimismStore {
	switch (store.state) {
		case "starting":
			return isStreaming
				? { ...store, state: "idle", stopReason: undefined, failure: undefined }
				: store;
		case "stopping":
			return isStreaming
				? store
				: {
						...store,
						state: "idle",
						stopReason: undefined,
						failure: undefined,
					};
		default:
			return store;
	}
}

/**
 * Whether a revert carrying `generation` targets the CURRENT attempt. A revert
 * with no generation is unconditional (legacy callers); one with an older
 * generation is a stale response from a superseded attempt.
 */
function revertTargetsCurrentAttempt(
	store: StreamingOptimismStore,
	generation: number | undefined,
): boolean {
	return generation === undefined || generation === store.generation;
}

/**
 * Revert to `idle` with a stop reason (start failed). Called when the start RPC
 * rejects or the backend reports a failure. When `generation` is supplied and
 * does not match the store's current attempt, the revert is a stale
 * older-attempt response and is IGNORED (the store is returned untouched).
 */
export function revertWithReason(
	store: StreamingOptimismStore,
	reason: string,
	generation?: number,
): StreamingOptimismStore {
	if (!revertTargetsCurrentAttempt(store, generation)) return store;
	return { ...store, state: "idle", stopReason: reason, failure: undefined };
}

/**
 * Revert to `idle` with a typed `StartFailure` (phase + class + retriable). Same
 * generation fencing as `revertWithReason`. `stopReason` mirrors the failure's
 * string identity (code, else class) so legacy string consumers keep working.
 */
export function revertWithFailure(
	store: StreamingOptimismStore,
	failure: StartFailure,
	generation?: number,
): StreamingOptimismStore {
	if (!revertTargetsCurrentAttempt(store, generation)) return store;
	const reason =
		typeof failure.code === "string" ? failure.code : failure.class;
	return { ...store, state: "idle", stopReason: reason, failure };
}

/**
 * Clear the stop reason (e.g., when the user dismisses the error toast).
 */
export function clearStopReason(
	store: StreamingOptimismStore,
): StreamingOptimismStore {
	return { ...store, stopReason: undefined, failure: undefined };
}

// ============================================
// Reactive store (runes — never run by unit tests)
// ============================================

interface ReactiveOptimismStore {
	getState: () => StreamingOptimismState;
	getStopReason: () => string | undefined;
	getFailure: () => StartFailure | undefined;
	getGeneration: () => number;
	transitionToStarting: () => void;
	transitionToStopping: () => void;
	reconcileToAuthority: (isStreaming: boolean) => void;
	revertWithReason: (reason: string, generation?: number) => void;
	revertWithFailure: (failure: StartFailure, generation?: number) => void;
	clearStopReason: () => void;
	retryStop: () => void;
	destroy: () => void;
	getStore: () => StreamingOptimismStore;
}

/** Prod-inert e2e seam: shrink the stop-watchdog fire window (mirrors `__ceraRebootCountdownSeconds`). */
function resolveWatchdogMs(): number {
	const override =
		typeof window !== "undefined"
			? (window as unknown as { __ceraStopWatchdogMs?: number })
					.__ceraStopWatchdogMs
			: undefined;
	return typeof override === "number" && override >= 0
		? override
		: STOP_WATCHDOG_TIMEOUT_MS;
}

/** Prod-inert e2e seam: shrink the START-watchdog fire window (mirrors `resolveWatchdogMs`). */
function resolveStartWatchdogMs(): number {
	const override =
		typeof window !== "undefined"
			? (window as unknown as { __ceraStartWatchdogMs?: number })
					.__ceraStartWatchdogMs
			: undefined;
	return typeof override === "number" && override >= 0
		? override
		: START_WATCHDOG_TIMEOUT_MS;
}

// Module-level so an ASYNC watchdog write propagates to LiveView's `$derived`
// (a closure-scoped `$state` mutated off the event loop does not reliably notify
// a cross-module reader; module-level state — as in subscriptions.svelte.ts — does).
let stopStuckBannerState = $state(false);

/**
 * Create the reactive optimism store (runes — never run by unit tests). Also owns
 * the bounded stopping WATCHDOG: a timer armed on `transitionToStopping`, cleared
 * once the stop confirms (`stopping`→`idle`); if it persists it pull-reconciles
 * authoritative status — the guarantee against the stuck-after-stop bug (see
 * streaming-stop-watchdog.ts).
 */
function createReactiveOptimismStore(): ReactiveOptimismStore {
	let store = $state<StreamingOptimismStore>(createOptimismStore());
	let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
	let watchdogRunning = false;
	let startWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
	let startWatchdogRunning = false;

	function clearWatchdogTimer(): void {
		if (watchdogTimer !== undefined) {
			clearTimeout(watchdogTimer);
			watchdogTimer = undefined;
		}
	}

	function clearStartWatchdogTimer(): void {
		if (startWatchdogTimer !== undefined) {
			clearTimeout(startWatchdogTimer);
			startWatchdogTimer = undefined;
		}
	}

	function armWatchdog(): void {
		clearWatchdogTimer();
		watchdogTimer = setTimeout(() => {
			watchdogTimer = undefined;
			if (store.state === "stopping") void runWatchdogOnce();
		}, resolveWatchdogMs());
	}

	function armStartWatchdog(): void {
		clearStartWatchdogTimer();
		startWatchdogTimer = setTimeout(() => {
			startWatchdogTimer = undefined;
			if (store.state === "starting") void runStartWatchdogOnce();
		}, resolveStartWatchdogMs());
	}

	async function runWatchdogOnce(): Promise<void> {
		if (watchdogRunning) return;
		watchdogRunning = true;
		try {
			await runStopWatchdog(buildWatchdogDeps());
		} finally {
			watchdogRunning = false;
		}
	}

	async function runStartWatchdogOnce(): Promise<void> {
		if (startWatchdogRunning) return;
		startWatchdogRunning = true;
		try {
			await runStartWatchdog(buildStartWatchdogDeps());
		} finally {
			startWatchdogRunning = false;
		}
	}

	// A confirmed transition (`stopping`→`idle` or `starting`→`idle`, push OR
	// pull) ends the matching watchdog; only the stop path owns the stuck banner.
	function applyReconcile(isStreaming: boolean): void {
		const prev = store.state;
		store = reconcileToAuthority(store, isStreaming);
		if (prev === "stopping" && store.state === "idle") {
			clearWatchdogTimer();
			stopStuckBannerState = false;
		}
		if (prev === "starting" && store.state === "idle") {
			clearStartWatchdogTimer();
		}
	}

	function buildStartWatchdogDeps(): StartWatchdogDeps {
		return {
			pullStatus: async () => {
				const status = await rpc.status.getStatus();
				const { ingestPulledStatus } = await import("./subscriptions.svelte");
				ingestPulledStatus(status);
				return Boolean(
					(status as { is_streaming?: unknown } | null | undefined)
						?.is_streaming,
				);
			},
			reconcile: (isStreaming: boolean) => applyReconcile(isStreaming),
			revert: (reason: string) => {
				clearStartWatchdogTimer();
				store = revertWithReason(store, reason, store.generation);
			},
		};
	}

	function buildWatchdogDeps(): StopWatchdogDeps {
		return {
			pullStatus: async () => {
				const status = await rpc.status.getStatus();
				const { ingestPulledStatus } = await import("./subscriptions.svelte");
				ingestPulledStatus(status);
				return Boolean(
					(status as { is_streaming?: unknown } | null | undefined)
						?.is_streaming,
				);
			},
			reconcile: (isStreaming: boolean) => applyReconcile(isStreaming),
			redispatchStop: () => {
				void directStopStreaming();
			},
			delay: () =>
				new Promise((resolve) =>
					setTimeout(resolve, STOP_WATCHDOG_REPULL_DELAY_MS),
				),
			setBannerVisible: (visible: boolean) => {
				stopStuckBannerState = visible;
			},
		};
	}

	return {
		getState: () => store.state,
		getStopReason: () => store.stopReason,
		getFailure: () => store.failure,
		getGeneration: () => store.generation,
		transitionToStarting: () => {
			clearWatchdogTimer();
			stopStuckBannerState = false;
			store = transitionToStarting(store);
			armStartWatchdog();
		},
		transitionToStopping: () => {
			clearStartWatchdogTimer();
			stopStuckBannerState = false;
			store = transitionToStopping(store);
			armWatchdog();
		},
		reconcileToAuthority: (isStreaming: boolean) => {
			applyReconcile(isStreaming);
		},
		revertWithReason: (reason: string, generation?: number) => {
			const next = revertWithReason(store, reason, generation);
			if (next === store) return;
			clearStartWatchdogTimer();
			clearWatchdogTimer();
			stopStuckBannerState = false;
			store = next;
		},
		revertWithFailure: (failure: StartFailure, generation?: number) => {
			const next = revertWithFailure(store, failure, generation);
			if (next === store) return;
			clearStartWatchdogTimer();
			clearWatchdogTimer();
			stopStuckBannerState = false;
			store = next;
		},
		clearStopReason: () => {
			store = clearStopReason(store);
		},
		retryStop: () => {
			void runWatchdogOnce();
		},
		destroy: () => {
			clearWatchdogTimer();
			clearStartWatchdogTimer();
			stopStuckBannerState = false;
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
 * Get the stop reason (if start failed) — a legacy code string.
 */
export function getStreamingStopReason(): string | undefined {
	return store().getStopReason();
}

/**
 * Get the typed start failure (phase + class + retriable), if the last revert
 * carried one. `undefined` for a legacy string-only revert.
 */
export function getStreamingStartFailure(): StartFailure | undefined {
	return store().getFailure();
}

/**
 * Get the current attempt generation. Capture this right after
 * `startStreamingOptimism()` and pass it back to `revertStreamingOptimism*` so a
 * late response from a superseded attempt is fenced.
 */
export function getStreamingAttemptGeneration(): number {
	return store().getGeneration();
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
 * Revert to `idle` with a stop reason (start failed). Pass the attempt
 * `generation` captured at start to fence a stale older-attempt response.
 */
export function revertStreamingOptimism(
	reason: string,
	generation?: number,
): void {
	store().revertWithReason(reason, generation);
}

/**
 * Revert to `idle` with a typed `StartFailure` (phase + class + retriable). Pass
 * the attempt `generation` captured at start to fence a stale response.
 */
export function revertStreamingOptimismFailure(
	failure: StartFailure,
	generation?: number,
): void {
	store().revertWithFailure(failure, generation);
}

/**
 * Clear the stop reason (e.g., when the user dismisses the error toast).
 */
export function clearStreamingStopReason(): void {
	store().clearStopReason();
}

/**
 * Whether the truthful "stop is taking longer than expected" banner is showing —
 * exposed only while the authoritative flag still says streaming after the
 * watchdog has pulled and re-dispatched.
 */
export function getStopStuckBannerVisible(): boolean {
	return stopStuckBannerState;
}

/**
 * Retry the bounded stopping watchdog (pull→stop→pull). Wired to the stop-stuck
 * banner's Retry button.
 */
export function retryStopStreaming(): void {
	store().retryStop();
}

/**
 * Tear down the reactive store (clearing the watchdog timer). For tests/HMR.
 */
export function destroyStreamingOptimism(): void {
	singleton?.destroy();
	singleton = null;
}
