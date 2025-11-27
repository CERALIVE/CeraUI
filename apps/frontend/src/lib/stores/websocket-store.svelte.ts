/**
 * WebSocket Store - Svelte 5 Runes Implementation
 *
 * This store manages all WebSocket communication with the backend.
 * Migrated from Svelte 4 writable stores to Svelte 5 runes ($state).
 *
 * Usage in components:
 * - Use getXxx() functions for reactive access in $derived or $effect
 * - Use XxxMessages.subscribe() for backward compatibility (deprecated)
 */
import { toast } from "svelte-sonner";

import { mergeModems } from "$lib/helpers/ObjectsHelper";
import { downloadLog } from "$lib/helpers/SystemHelper";

import { BUILD_INFO, ENV_VARIABLES } from "../env";
import type {
	AudioCodecsMessage,
	AuthMessage,
	ConfigMessage,
	NetifMessage,
	NotificationsMessage,
	PipelinesMessage,
	RelayMessage,
	RevisionsMessage,
	SensorsStatusMessage,
	StatusMessage,
	WifiMessage,
} from "../types/socket-messages";
import {
	forceVersionChangeNotification,
	getFrontendVersionInfo,
	resetFrontendVersionTracking,
} from "./frontend-version.svelte";
import { CLIENT_VERSION } from "./version-manager";

// ============================================
// Svelte 5 Reactive State ($state)
// ============================================
let authState = $state<AuthMessage | undefined>(undefined);
let audioCodecsState = $state<AudioCodecsMessage | undefined>(undefined);
let configState = $state<ConfigMessage | undefined>(undefined);
let netifState = $state<NetifMessage | undefined>(undefined);
let notificationsState = $state<NotificationsMessage | undefined>(undefined);
let pipelinesState = $state<PipelinesMessage | undefined>(undefined);
let relaysState = $state<RelayMessage | undefined>(undefined);
let revisionsState = $state<RevisionsMessage | undefined>(undefined);
let sensorsStatusState = $state<SensorsStatusMessage | undefined>(undefined);
let statusState = $state<StatusMessage | undefined>(undefined);
let wifiState = $state<WifiMessage | undefined>(undefined);

// ============================================
// Reactive Getters (Svelte 5 Pattern)
// ============================================
export function getAuth() {
	return authState;
}
export function getAudioCodecs() {
	return audioCodecsState;
}
export function getConfig() {
	return configState;
}
export function getNetif() {
	return netifState;
}
export function getNotifications() {
	return notificationsState;
}
export function getPipelines() {
	return pipelinesState;
}
export function getRelays() {
	return relaysState;
}
export function getRevisions() {
	return revisionsState;
}
export function getSensorsStatus() {
	return sensorsStatusState;
}
export function getStatus() {
	return statusState;
}
export function getWifi() {
	return wifiState;
}

// ============================================
// Backward-Compatible Store Interface
// For gradual migration - components using .subscribe() will still work
// ============================================
type Subscriber<T> = (value: T) => void;
type Unsubscriber = () => void;

interface ReadableStore<T> {
	subscribe: (fn: Subscriber<T>) => Unsubscriber;
}

function createReadableFromState<T>(
	getState: () => T,
	setState: (value: T) => void,
): ReadableStore<T> & { _set: (value: T) => void } {
	const subscribers = new Set<Subscriber<T>>();

	return {
		subscribe(fn: Subscriber<T>): Unsubscriber {
			subscribers.add(fn);
			// Immediately call with current value
			fn(getState());
			return () => {
				subscribers.delete(fn);
			};
		},
		_set(value: T) {
			setState(value);
			// Notify all subscribers
			for (const fn of subscribers) {
				fn(value);
			}
		},
	};
}

