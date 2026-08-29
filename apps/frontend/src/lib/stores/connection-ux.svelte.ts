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
 * Reconnect-banner grace period
 * -----------------------------
 * The "reconnecting" treatment is debounced by {@link RECONNECT_BANNER_GRACE_MS}
 * so a drop that heals inside that window is invisible to the operator. Time is
 * injected (`disconnectedSince` + an explicit `now`) rather than read inside the
 * pure functions, and a self-gating clock in the reactive layer advances `now`
 * only while a drop is still inside its window.
 *
 * Connection source of truth
 * --------------------------
 * Reconnect tracking is driven by `rpcClient.onConnectionChange`, the
 * *client-level* handler that survives socket replacement across reconnect
 * cycles (unlike per-socket listeners). The banner reads the same
 * `getIsConnected()` surface (`subscriptions.svelte`) the HUD uses, so the
 * banner and the HUD staleness model never disagree.
 */
// allow: SIZE_OK — one connection UX state machine; pure transitions and their sole reactive owner stay co-located.
import type { ConnectionState } from "$lib/rpc/client";
import { rpcClient } from "$lib/rpc/client";
import { createStalenessClock } from "./hud/staleness";

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

/**
 * How long a WS drop must PERSIST before the "reconnecting" banner is allowed on
 * screen. A drop that heals inside this window is completely silent.
 *
 * WHY: the half-open-socket detector (`heartbeat.ts`) deliberately tears down and
 * re-dials a socket that has gone quiet, and the transport re-dials on any drop.
 * Most of those cycles heal in well under a second, so an undebounced banner
 * flashed "Connection lost" at the operator for every one of them — read as
 * sustained instability on a device whose transport was in fact recovering every
 * single time. This is a PRESENTATION delay only: the transport is untouched and
 * keeps reconnecting exactly as before.
 */
export const RECONNECT_BANNER_GRACE_MS = 3000;

/**
 * How often the grace clock re-evaluates while a disconnect is inside its window.
 * Bounds how far past {@link RECONNECT_BANNER_GRACE_MS} the banner can appear —
 * a disconnect with no further connection events fires no state change of its
 * own, so something has to advance `now` for the grace to elapse at all.
 */
export const RECONNECT_BANNER_TICK_MS = 500;

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

export interface ConnectionSurfaceUx {
	showOfflineBanner: boolean;
	showAuthTimeout: boolean;
}

export interface ConnectionSurfaceUxInput {
	authTimedOut: boolean;
	disconnectedSince: number | null;
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
	/**
	 * When the current disconnect started (`null` while connected). Drives the
	 * {@link RECONNECT_BANNER_GRACE_MS} debounce; see {@link ReconnectState}.
	 */
	disconnectedSince: number | null;
}

/** Internal reconnect bookkeeping, reduced from raw connection events. */
export interface ReconnectState {
	/** Reconnect attempts since the last successful connection. */
	attempts: number;
	/** Whether we have ever reached a connected state (distinguishes first connect). */
	hasConnected: boolean;
	/** Reboot-in-progress latch; cleared automatically once we reconnect. */
	rebooting: boolean;
	/**
	 * When the socket left the connected state, or `null` while connected. Stamped
	 * once at the START of a drop and never refreshed while it lasts, so it ages
	 * out deterministically — the same property that makes `connectionLostAt` safe
	 * to gate the HUD staleness clock on.
	 */
	disconnectedSince: number | null;
}

// ============================================
// Pure logic (rune-free, unit-testable)
// ============================================

/** The neutral starting point for {@link reduceConnection}. */
export function initialReconnectState(): ReconnectState {
	return {
		attempts: 0,
		hasConnected: false,
		rebooting: false,
		disconnectedSince: null,
	};
}

