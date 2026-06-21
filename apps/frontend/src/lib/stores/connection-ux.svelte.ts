/**
 * Connection UX store — Task 16
 *
 * Owns the *WebSocket-down* user experience: the disconnected/reconnecting
 * banner, the post-reboot treatment, and graceful auth-token-expiry routing.
 * This is deliberately distinct from the browser-offline PWA page (driven by
 * `offline-state.svelte` + `pwa.svelte`): the offline page handles "the browser
 * has no network", this store handles "the browser is online but the device WS
 * is down / restarting / re-authenticating".
 *
 * Architecture (mirrors `hud.svelte.ts`, Task 8)
 * ----------------------------------------------
 * All decision logic lives in *pure*, rune-free exported functions
 * ({@link reduceConnection}, {@link deriveConnectionUx},
 * {@link shouldExpireSession}) so they are unit-testable under the plain
 * (non-Svelte) vitest environment. The reactive layer
 * ({@link createConnectionUxStore}) is created lazily on first selector access
 * and is the only place that touches Svelte runes — the unit tests never
 * execute it.
 *
 * Connection source of truth
 * --------------------------
 * Reconnect tracking is driven by `rpcClient.onConnectionChange`, the
 * *client-level* handler that survives socket replacement across reconnect
 * cycles (unlike per-socket listeners). The banner reads the same
 * `getIsConnected()` surface (`subscriptions.svelte`) the HUD uses, so the
 * banner and the HUD staleness model never disagree.
 */
import type { ConnectionState } from "$lib/rpc/client";
import { rpcClient } from "$lib/rpc/client";

// ============================================
// Constants
// ============================================

/**
 * UI-ONLY threshold: after this many failed reconnects we stop promising
 * "reconnecting…" and surface a hard-failure banner with a manual "retry now"
 * affordance. This is purely cosmetic — the transport (client.ts) retries
 * FOREVER with jittered capped backoff and never stops, so this threshold only
 * governs when the banner switches its messaging, not whether reconnection
 * continues. Failed-UI state and transport state are independent.
 */
export const MAX_RECONNECT_ATTEMPTS = 5;

// ============================================
// Types
// ============================================

export type ConnectionUxMode =
	| "connected"
	| "reconnecting"
	| "rebooting"
	| "failed";

export interface ConnectionUx {
	/** Which treatment to render. */
	mode: ConnectionUxMode;
	/** Whether the disconnect banner should be visible at all. */
	showBanner: boolean;
}

export interface ConnectionUxInput {
	/** Live WS connection flag from `subscriptions.svelte` (same source as HUD). */
	isConnected: boolean;
	/** Raw connection state (currently informational; mode derives from the flags). */
	connectionState: ConnectionState;
	/** `navigator.onLine` proxy from `pwa.svelte`. */
	browserOnline: boolean;
	/** Whether the browser-offline PWA page is showing (offline-state). */
	showOfflinePage: boolean;
	/** Reconnect attempts since the last successful connection. */
	reconnectAttempts: number;
	/** A reboot/poweroff was triggered and we're waiting for the device to return. */
	rebooting: boolean;
}

/** Internal reconnect bookkeeping, reduced from raw connection events. */
export interface ReconnectState {
	/** Reconnect attempts since the last successful connection. */
	attempts: number;
	/** Whether we have ever reached a connected state (distinguishes first connect). */
	hasConnected: boolean;
	/** Reboot-in-progress latch; cleared automatically once we reconnect. */
	rebooting: boolean;
}

// ============================================
// Pure logic (rune-free, unit-testable)
// ============================================

/** The neutral starting point for {@link reduceConnection}. */
export function initialReconnectState(): ReconnectState {
	return { attempts: 0, hasConnected: false, rebooting: false };
}

/**
 * Fold a raw connection-state transition into {@link ReconnectState}.
 *
 * - `connected`   → success: reset attempts, clear any reboot latch.
 * - `connecting`  → counts as a *reconnect* attempt only once we have connected
 *                   at least once (the very first connect must not look like a
 *                   retry).
 * - `disconnected`/`error` → no change (the following `connecting` is what we
 *                   count); reboot latch is preserved across the drop.
 */
export function reduceConnection(
	prev: ReconnectState,
	state: ConnectionState,
): ReconnectState {
	switch (state) {
		case "connected":
			return { attempts: 0, hasConnected: true, rebooting: false };
		case "connecting":
			return prev.hasConnected
				? { ...prev, attempts: prev.attempts + 1 }
				: prev;
		default:
			return prev;
	}
}

/**
 * Pure derivation of the banner treatment from a point-in-time snapshot.
 *
 * Precedence is deliberate:
 * 1. Browser-offline PWA page owns the whole screen → never also show a banner.
 * 2. Rebooting (explicit reboot/poweroff) → "rebooting" treatment, even during
 *    the brief window before the socket actually drops.
 * 3. Connected → nothing.
 * 4. WS down while browser online → reconnecting, escalating to "failed" once
 *    the retry budget is exhausted.
 * 5. WS down because the *browser* went offline (but the offline page hasn't
 *    taken over yet) → suppress the banner; the offline page will appear.
 */
