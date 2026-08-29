/**
 * Browser-offline recovery state — the full-page {@link OfflinePage} takeover,
 * the pre-auth connection-state strip (`Auth.svelte`), and the `/favicon.ico`
 * recovery poll.
 *
 * Reconnect-surface grace period
 * ------------------------------
 * This store owns the offline-page REQUEST; it does NOT own the decision to put
 * it on screen. That decision is the ONE debounced connection-loss verdict
 * `connection-ux.svelte` already projects onto every other loss surface
 * ({@link hasOutlastedBannerGrace} over `getDisconnectedSince()`), so the
 * full-page takeover, the pre-auth top banner and the authenticated
 * `DisconnectedBanner` share one grace verdict. After a successful connection,
 * a socket-only loss belongs to the banner; the takeover is reserved for a
 * browser-offline edge so its origin poll cannot reload a healthy page.
 *
 * WHY: this file used to run a SECOND, parallel offline detector with its own
 * 3 s constant, and the browser `offline` event bypassed even that — it set the
 * takeover flag synchronously. So the half-open-socket detector's ordinary
 * quiet-socket re-dial (most heal in well under a second) could throw the whole
 * screen away instantly while every smaller surface correctly stayed silent.
 * The two systems agreeing numerically is not the same as there being one.
 *
 * Time is INJECTED, never read inside {@link deriveOfflinePageVisible}, mirroring
 * `deriveConnectionUx(input, now)` / `reduceConnection(prev, state, now)`.
 */
import { type ConnectionState, rpcClient } from "$lib/rpc/client";

import {
	getDisconnectedSince,
	getGraceNow,
	getHasConnected,
	hasOutlastedBannerGrace,
	RECONNECT_BANNER_GRACE_MS,
} from "./connection-ux.svelte";
import { getIsOnline } from "./pwa.svelte";

// ============================================
// Types
// ============================================

/**
 * What is asking for the full-page recovery takeover.
 *
 * - `none`      — nothing is.
 * - `immediate` — a request that must NOT be debounced: a page load that could
 *                 not reach its own origin at all, or the imperative
 *                 {@link showOfflinePage} escape hatch. There is no transient
 *                 drop to wait out when a connection was never established, and
 *                 holding a blank shell for the grace would only hide the one
 *                 surface that can explain it.
 * - `debounced` — an ordinary connection-loss request. Reaches the screen only
 *                 once the drop has outlasted {@link RECONNECT_BANNER_GRACE_MS}.
 */
export type OfflinePageRequest = "none" | "immediate" | "debounced";

// ============================================
// Reactive State (Svelte 5 runes)
// ============================================
let connectionState = $state<ConnectionState>("connecting");
let offlinePageRequest = $state<OfflinePageRequest>("none");

// ============================================
// Constants
// ============================================
/** Recovery-poll cadence. Exported so a test names it instead of a literal. */
export const PERIODIC_CHECK_INTERVAL = 5000;

// ============================================
// Internal State
// ============================================
/** When THIS store first saw the current outage; a latch, not a clock source. */
let offlineStartTime: number | null = null;
/** Pending arm of the recovery poll (fires at the grace boundary). */
let periodicCheckArm: number | null = null;
let periodicCheckInterval: number | null = null;

// ============================================
// Pure logic (rune-free, unit-testable)
// ============================================

/**
 * Whether an offline-page request has earned the screen yet.
 *
 * Pure: `now` and the disconnect stamp are injected so the rule is testable
 * without runes, a browser, or a clock — the same contract
 * `deriveConnectionUx(input, now)` follows.
 */
export function deriveOfflinePageVisible(
	request: OfflinePageRequest,
	hasConnected: boolean,
	disconnectedSince: number | null,
	now: number,
): boolean {
	if (request === "none") return false;
	if (request === "immediate") return true;
	// A page that has never completed a connection keeps its immediate recovery
	// page: there is no transient drop to wait out, and the shared stamp may not
	// exist yet at all.
	if (!hasConnected) return true;
	return hasOutlastedBannerGrace(disconnectedSince, now);
}