// Create backward-compatible stores
const AuthStore = createReadableFromState(
	() => authState,
	(v) => {
		authState = v;
	},
);
const AudioCodecsStore = createReadableFromState(
	() => audioCodecsState,
	(v) => {
		audioCodecsState = v;
	},
);
const ConfigStore = createReadableFromState(
	() => configState,
	(v) => {
		configState = v;
	},
);
const NetifStore = createReadableFromState(
	() => netifState,
	(v) => {
		netifState = v;
	},
);
const NotificationsStore = createReadableFromState(
	() => notificationsState,
	(v) => {
		notificationsState = v;
	},
);
const PipelinesStore = createReadableFromState(
	() => pipelinesState,
	(v) => {
		pipelinesState = v;
	},
);
const RelaysStore = createReadableFromState(
	() => relaysState,
	(v) => {
		relaysState = v;
	},
);
const RevisionsStore = createReadableFromState(
	() => revisionsState,
	(v) => {
		revisionsState = v;
	},
);
const SensorsStatusStore = createReadableFromState(
	() => sensorsStatusState,
	(v) => {
		sensorsStatusState = v;
	},
);
const StatusStore = createReadableFromState(
	() => statusState,
	(v) => {
		statusState = v;
	},
);
const WifiStore = createReadableFromState(
	() => wifiState,
	(v) => {
		wifiState = v;
	},
);

// ============================================
// WebSocket Connection
// ============================================
const connectionUrl = `${ENV_VARIABLES.SOCKET_ENDPOINT}:${ENV_VARIABLES.SOCKET_PORT}`;

// Simple offline-safe WebSocket initialization
let socket: WebSocket;
try {
	socket = new WebSocket(connectionUrl);
} catch (error) {
	console.warn("WebSocket initialization failed (likely offline):", error);
	// Create a dummy socket object to prevent errors
	socket = {
		readyState: WebSocket.CLOSED,
		send: () => {},
		close: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
	} as Partial<WebSocket> as WebSocket;
}

// Enhanced connection monitoring
let lastActivityTime = Date.now();
let activityTimeout: number | null = null;
let keepAliveInterval: number | null = null;

// Connection opened
socket.addEventListener("open", () => {
	toast.success("Connection", {
		duration: 3000,
		description: "Connection established successfully",
	});

	// Start enhanced keep-alive with activity monitoring
	if (keepAliveInterval) clearInterval(keepAliveInterval);

	keepAliveInterval = window.setInterval(() => {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ keepalive: null }));

			// Check if we've received ANY messages recently
			if (activityTimeout) clearTimeout(activityTimeout);
			activityTimeout = window.setTimeout(() => {
				const timeSinceLastActivity = Date.now() - lastActivityTime;
				if (timeSinceLastActivity > 20000) {
					// 20 seconds without ANY message
					console.warn("No message activity received, connection may be dead");
					// Force reconnection by closing and reopening
					socket.close();
					window.location.reload();
				}
			}, 15000); // Check after 15 seconds
		}
	}, 10000);
});

socket.addEventListener("error", () => {
	toast.error("Connection Error", {
		duration: 5000,
		description: "Connection lost, attempting to reconnect...",
	});
});

// Listen for messages
socket.addEventListener("message", (event: MessageEvent<string>) => {
	// Update activity time for connection monitoring
	lastActivityTime = Date.now();
	if (activityTimeout) {
		clearTimeout(activityTimeout);
		activityTimeout = null;
	}

	assignMessage(event.data);
});

// ============================================
// Message Handling
// ============================================
function sendCreatePasswordMessage(password: string) {
	sendMessage(JSON.stringify({ config: { password } }));
	StatusStore._set({ ...statusState, set_password: false } as StatusMessage);
	toast.message("Creating password", {
		duration: 5000,
		description: "Creating the access password for your device",
	});
}

function sendAuthMessage(
	password: string,
	isPersistent: boolean,
	onError: (() => unknown) | undefined = undefined,
) {
	const auth_req = { auth: { password, persistent_token: isPersistent } };
	sendMessage(JSON.stringify(auth_req), () => {
		toast.error("Authentication failed", {
			duration: 5000,
			description: "The connection with the server could not be established",
		});
		onError?.();
	});
}

const assignMessage = (message: string) => {
	const parsedMessage = JSON.parse(message);
	const messageType = Object.keys(parsedMessage)[0];

	switch (messageType) {
		case "auth":
			AuthStore._set(parsedMessage.auth);
			break;
		case "acodecs":
			AudioCodecsStore._set(parsedMessage.acodecs);
			break;
		case "config":
			ConfigStore._set(parsedMessage.config);
			break;
		case "netif":
			NetifStore._set(parsedMessage.netif);
			break;
		case "notification":
			NotificationsStore._set(parsedMessage.notification);
			break;
		case "pipelines":
			PipelinesStore._set(parsedMessage.pipelines);
			break;
		case "relays":
			RelaysStore._set(parsedMessage.relays);
			break;
		case "revisions":
			RevisionsStore._set(parsedMessage.revisions);
			break;
		case "sensors":
			SensorsStatusStore._set(parsedMessage.sensors);
			break;
		case "status":
			{
				const currentStatus = statusState;
				if (parsedMessage.status.modems) {
					StatusStore._set({
						...currentStatus,
						...parsedMessage.status,
						modems: mergeModems(
							currentStatus?.modems ? currentStatus.modems : {},
							parsedMessage.status?.modems,
						),
					});
				} else {
					StatusStore._set({ ...currentStatus, ...parsedMessage.status });
				}
			}
			break;
		case "wifi":
			WifiStore._set(parsedMessage.wifi);
			break;
		case "log":
			downloadLog(parsedMessage.log);
			break;
	}
};

