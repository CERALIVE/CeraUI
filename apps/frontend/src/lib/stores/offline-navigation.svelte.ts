// Offline navigation detection using Svelte 5 runes
import { getIsOnline } from "./pwa.svelte";
import { socket } from "./websocket-store";

// Connection state type
type ConnectionStateType = "connected" | "connecting" | "disconnected" | "error";

// Reactive state
let connectionState = $state<ConnectionStateType>("connecting");
let shouldShowOfflinePageState = $state(false);

// Subscriber management
type Subscriber<T> = (value: T) => void;
const connectionSubscribers = new Set<Subscriber<ConnectionStateType>>();
const offlinePageSubscribers = new Set<Subscriber<boolean>>();
const fullyOfflineSubscribers = new Set<Subscriber<boolean>>();

function notifyConnectionSubscribers() {
	for (const sub of connectionSubscribers) sub(connectionState);
	notifyFullyOfflineSubscribers();
}

function notifyOfflinePageSubscribers() {
	for (const sub of offlinePageSubscribers) sub(shouldShowOfflinePageState);
}

function notifyFullyOfflineSubscribers() {
	const isFullyOfflineValue = !getIsOnline() || 
		connectionState === "disconnected" || 
		connectionState === "error";
	for (const sub of fullyOfflineSubscribers) sub(isFullyOfflineValue);
}

// Getters
export function getConnectionState(): ConnectionStateType {
	return connectionState;
}

export function getShouldShowOfflinePage(): boolean {
	return shouldShowOfflinePageState;
}

export function getIsFullyOffline(): boolean {
	return !getIsOnline() || 
		connectionState === "disconnected" || 
		connectionState === "error";
}

// Setters
function setConnectionState(state: ConnectionStateType): void {
	connectionState = state;
	notifyConnectionSubscribers();
	checkOfflineState();
}

function setShouldShowOfflinePage(show: boolean): void {
	shouldShowOfflinePageState = show;
	notifyOfflinePageSubscribers();
}

// Monitor socket state
function updateConnectionState() {
	if (!socket) {
		setConnectionState("disconnected");
		return;
	}

	if (socket.readyState === WebSocket.OPEN) {
		setConnectionState("connected");
	} else if (socket.readyState === WebSocket.CONNECTING) {
		setConnectionState("connecting");
	} else {
		setConnectionState("disconnected");
	}
}

function handleSocketError() {
	setConnectionState("error");
}

// Set initial state and add event listeners
updateConnectionState();
socket.addEventListener("open", updateConnectionState);
socket.addEventListener("close", updateConnectionState);
socket.addEventListener("error", handleSocketError);

// Offline detection logic
let offlineStartTime: number | null = null;
let offlineTimeout: number | null = null;
let periodicCheckInterval: number | null = null;
const OFFLINE_THRESHOLD = 3000;
const PERIODIC_CHECK_INTERVAL = 5000;

// Check connection function
export async function checkConnection(isInitialCheck = false): Promise<boolean> {
	try {
		if (isInitialCheck) {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 500);

			try {
				await fetch(`${window.location.origin}/favicon.ico`, {
					method: "HEAD",
					signal: controller.signal,
					cache: "no-cache",
				});
				clearTimeout(timeoutId);
				return true;
			} catch {
				clearTimeout(timeoutId);
				const timeoutId2 = setTimeout(() => controller.abort(), 300);
				await fetch(`${window.location.origin}/`, {
					method: "HEAD",
					mode: "no-cors",
					signal: controller.signal,
					cache: "no-cache",
				});
				clearTimeout(timeoutId2);
				return true;
			}
		} else {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 2000);

			await fetch(`${window.location.origin}/`, {
				method: "HEAD",
				mode: "no-cors",
				signal: controller.signal,
				cache: "no-cache",
			});

			clearTimeout(timeoutId);
			return true;
		}
	} catch {
		return false;
	}
}

// Periodic connection checking
function startPeriodicConnectionCheck() {
	if (periodicCheckInterval) {
		clearInterval(periodicCheckInterval);
	}

	periodicCheckInterval = window.setInterval(async () => {
		const canConnect = await checkConnection();
		if (canConnect) {
			setShouldShowOfflinePage(false);
			stopPeriodicConnectionCheck();
			offlineStartTime = null;

			const isPWA =
				window.matchMedia("(display-mode: standalone)").matches ||
				(window.navigator as typeof navigator & { standalone?: boolean }).standalone ||
				document.referrer.includes("android-app://");

			if (isPWA) {
				window.location.reload();
			} else if (!socket || socket.readyState !== WebSocket.OPEN) {
				window.location.reload();
			}
		}
	}, PERIODIC_CHECK_INTERVAL);
}

