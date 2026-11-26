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
 * reconciliation. The reactive layer uses a shared Svelte 5 rune store.
 */

import type { StartFailure } from "@ceraui/rpc/schemas";

import { stopStreaming as directStopStreaming } from "$lib/helpers/SystemHelper";
import { clearStartRetry } from "$lib/streaming/start-failure-presentation.svelte";
import {
	clearStartRecoveryUnknown,
	noteStartRecoveryUnknown,
	ownStartAttempt,
	resetUnresolvedStreamActions,
} from "$lib/streaming/unresolved-stream-actions.svelte";

import { pullStatusEvidence } from "./pulled-status";
import { markStreamIntent, statusFrameIsCurrent } from "./session-epoch.svelte";
import {
	runStartWatchdog,
	START_WATCHDOG_TIMEOUT_MS,
	type StartWatchdogDeps,
} from "./streaming-start-watchdog";
import {
	runStopWatchdog,
	STOP_WATCHDOG_REPULL_DELAY_MS,
	STOP_WATCHDOG_TIMEOUT_MS,
} from "./streaming-stop-watchdog";
import { getStatus, ingestPulledStatus } from "./subscriptions.svelte";

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
 * Settle the CURRENT attempt's `starting` to a plain `idle` because device
 * evidence superseded it (see `startOptimismSuperseded`). No stop reason: the
 * device's own state, not a failure this client observed, is what ended it.
 * An older attempt's generation, or any state but `starting`, is a no-op.
 */