// ============================================
// Send Message Utilities
// ============================================
const sendMessage = (
	message: string,
	onTimeout: (() => unknown) | undefined = undefined,
) => {
	waitForSocketConnection(
		socket,
		50,
		() => {
			socket.send(message);
		},
		10000,
		onTimeout,
	);
};

// Make the function wait until the connection is made...
function waitForSocketConnection(
	socket: WebSocket,
	checkTime: number,
	callback: () => unknown,
	maxWaitingTime: number = 10000,
	onTimeout: undefined | (() => unknown) = undefined,
	executionTime = 0,
) {
	setTimeout(() => {
		if (socket.readyState === 1) {
			if (callback != null) {
				callback();
			}
		} else {
			executionTime += checkTime;
			if (executionTime >= maxWaitingTime) {
				console.warn("Timeout Reached awaiting for socket connection.");
				onTimeout?.();
			} else {
				waitForSocketConnection(
					socket,
					checkTime,
					callback,
					maxWaitingTime,
					onTimeout,
					executionTime,
				);
			}
		}
	}, checkTime);
}

// ============================================
// Backward-Compatible Exports (Svelte 4 style)
// These maintain the same API as the old store for gradual migration
// ============================================
const AuthMessages = AuthStore as ReadableStore<AuthMessage | undefined>;
const AudioCodecsMessages = AudioCodecsStore as ReadableStore<
	AudioCodecsMessage | undefined
>;
const ConfigMessages = ConfigStore as ReadableStore<ConfigMessage | undefined>;
const NetifMessages = NetifStore as ReadableStore<NetifMessage | undefined>;
const NotificationsMessages = NotificationsStore as ReadableStore<
	NotificationsMessage | undefined
>;
const PipelinesMessages = PipelinesStore as ReadableStore<
	PipelinesMessage | undefined
>;
const RelaysMessages = RelaysStore as ReadableStore<RelayMessage | undefined>;
const RevisionsMessages = RevisionsStore as ReadableStore<
	RevisionsMessage | undefined
>;
const SensorsStatusMessages = SensorsStatusStore as ReadableStore<
	SensorsStatusMessage | undefined
>;
const StatusMessages = StatusStore as ReadableStore<StatusMessage | undefined>;
const WifiMessages = WifiStore as ReadableStore<WifiMessage | undefined>;

// ============================================
// Exports
// ============================================
export {
	// Backward-compatible store exports (for .subscribe() pattern)
	AudioCodecsMessages,
	AuthMessages,
	ConfigMessages,
	NetifMessages,
	NotificationsMessages,
	PipelinesMessages,
	RelaysMessages,
	RevisionsMessages,
	SensorsStatusMessages,
	StatusMessages,
	WifiMessages,
	// Functions
	sendAuthMessage,
	sendCreatePasswordMessage,
	sendMessage,
	// Socket instance
	socket,
};

// ============================================
// Debug Functions (Development Only)
// ============================================
if (typeof window !== "undefined" && !BUILD_INFO.IS_PROD) {
	interface WindowWithVersionDebug extends Window {
		versionDebug?: {
			clientVersion: () => string;
			frontendVersionInfo: typeof getFrontendVersionInfo;
			resetFrontendTracking: typeof resetFrontendVersionTracking;
			forceVersionNotification: typeof forceVersionChangeNotification;
		};
	}

	(window as WindowWithVersionDebug).versionDebug = {
		clientVersion: () => CLIENT_VERSION,
		frontendVersionInfo: getFrontendVersionInfo,
		resetFrontendTracking: resetFrontendVersionTracking,
		forceVersionNotification: forceVersionChangeNotification,
	};
}