// ============================================
// Getters
// ============================================
export function getConnectionState(): ConnectionState {
	return connectionState;
}

/** The raw request, before the shared grace is applied. Exposed for tests. */
export function getOfflinePageRequest(): OfflinePageRequest {
	return offlinePageRequest;
}

/**
 * The ONE debounced verdict for the full-page takeover. Reads the shared grace
 * clock (`getGraceNow()`), which is what re-derives this while a drop sits
 * inside its window — no event of its own fires there.
 */
export function getShouldShowOfflinePage(): boolean {
	return deriveOfflinePageVisible(
		offlinePageRequest,
		getHasConnected(),
		getDisconnectedSince(),
		getGraceNow(),
	);
}

export function getIsFullyOffline(): boolean {
	return (
		!getIsOnline() ||
		connectionState === "disconnected" ||
		connectionState === "error"
	);
}

// ============================================
// Connection Checking
// ============================================
export async function checkConnection(
	isInitialCheck = false,
): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeout = isInitialCheck ? 500 : 2000;
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		await fetch(`${window.location.origin}/favicon.ico`, {
			method: "HEAD",
			signal: controller.signal,
			cache: "no-cache",
		});

		clearTimeout(timeoutId);
		return true;
	} catch {
		return false;
	}
}

function disarmPeriodicCheck() {
	if (periodicCheckArm !== null) {
		clearTimeout(periodicCheckArm);
		periodicCheckArm = null;
	}
}

function stopPeriodicCheck() {
	disarmPeriodicCheck();
	if (periodicCheckInterval) {
		clearInterval(periodicCheckInterval);
		periodicCheckInterval = null;
	}
}

function startPeriodicCheck() {
	stopPeriodicCheck();

	periodicCheckInterval = window.setInterval(async () => {
		const canConnect = await checkConnection();
		if (canConnect) {
			clearOfflineRequest();

			// Reload to reconnect WebSocket
			const isPWA =
				window.matchMedia("(display-mode: standalone)").matches ||
				(window.navigator as unknown as { standalone?: boolean }).standalone;

			if (isPWA || rpcClient.getConnectionState() !== "connected") {
				window.location.reload();
			}
		}
	}, PERIODIC_CHECK_INTERVAL);
}

/**
 * Arm the recovery poll.
 *
 * It RELOADS the page when the origin answers again, so an ordinary drop must
 * not arm it before the shared grace has elapsed — a blip that heals inside the
 * window would otherwise cost a PWA operator a full reload for an outage they
 * were never even shown.
 */
function armPeriodicCheck(delayMs: number) {
	if (typeof window === "undefined") return;
	if (periodicCheckInterval !== null || periodicCheckArm !== null) return;
	if (delayMs <= 0) {
		startPeriodicCheck();
		return;
	}
	periodicCheckArm = window.setTimeout(() => {
		periodicCheckArm = null;
		startPeriodicCheck();
	}, delayMs);
}

// ============================================
// Offline State Management
// ============================================

/**
 * Record that an ordinary connection loss wants the takeover. Whether it gets
 * one is {@link deriveOfflinePageVisible}'s call, not this function's.
 *
 * Latched on {@link offlineStartTime} so a socket drop followed by a browser
 * `offline` event (or vice versa) is ONE outage, not two — re-entering would
 * re-arm the recovery poll mid-window.
 */
function requestDebouncedOfflinePage() {
	if (offlineStartTime !== null) return;
	offlineStartTime = Date.now();
	offlinePageRequest = "debounced";
	armPeriodicCheck(RECONNECT_BANNER_GRACE_MS);
}

/**
 * A page load that could not reach its own origin. Immediate by construction —
 * see {@link OfflinePageRequest}.
 */
function requestImmediateOfflinePage() {
	offlinePageRequest = "immediate";
	offlineStartTime ??= Date.now();
	armPeriodicCheck(0);
}

function clearOfflineRequest() {
	stopPeriodicCheck();
	offlineStartTime = null;
	offlinePageRequest = "none";
}