function stopPeriodicConnectionCheck() {
	if (periodicCheckInterval) {
		clearInterval(periodicCheckInterval);
		periodicCheckInterval = null;
	}
}

// Initial connectivity check
let hasCheckedInitialState = false;

function checkInitialConnectivity() {
	if (!navigator.onLine) {
		setShouldShowOfflinePage(true);
		startPeriodicConnectionCheck();
		offlineStartTime = Date.now();
		hasCheckedInitialState = true;
		return;
	}

	setTimeout(async () => {
		try {
			const canConnect = await checkConnection(true);
			if (!canConnect) {
				setShouldShowOfflinePage(true);
				startPeriodicConnectionCheck();
				offlineStartTime = Date.now();
			}
		} catch {
			setShouldShowOfflinePage(true);
			startPeriodicConnectionCheck();
			offlineStartTime = Date.now();
		}
		hasCheckedInitialState = true;
	}, 200);
}

// Browser offline/online handlers
const handleOffline = () => {
	setShouldShowOfflinePage(true);
	startPeriodicConnectionCheck();
	offlineStartTime = Date.now();
};

const handleOnline = () => {
	setTimeout(async () => {
		const canConnect = await checkConnection();
		if (canConnect) {
			setShouldShowOfflinePage(false);
			stopPeriodicConnectionCheck();
			offlineStartTime = null;
		}
	}, 500);
};

window.addEventListener("offline", handleOffline);
window.addEventListener("online", handleOnline);

// Run initial check
checkInitialConnectivity();

// Check offline state when connection changes
function checkOfflineState() {
	const offline = getIsFullyOffline();
	
	if (offline) {
		if (offlineStartTime === null) {
			offlineStartTime = Date.now();
			const threshold = hasCheckedInitialState ? OFFLINE_THRESHOLD : 0;

			if (threshold > 0) {
				offlineTimeout = window.setTimeout(() => {
					setShouldShowOfflinePage(true);
					startPeriodicConnectionCheck();
				}, threshold);
			}
		}
	} else {
		if (offlineTimeout) {
			clearTimeout(offlineTimeout);
			offlineTimeout = null;
		}
		stopPeriodicConnectionCheck();
		offlineStartTime = null;
		setShouldShowOfflinePage(false);
	}
}

// Store-compatible exports
export const shouldShowOfflinePage = {
	get value() { return shouldShowOfflinePageState; },
	set(value: boolean) { setShouldShowOfflinePage(value); },
	subscribe(callback: Subscriber<boolean>): () => void {
		offlinePageSubscribers.add(callback);
		callback(shouldShowOfflinePageState);
		return () => offlinePageSubscribers.delete(callback);
	},
};

export const isFullyOffline = {
	get value() { return getIsFullyOffline(); },
	subscribe(callback: Subscriber<boolean>): () => void {
		fullyOfflineSubscribers.add(callback);
		callback(getIsFullyOffline());
		return () => fullyOfflineSubscribers.delete(callback);
	},
};

// Manual control functions
export function showOfflinePage() {
	setShouldShowOfflinePage(true);
}

export function hideOfflinePage() {
	setShouldShowOfflinePage(false);
}

export function resetOfflineDetection() {
	if (offlineTimeout) {
		clearTimeout(offlineTimeout);
		offlineTimeout = null;
	}
	stopPeriodicConnectionCheck();
	offlineStartTime = null;
	setShouldShowOfflinePage(false);
}

export async function manualConnectionCheck(): Promise<boolean> {
	const canConnect = await checkConnection();
	if (canConnect) {
		resetOfflineDetection();

		const isPWA =
			window.matchMedia("(display-mode: standalone)").matches ||
			(window.navigator as typeof navigator & { standalone?: boolean }).standalone ||
			document.referrer.includes("android-app://");

		if (isPWA) {
			setTimeout(() => window.location.reload(), 300);
		} else {
			setTimeout(() => window.location.reload(), 500);
		}
		return true;
	}
	return false;
}

// Cleanup function
export function cleanup() {
	socket.removeEventListener("open", updateConnectionState);
	socket.removeEventListener("close", updateConnectionState);
	socket.removeEventListener("error", handleSocketError);
	window.removeEventListener("offline", handleOffline);
	window.removeEventListener("online", handleOnline);

	if (offlineTimeout) {
		clearTimeout(offlineTimeout);
		offlineTimeout = null;
	}
	stopPeriodicConnectionCheck();
}