export function supersedeStarting(
	store: StreamingOptimismStore,
	generation: number,
): StreamingOptimismStore {
	if (store.state !== "starting" || generation !== store.generation) {
		return store;
	}
	return { ...store, state: "idle", stopReason: undefined, failure: undefined };
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
	transitionToStopping: () => () => boolean;
	reconcileToAuthority: (isStreaming: boolean) => void;
	revertWithReason: (reason: string, generation?: number) => void;
	revertWithFailure: (failure: StartFailure, generation?: number) => void;
	supersedeStarting: (generation: number) => void;
	clearStopReason: () => void;
	isRetryBusy: () => boolean;
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
 * Create the reactive optimism store. Also owns
 * the bounded watchdog, armed at Stop dispatch and cleared when the Stop
 * settles or loses ownership. Its status pull can recover a missed idle push.
 */
function createReactiveOptimismStore(): ReactiveOptimismStore {
	let store = $state<StreamingOptimismStore>(createOptimismStore());
	let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
	let lifetime = 0;
	let watchdogRunning:
		| { readonly action: number; operatorRetry: boolean }
		| undefined;
	let busyRetryAction = $state<number>();
	let startWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
	let startWatchdogRunning: number | undefined;

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

	async function runWatchdogOnce(operatorRetry = false): Promise<void> {
		const action = lifetime;
		if (store.state !== "stopping" || watchdogRunning?.action === action)
			return;
		const cycle = { action, operatorRetry };
		watchdogRunning = cycle;
		const isCurrent = () => lifetime === action;
		let liveReadAuthorizesResend = false;
		let resend: Promise<unknown> | undefined;
		let joinedRecovery: Promise<unknown> | undefined;
		const delay = () =>
			new Promise<void>((resolve) =>
				setTimeout(resolve, STOP_WATCHDOG_REPULL_DELAY_MS),
			);

		function checkJoinedResend(): void {
			joinedRecovery = Promise.allSettled([
				delay().then(async () => {
					if (isCurrent())
						await pullWatchdogStatus(isCurrent, { retryOnSupersession: false });
				}),
			]);
		}

		function redispatchStop(afterConfirm = false): void {
			if (resend !== undefined) return;
			// Keep operator intent, but recheck live evidence at dequeue.
			const requested = cycle.operatorRetry;
			const canRedispatch = () => {
				if (!isCurrent() || !liveReadAuthorizesResend) return false;
				const lifecycle = getStatus(true)?.stream_lifecycle;
				return (
					lifecycle !== "reconfiguring" &&
					lifecycle !== "stopping" &&
					(requested ||
						(lifecycle !== "reconciling" && lifecycle !== "stop_failed"))
				);
			};
			if (!canRedispatch()) return;
			busyRetryAction = action;
			// SystemHelper reports failures; we only need to know when the send settles.
			resend = Promise.allSettled([
				directStopStreaming(
					canRedispatch,
					afterConfirm ? checkJoinedResend : undefined,
				),
			]);
		}

		try {
			const stillLive = await runStopWatchdog({
				isCurrent,
				pullStatus: () =>
					pullWatchdogStatus(isCurrent, {
						noteLive: (isLive) => {
							liveReadAuthorizesResend = isLive;
						},
					}),
				reconcile: (isStreaming) => {
					if (isCurrent()) applyReconcile(isStreaming);
				},
				redispatchStop,
				delay,
				setBannerVisible: (visible) => {
					if (isCurrent()) stopStuckBannerState = visible;
				},
			});
			// A click during the delay/read can use its fresh live result.
			if (stillLive && cycle.operatorRetry) redispatchStop(true);
		} finally {
			// The read cycle can finish while the resend is still waiting to dispatch.
			if (resend !== undefined) await resend;
			if (joinedRecovery !== undefined) await joinedRecovery;
			if (watchdogRunning === cycle) watchdogRunning = undefined;
			if (busyRetryAction === action) busyRetryAction = undefined;
		}
	}

	async function runStartWatchdogOnce(): Promise<void> {
		const action = lifetime;
		if (store.state !== "starting" || startWatchdogRunning === action) return;
		startWatchdogRunning = action;
		try {
			await runStartWatchdog(buildStartWatchdogDeps(() => lifetime === action));
		} finally {
			if (startWatchdogRunning === action) startWatchdogRunning = undefined;
		}
	}

	// A confirmed transition (`stopping`→`idle` or `starting`→`idle`, push OR
	// pull) ends the matching watchdog; only the stop path owns the stuck banner.
	function applyReconcile(isStreaming: boolean): void {
		if (isStreaming) clearStartRetry();
		const prev = store.state;
		store = reconcileToAuthority(store, isStreaming);
		if (prev !== store.state) lifetime += 1;
		if (prev === "stopping" && store.state === "idle") {
			clearWatchdogTimer();
			stopStuckBannerState = false;
		}
		if (prev === "starting" && store.state === "idle") {
			clearStartWatchdogTimer();
			clearStartRecoveryUnknown(store.generation);
		}
	}

	async function pullWatchdogStatus(
		isCurrent: () => boolean,
		{
			noteLive,
			retryOnSupersession = true,
		}: {
			readonly noteLive?: (isLive: boolean) => void;
			readonly retryOnSupersession?: boolean;
		} = {},
	): Promise<boolean | undefined> {
		try {
			const answer = await pullStatusEvidence(isCurrent, {
				retryOnSupersession,
			});
			if (!isCurrent() || answer === undefined) {
				noteLive?.(false);
				return undefined;
			}
			const { status, receipt } = answer;
			const isStreaming =
				statusFrameIsCurrent(receipt) &&
				typeof status === "object" &&
				status !== null &&
				"is_streaming" in status &&
				typeof status.is_streaming === "boolean"
					? status.is_streaming
					: undefined;
			// Withdraw older authority before this snapshot can clear a phase veto.
			noteLive?.(isStreaming === true);
			ingestPulledStatus(status, receipt);
			return isStreaming;
		} catch (error) {
			noteLive?.(false);
			if (!(error instanceof Error)) throw error;
			console.error("Stream watchdog status read failed:", error);
			return undefined;
		}
	}

	function buildStartWatchdogDeps(isCurrent: () => boolean): StartWatchdogDeps {
		const generation = store.generation;
		return {
			isCurrent,
			pullStatus: () => pullWatchdogStatus(isCurrent),
			unknown: () => {
				if (
					isCurrent() &&
					store.state === "starting" &&
					store.generation === generation
				)
					noteStartRecoveryUnknown(generation);
			},
			reconcile: (isStreaming: boolean) => {
				if (isCurrent()) applyReconcile(isStreaming);
			},
			revert: (reason: string) => {
				if (!isCurrent()) return;
				clearStartWatchdogTimer();
				lifetime += 1;
				store = revertWithReason(store, reason, generation);
			},
		};
	}

	return {
		getState: () => store.state,
		getStopReason: () => store.stopReason,
		getFailure: () => store.failure,
		getGeneration: () => store.generation,
		transitionToStarting: () => {
			clearStartRetry();
			lifetime += 1;
			markStreamIntent();
			clearWatchdogTimer();
			stopStuckBannerState = false;
			store = transitionToStarting(store);
			ownStartAttempt(store.generation);
			armStartWatchdog();
		},
		transitionToStopping: () => {
			const action = ++lifetime;
			markStreamIntent();
			clearStartWatchdogTimer();
			clearWatchdogTimer();
			stopStuckBannerState = false;
			store = transitionToStopping(store);
			return () => {
				if (lifetime !== action) return false;
				armWatchdog();
				return true;
			};
		},
		reconcileToAuthority: (isStreaming: boolean) => {
			applyReconcile(isStreaming);
		},
		revertWithReason: (reason: string, generation?: number) => {
			const next = revertWithReason(store, reason, generation);
			if (next === store) return;
			lifetime += 1;
			clearStartWatchdogTimer();
			clearWatchdogTimer();
			stopStuckBannerState = false;
			store = next;
		},
		revertWithFailure: (failure: StartFailure, generation?: number) => {
			const next = revertWithFailure(store, failure, generation);
			if (next === store) return;
			lifetime += 1;
			clearStartWatchdogTimer();
			clearWatchdogTimer();
			stopStuckBannerState = false;
			store = next;
		},
		supersedeStarting: (generation: number) => {
			const next = supersedeStarting(store, generation);
			if (next === store) return;
			lifetime += 1;
			clearStartWatchdogTimer();
			store = next;
			clearStartRecoveryUnknown(generation);
		},
		clearStopReason: () => {
			store = clearStopReason(store);
		},
		isRetryBusy: () => busyRetryAction === lifetime,
		retryStop: () => {
			if (!stopStuckBannerState || busyRetryAction === lifetime) return;
			busyRetryAction = lifetime;
			if (watchdogRunning?.action === lifetime)
				watchdogRunning.operatorRetry = true;
			else void runWatchdogOnce(true);
		},
		destroy: () => {
			lifetime += 1;
			clearWatchdogTimer();
			clearStartWatchdogTimer();
			watchdogRunning = undefined;
			startWatchdogRunning = undefined;
			busyRetryAction = undefined;
			stopStuckBannerState = false;
			store = createOptimismStore();
		},
		getStore: () => store,
	};
}

// Allocate the signals outside the first selector's derived so it subscribes.
const singleton = createReactiveOptimismStore();

// ============================================
// Public selectors
// ============================================

/**
 * Get the current optimistic streaming state.
 */
export function getStreamingOptimismState(): StreamingOptimismState {
	return singleton.getState();
}

/**
 * Get the stop reason (if start failed) — a legacy code string.
 */
export function getStreamingStopReason(): string | undefined {
	return singleton.getStopReason();
}

/**
 * Get the typed start failure (phase + class + retriable), if the last revert
 * carried one. `undefined` for a legacy string-only revert.
 */
export function getStreamingStartFailure(): StartFailure | undefined {
	return singleton.getFailure();
}

/**
 * Get the current attempt generation. Capture this right after
 * `startStreamingOptimism()` and pass it back to `revertStreamingOptimism*` so a
 * late response from a superseded attempt is fenced.
 */
export function getStreamingAttemptGeneration(): number {
	return singleton.getGeneration();
}

/**
 * Transition to `starting` state (user clicked Start).
 */
export function startStreamingOptimism(): void {
	singleton.transitionToStarting();
}

/**
 * Claim `stopping` now. The returned callback rechecks ownership and arms the
 * watchdog just before the initial Stop dispatch.
 */
export function stopStreamingOptimism(): () => boolean {
	return singleton.transitionToStopping();
}

/** Withdraw the confirmed Stop, including any queued send, at an observed boundary. */
export function invalidateConfirmedStop(): void {
	if (singleton.getState() === "stopping")
		singleton.reconcileToAuthority(false);
}

/**
 * Reconcile to the authoritative `is_streaming` broadcast.
 */
export function reconcileStreamingOptimism(isStreaming: boolean): void {
	singleton.reconcileToAuthority(isStreaming);
}

/**
 * Revert to `idle` with a stop reason (start failed). Pass the attempt
 * `generation` captured at start to fence a stale older-attempt response.
 */
export function revertStreamingOptimism(
	reason: string,
	generation?: number,
): void {
	singleton.revertWithReason(reason, generation);
}

/**
 * Revert to `idle` with a typed `StartFailure` (phase + class + retriable). Pass
 * the attempt `generation` captured at start to fence a stale response.
 */
export function revertStreamingOptimismFailure(
	failure: StartFailure,
	generation?: number,
): void {
	singleton.revertWithFailure(failure, generation);
}

/**
 * Settle the current attempt's `starting` because the device's own state
 * superseded it (an unconfirmed lifecycle, or idle after a lost start reply).
 * Pass the attempt `generation`; a stale one is ignored.
 */
export function supersedeStartingOptimism(generation: number): void {
	singleton.supersedeStarting(generation);
}

/**
 * Clear the stop reason (e.g., when the user dismisses the error toast).
 */
export function clearStreamingStopReason(): void {
	singleton.clearStopReason();
}

/**
 * Whether the Stop delay banner is showing. The first watchdog read did not
 * confirm idle; the Stop may still be pending or its outcome unknown.
 */
export function getStopStuckBannerVisible(): boolean {
	return stopStuckBannerState;
}

/** A Retry is already accepted or a resend is pending for the current Stop. */
export function getStopRetryBusy(): boolean {
	return singleton.isRetryBusy();
}

/**
 * Authorize one Retry for the current Stop, joining its watchdog if still active.
 */
export function retryStopStreaming(): void {
	singleton.retryStop();
}

/**
 * Reset the reactive store and its unresolved actions without losing existing
 * subscribers. For tests/HMR.
 */
export function destroyStreamingOptimism(): void {
	singleton.destroy();
	resetUnresolvedStreamActions();
}