function checkOfflineState() {
	if (!getIsOnline() || (!getHasConnected() && getIsFullyOffline()))
		requestDebouncedOfflinePage();
	else clearOfflineRequest();
}

function setConnectionState(state: ConnectionState) {
	connectionState = state;
	checkOfflineState();
}

// ============================================
// Connection State Ingestion
// ============================================
// Pre-auth strip source (Auth.svelte): tracks the client's transport-level signal,
// not a captured socket, so it survives socket replacement on reconnect.
// onConnectionChange never replays current state, so seed before subscribing.
let unsubscribeConnection: (() => void) | null = null;

function initConnectionTracking() {
	setConnectionState(rpcClient.getConnectionState());
	unsubscribeConnection = rpcClient.onConnectionChange(setConnectionState);
}

// ============================================
// Browser Event Handlers
// ============================================
/**
 * The browser's own `offline` edge is NOT a render decision. It records the same
 * debounced request a socket drop does — `connection-ux` stamps this identical
 * edge for the shared grace window, so both halves of one outage are measured
 * from one origin.
 *
 * It deliberately does NOT consult {@link getIsFullyOffline}: `pwa.svelte` reads
 * `navigator.onLine` from its own listener, and depending on listener
 * registration order to have already run would make this correct only by
 * accident.
 */
function handleOffline() {
	requestDebouncedOfflinePage();
}

async function handleOnline() {
	await new Promise((r) => setTimeout(r, 500));
	const canConnect = await checkConnection();
	if (canConnect) clearOfflineRequest();
}

const handleOnlineEvent = (): void => {
	void handleOnline();
};

// ============================================
// Initial Connectivity Check
// ============================================
async function checkInitialConnectivity() {
	if (!navigator.onLine) {
		requestImmediateOfflinePage();
		return;
	}

	await new Promise((r) => setTimeout(r, 200));
	const canConnect = await checkConnection(true);
	if (!canConnect) requestImmediateOfflinePage();
}

// ============================================
// Initialize
// ============================================
initConnectionTracking();

if (typeof window !== "undefined") {
	window.addEventListener("offline", handleOffline);
	window.addEventListener("online", handleOnlineEvent);
	void checkInitialConnectivity();
}

// ============================================
// Public API
// ============================================

/**
 * Force the takeover on. An explicit imperative call is a decision, not a
 * transient, so it is never debounced. Side-effect free: it does not arm the
 * reload-capable recovery poll.
 */
export function showOfflinePage() {
	offlinePageRequest = "immediate";
}

export function hideOfflinePage() {
	offlinePageRequest = "none";
}

export function resetOfflineDetection() {
	clearOfflineRequest();
}

export async function manualConnectionCheck(): Promise<boolean> {
	const canConnect = await checkConnection();
	if (canConnect) {
		resetOfflineDetection();

		const isPWA =
			window.matchMedia("(display-mode: standalone)").matches ||
			(window.navigator as unknown as { standalone?: boolean }).standalone;

		setTimeout(() => window.location.reload(), isPWA ? 300 : 500);
		return true;
	}
	return false;
}

export function cleanup() {
	unsubscribeConnection?.();
	unsubscribeConnection = null;
	// Both handlers are module-level references on purpose: the online listener
	// used to be removed with a freshly-allocated arrow, which removes nothing.
	window.removeEventListener("offline", handleOffline);
	window.removeEventListener("online", handleOnlineEvent);

	stopPeriodicCheck();
}

// ============================================
// Reactive Exports (for use with $derived in components)
// ============================================

// Store-like object for backwards compatibility with $store syntax
export const shouldShowOfflinePage = {
	get current() {
		return getShouldShowOfflinePage();
	},
	subscribe(
		callback: (value: boolean) => () => undefined | undefined,
	): () => void {
		// Simple subscription - call immediately with current value
		callback(getShouldShowOfflinePage());
		// Return unsubscribe (no-op for now, Svelte 5 components don't need this)
		return () => {
			/* no-op unsubscribe */
		};
	},
};