/**
 * Fold a raw connection-state transition into {@link ReconnectState}.
 *
 * - `connected`   → success: reset attempts, clear any reboot latch, and clear
 *                   the disconnect stamp.
 * - `connecting`  → counts as a *reconnect* attempt only once we have connected
 *                   at least once (the very first connect must not look like a
 *                   retry).
 * - `disconnected`/`error` → no attempt change (the following `connecting` is
 *                   what we count); reboot latch is preserved across the drop.
 *
 * Every non-connected state stamps `disconnectedSince` when it is not already
 * set, so the grace window starts at whichever event actually left the connected
 * state — a bare `disconnected`, or a `connecting` that arrived without one.
 * Re-stamping mid-drop would restart the window on every retry and the banner
 * would never appear.
 */
export function reduceConnection(
	prev: ReconnectState,
	state: ConnectionState,
	now: number,
): ReconnectState {
	if (state === "connected") {
		return {
			attempts: 0,
			hasConnected: true,
			rebooting: false,
			disconnectedSince: null,
		};
	}

	const dropped: ReconnectState =
		prev.disconnectedSince === null
			? { ...prev, disconnectedSince: now }
			: prev;

	return state === "connecting" && dropped.hasConnected
		? { ...dropped, attempts: dropped.attempts + 1 }
		: dropped;
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
 *
 * Only step 4's "reconnecting" treatment is debounced by
 * {@link RECONNECT_BANNER_GRACE_MS}. "rebooting" is an explicit operator action
 * that must surface immediately, and "failed" already implies
 * {@link MAX_RECONNECT_ATTEMPTS} backoff cycles have elapsed — delaying either
 * would hide something the operator already knows about or has waited out.
 */
export function deriveConnectionUx(
	input: ConnectionUxInput,
	now: number,
): ConnectionUx {
	const {
		isConnected,
		browserOnline,
		showOfflinePage,
		reconnectAttempts,
		rebooting,
		disconnectedSince,
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

	return {
		mode: "reconnecting",
		showBanner: hasOutlastedBannerGrace(disconnectedSince, now),
	};
}

/**
 * Whether a drop has persisted long enough to be worth telling the operator
 * about. An unstamped disconnect is treated as brand new rather than as
 * indefinitely old — a missing stamp must never be the reason a banner appears.
 */
export function hasOutlastedBannerGrace(
	disconnectedSince: number | null,
	now: number,
): boolean {
	if (disconnectedSince === null) return false;
	return now - disconnectedSince >= RECONNECT_BANNER_GRACE_MS;
}

export function reduceBrowserOfflineSince(
	previous: number | null,
	browserOnline: boolean,
	now: number,
): number | null {
	if (browserOnline) return null;
	return previous ?? now;
}

export function effectiveDisconnectedSince(
	socketDisconnectedSince: number | null,
	browserOfflineSince: number | null,
): number | null {
	if (socketDisconnectedSince === null) return browserOfflineSince;
	if (browserOfflineSince === null) return socketDisconnectedSince;
	return Math.min(socketDisconnectedSince, browserOfflineSince);
}

/**
 * Apply the reconnect banner's existing grace verdict to every other loud
 * connection-loss surface. An auth-only stall remains visible when no socket
 * drop is active; only connection-driven noise is delayed.
 *
 * There is deliberately NO third `showConnectionLostToast` field. It existed,
 * it was byte-identically the same boolean as `showOfflineBanner`, and
 * `PWAStatus` — which renders that banner — is mounted UNCONDITIONALLY by
 * `Layout.svelte`. So the toast could not fire in any state the banner was not
 * already stating, carried no information the banner did not, and arrived in
 * the same instant. One outage, one signal.
 */
export function deriveConnectionSurfaceUx(
	input: ConnectionSurfaceUxInput,
	now: number,
): ConnectionSurfaceUx {
	const showConnectionLoss = hasOutlastedBannerGrace(
		input.disconnectedSince,
		now,
	);
	return {
		showOfflineBanner: showConnectionLoss,
		showAuthTimeout:
			input.authTimedOut &&
			(input.disconnectedSince === null || showConnectionLoss),
	};
}

/**
 * Whether the grace clock still needs to tick. It runs ONLY inside the grace
 * window: before it, nothing can transition; after it, the banner is already up
 * and no further tick can change anything. Mirrors `isClockTickNeeded`'s
 * ages-out-deterministically gate rather than adding a second always-on timer.
 */
export function shouldRunBannerGraceClock(
	disconnectedSince: number | null,
	now: number,
): boolean {
	if (disconnectedSince === null) return false;
	return now - disconnectedSince < RECONNECT_BANNER_GRACE_MS;
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
	getHasConnected(): boolean;
	getIsRebooting(): boolean;
	getSessionExpired(): boolean;
	getDisconnectedSince(): number | null;
	getGraceNow(): number;
	isGraceClockRunning(): boolean;
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
	let graceNow = $state(Date.now());
	let browserOfflineSince = $state<number | null>(
		typeof navigator !== "undefined" && navigator.onLine === false
			? Date.now()
			: null,
	);
	const disconnectedSince = (): number | null =>
		effectiveDisconnectedSince(
			reconnect.disconnectedSince,
			browserOfflineSince,
		);

	// A drop fires no further connection events of its own, so without a tick the
	// grace window could never elapse and the banner would never appear.
	const graceClock = createStalenessClock(
		() => shouldRunBannerGraceClock(disconnectedSince(), Date.now()),
		() => {
			graceNow = Date.now();
		},
		RECONNECT_BANNER_TICK_MS,
	);

	// Client-level handler: survives socket replacement across reconnect cycles.
	const off = rpcClient.onConnectionChange((state) => {
		const now = Date.now();
		reconnect = reduceConnection(reconnect, state, now);
		graceNow = now;
		graceClock.sync();
	});
	const handleBrowserOffline = (): void => {
		const now = Date.now();
		browserOfflineSince = reduceBrowserOfflineSince(
			browserOfflineSince,
			false,
			now,
		);
		graceNow = now;
		graceClock.sync();
	};
	const handleBrowserOnline = (): void => {
		const now = Date.now();
		browserOfflineSince = reduceBrowserOfflineSince(
			browserOfflineSince,
			true,
			now,
		);
		graceNow = now;
		graceClock.sync();
	};
	if (typeof window !== "undefined") {
		window.addEventListener("offline", handleBrowserOffline);
		window.addEventListener("online", handleBrowserOnline);
		graceClock.sync();
	}

	return {
		getReconnectAttempts: () => reconnect.attempts,
		getHasConnected: () => reconnect.hasConnected,
		getIsRebooting: () => reconnect.rebooting,
		getSessionExpired: () => sessionExpired,
		getDisconnectedSince: disconnectedSince,
		getGraceNow: () => graceNow,
		isGraceClockRunning: () => graceClock.isRunning(),
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
			if (typeof window !== "undefined") {
				window.removeEventListener("offline", handleBrowserOffline);
				window.removeEventListener("online", handleBrowserOnline);
			}
			graceClock.stop();
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

/** Whether this page load has completed at least one socket connection. */
export function getHasConnected(): boolean {
	return store().getHasConnected();
}

/** Whether a reboot/poweroff is in progress (cleared automatically on reconnect). */
export function getIsRebooting(): boolean {
	return store().getIsRebooting();
}

/** Whether the session expired mid-session and re-authentication is required. */
export function getSessionExpired(): boolean {
	return store().getSessionExpired();
}

/** When the current disconnect started, or `null` while connected. */
export function getDisconnectedSince(): number | null {
	return store().getDisconnectedSince();
}

/** The grace clock's current reading — advances only while a drop is inside its window. */
export function getGraceNow(): number {
	return store().getGraceNow();
}

/** Whether the grace clock is ticking. Exposed for tests; it must never run while connected. */
export function isGraceClockRunning(): boolean {
	return store().isGraceClockRunning();
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
