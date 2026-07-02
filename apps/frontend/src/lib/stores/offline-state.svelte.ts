// Offline state detection using pure Svelte 5 runes
// Simplified version without legacy store compatibility
import { rpcClient, type ConnectionState } from "$lib/rpc/client";
import { getIsOnline } from "./pwa.svelte";

// ============================================
// Reactive State (Svelte 5 runes)
// ============================================
let connectionState = $state<ConnectionState>("connecting");
let shouldShowOfflinePageState = $state(false);

// ============================================
// Constants
// ============================================
const OFFLINE_THRESHOLD = 3000;
const PERIODIC_CHECK_INTERVAL = 5000;

// ============================================
// Internal State
// ============================================
let offlineStartTime: number | null = null;
let offlineTimeout: number | null = null;
let periodicCheckInterval: number | null = null;
let hasCheckedInitialState = false;

// ============================================
// Getters
// ============================================
export function getConnectionState(): ConnectionState {
	return connectionState;
}

export function getShouldShowOfflinePage(): boolean {
	return shouldShowOfflinePageState;
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

function stopPeriodicCheck() {
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
			shouldShowOfflinePageState = false;
			stopPeriodicCheck();
			offlineStartTime = null;

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

// ============================================
// Offline State Management
// ============================================
function checkOfflineState() {
	const offline = getIsFullyOffline();

	if (offline) {
		if (offlineStartTime === null) {
			offlineStartTime = Date.now();
			const threshold = hasCheckedInitialState ? OFFLINE_THRESHOLD : 0;

			if (threshold > 0) {
				offlineTimeout = window.setTimeout(() => {
					shouldShowOfflinePageState = true;
					startPeriodicCheck();
				}, threshold);
			}
		}
	} else {
		if (offlineTimeout) {
			clearTimeout(offlineTimeout);
			offlineTimeout = null;
		}
		stopPeriodicCheck();
		offlineStartTime = null;
		shouldShowOfflinePageState = false;
	}
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
function handleOffline() {
	shouldShowOfflinePageState = true;
	startPeriodicCheck();
	offlineStartTime = Date.now();
}

async function handleOnline() {
	await new Promise((r) => setTimeout(r, 500));
	const canConnect = await checkConnection();
	if (canConnect) {
		shouldShowOfflinePageState = false;
		stopPeriodicCheck();
		offlineStartTime = null;
	}
}

// ============================================
// Initial Connectivity Check
// ============================================
async function checkInitialConnectivity() {
	if (!navigator.onLine) {
		shouldShowOfflinePageState = true;
		startPeriodicCheck();
		offlineStartTime = Date.now();
		hasCheckedInitialState = true;
		return;
	}

	await new Promise((r) => setTimeout(r, 200));
	const canConnect = await checkConnection(true);
	if (!canConnect) {
		shouldShowOfflinePageState = true;
		startPeriodicCheck();
		offlineStartTime = Date.now();
	}
	hasCheckedInitialState = true;
}

// ============================================
// Initialize
// ============================================
initConnectionTracking();

if (typeof window !== "undefined") {
	window.addEventListener("offline", handleOffline);
	window.addEventListener("online", () => void handleOnline());
	void checkInitialConnectivity();
}

// ============================================
// Public API
// ============================================
export function showOfflinePage() {
	shouldShowOfflinePageState = true;
}

export function hideOfflinePage() {
	shouldShowOfflinePageState = false;
}

export function resetOfflineDetection() {
	if (offlineTimeout) {
		clearTimeout(offlineTimeout);
		offlineTimeout = null;
	}
	stopPeriodicCheck();
	offlineStartTime = null;
	shouldShowOfflinePageState = false;
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
	window.removeEventListener("offline", handleOffline);
	window.removeEventListener("online", () => void handleOnline());

	if (offlineTimeout) {
		clearTimeout(offlineTimeout);
		offlineTimeout = null;
	}
	stopPeriodicCheck();
}

// ============================================
// Reactive Exports (for use with $derived in components)
// ============================================

// Store-like object for backwards compatibility with $store syntax
export const shouldShowOfflinePage = {
	get current() {
		return shouldShowOfflinePageState;
	},
	subscribe(
		callback: (value: boolean) => () => undefined | undefined,
	): () => void {
		// Simple subscription - call immediately with current value
		callback(shouldShowOfflinePageState);
		// Return unsubscribe (no-op for now, Svelte 5 components don't need this)
		return () => {
			/* no-op unsubscribe */
		};
	},
};