export function deriveConnectionUx(input: ConnectionUxInput): ConnectionUx {
	const {
		isConnected,
		browserOnline,
		showOfflinePage,
		reconnectAttempts,
		rebooting,
	} = input;

	if (showOfflinePage) {
		return {
			mode: rebooting
				? "rebooting"
				: isConnected
					? "connected"
					: "reconnecting",
			showBanner: false,
		};
	}

	if (rebooting) {
		return { mode: "rebooting", showBanner: true };
	}

	if (isConnected) {
		return { mode: "connected", showBanner: false };
	}

	if (!browserOnline) {
		// Browser lost network — defer to the offline page rather than a banner.
		return { mode: "reconnecting", showBanner: false };
	}

	if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
		return { mode: "failed", showBanner: true };
	}

	return { mode: "reconnecting", showBanner: true };
}

/**
 * Whether an auth result represents a *mid-session* token expiry (as opposed to
 * a first-time wrong-password attempt on the login screen). We only treat a
 * failure as an expiry when the operator had previously authenticated.
 */
export function shouldExpireSession(
	authSuccess: boolean | undefined,
	wasAuthenticated: boolean,
): boolean {
	return authSuccess === false && wasAuthenticated;
}

// ============================================
// Auth latch (plain — reactivity not required)
// ============================================

let authenticatedOnce = false;

/** Record that the operator has successfully authenticated at least once. */
export function markAuthenticated(): void {
	authenticatedOnce = true;
}

/** Whether the operator has ever authenticated this page-load. */
export function wasAuthenticated(): boolean {
	return authenticatedOnce;
}

// ============================================
// Reactive store (runes — lazily created)
// ============================================

interface ConnectionUxStore {
	getReconnectAttempts(): number;
	getIsRebooting(): boolean;
	getSessionExpired(): boolean;
	markRebooting(): void;
	clearRebooting(): void;
	markSessionExpired(): void;
	clearSessionExpired(): void;
	retryConnection(): void;
	destroy(): void;
}

function createConnectionUxStore(): ConnectionUxStore {
	let reconnect = $state<ReconnectState>(initialReconnectState());
	let sessionExpired = $state(false);

	// Client-level handler: survives socket replacement across reconnect cycles.
	const off = rpcClient.onConnectionChange((state) => {
		reconnect = reduceConnection(reconnect, state);
	});

	return {
		getReconnectAttempts: () => reconnect.attempts,
		getIsRebooting: () => reconnect.rebooting,
		getSessionExpired: () => sessionExpired,
		markRebooting: () => {
			reconnect = { ...reconnect, rebooting: true };
		},
		clearRebooting: () => {
			reconnect = { ...reconnect, rebooting: false };
		},
		markSessionExpired: () => {
			sessionExpired = true;
		},
		clearSessionExpired: () => {
			sessionExpired = false;
		},
		retryConnection: () => {
			// Reset our local budget and ask the transport to reconnect now.
			reconnect = { ...reconnect, attempts: 0 };
			rpcClient.connect();
		},
		destroy: () => {
			off();
		},
	};
}

let singleton: ConnectionUxStore | null = null;

// Create the runes at module load in the browser (stable ownership, like
// subscriptions.svelte) — NOT lazily inside a component $derived, which orphans
// the signal so external writes (markRebooting / onConnectionChange) never
// notify. The `window` guard keeps the rune-free node vitest import working.
if (typeof window !== "undefined") {
	singleton = createConnectionUxStore();
}

function store(): ConnectionUxStore {
	singleton ??= createConnectionUxStore();
	return singleton;
}

// ============================================
// Public selectors / actions
// ============================================

/** Reconnect attempts since the last successful connection. */
export function getReconnectAttempts(): number {
	return store().getReconnectAttempts();
}

/** Whether a reboot/poweroff is in progress (cleared automatically on reconnect). */
export function getIsRebooting(): boolean {
	return store().getIsRebooting();
}

/** Whether the session expired mid-session and re-authentication is required. */
export function getSessionExpired(): boolean {
	return store().getSessionExpired();
}

/** Flag that a reboot/poweroff was triggered — drives the "Rebooting…" banner. */
export function markRebooting(): void {
	store().markRebooting();
}

/**
 * Drop the rebooting latch WITHOUT a reconnect. The latch normally clears only
 * when the device comes back (`reduceConnection` on the next "connected"). But a
 * reboot that never takes the device down leaves it stuck on — so when the
 * PowerDialog proves the device is still reachable after the restart window, it
 * clears the latch here so the "rebooting" banner stops contradicting reality.
 */
export function clearRebooting(): void {
	store().clearRebooting();
}

/** Flag that the auth token expired mid-session. */
export function markSessionExpired(): void {
	store().markSessionExpired();
}

/** Clear the session-expired flag (call on a fresh successful login). */
export function clearSessionExpired(): void {
	store().clearSessionExpired();
}

/** Manually trigger a reconnect after the retry budget was exhausted. */
export function retryConnection(): void {
	store().retryConnection();
}

/** Tear down the reactive store. For tests/HMR. */
export function destroyConnectionUxStore(): void {
	singleton?.destroy();
	singleton = null;
	authenticatedOnce = false;
}
