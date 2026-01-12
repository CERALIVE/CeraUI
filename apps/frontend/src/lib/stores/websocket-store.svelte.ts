/**
 * WebSocket Store - Svelte 5 Runes Implementation
 *
 * This module now wraps the new RPC client for backward compatibility.
 * New code should import from $lib/rpc directly.
 *
 * @deprecated Use $lib/rpc imports directly for new code
 */
import type {
	AudioCodecsMessage,
	ConfigMessage,
	LoginOutput,
	NetifMessage,
	NotificationsMessage,
	PipelinesMessage,
	RelayMessage,
	Revisions,
	SensorsStatus,
	StatusMessage,
	WifiMessage,
} from "@ceraui/rpc/schemas";
import { toast } from "svelte-sonner";

import { mergeModems } from "$lib/helpers/ObjectsHelper";
import { downloadLog } from "$lib/helpers/SystemHelper";
import { rpcClient } from "$lib/rpc/client";

import { ENV_VARIABLES } from "../env";

// ============================================
// Svelte 5 Reactive State ($state)
// ============================================
let authState = $state<LoginOutput | undefined>(undefined);
let audioCodecsState = $state<AudioCodecsMessage | undefined>(undefined);
let configState = $state<ConfigMessage | undefined>(undefined);
let netifState = $state<NetifMessage | undefined>(undefined);
let notificationsState = $state<NotificationsMessage | undefined>(undefined);
let pipelinesState = $state<PipelinesMessage | undefined>(undefined);
let relaysState = $state<RelayMessage | undefined>(undefined);
let revisionsState = $state<Revisions | undefined>(undefined);
let sensorsStatusState = $state<SensorsStatus | undefined>(undefined);
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
			fn(getState());
			return () => subscribers.delete(fn);
		},
		_set(value: T) {
			setState(value);
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
// WebSocket Connection (using new RPC client)
// ============================================
const connectionUrl = `${ENV_VARIABLES.SOCKET_ENDPOINT}:${ENV_VARIABLES.SOCKET_PORT}`;

// Use the RPC client's socket
export const socket = {
	get readyState() {
		return rpcClient.getSocket()?.readyState ?? WebSocket.CLOSED;
	},
	send(message: string) {
		const ws = rpcClient.getSocket();
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(message);
		}
	},
	addEventListener(type: string, listener: EventListener) {
		rpcClient.getSocket()?.addEventListener(type, listener);
	},
	removeEventListener(type: string, listener: EventListener) {
		rpcClient.getSocket()?.removeEventListener(type, listener);
	},
	close() {
		rpcClient.disconnect();
	},
};

// ============================================
// Message Handling
// ============================================
import { rpc } from "$lib/rpc/client";

async function sendCreatePasswordMessage(password: string) {
	return new Promise<void>((resolve, reject) => {
		waitForSocketConnection(
			50,
			async () => {
				try {
					await rpc.auth.setPassword({ password });
					resolve();
				} catch (error) {
					console.error("Failed to set password:", error);
					reject(error);
				}
			},
			10000,
			() => reject(new Error("Connection timeout")),
		);
	});
}

async function sendAuthMessage(
	password: string,
	persistentToken: boolean,
	onTimeout?: () => unknown,
) {
	return new Promise<void>((resolve) => {
		waitForSocketConnection(
			50,
			async () => {
				try {
					const result = await rpc.auth.login({
						password,
						persistent_token: persistentToken,
					});
					AuthStore._set(result);
					resolve();
				} catch (error) {
					console.error("Failed to authenticate:", error);
					AuthStore._set({ success: false });
					resolve();
				}
			},
			10000,
			() => {
				AuthStore._set({ success: false });
				onTimeout?.();
				resolve();
			},
		);
	});
}

const assignMessage = (data: string) => {
	let parsedMessage;
	try {
		parsedMessage = JSON.parse(data);
	} catch (error) {
		console.error("Failed to parse message:", error);
		return;
	}

	// Skip if it's an RPC response (has id and result/error)
	if (parsedMessage.id && (parsedMessage.result !== undefined || parsedMessage.error)) {
		return;
	}

	for (const key in parsedMessage) {
		if (key === "id") continue;
		const value = parsedMessage[key];

		switch (key) {
			case "auth":
				AuthStore._set(value);
				break;
			case "acodecs":
				AudioCodecsStore._set(value);
				break;
			case "config":
				ConfigStore._set(value);
				break;
			case "netif":
				NetifStore._set(value);
				break;
			case "notifications":
				NotificationsStore._set(value);
				break;
			case "pipelines":
				if (value && typeof value === "object" && "pipelines" in (value as Record<string, unknown>)) {
					PipelinesStore._set(value as PipelinesMessage);
				} else {
					PipelinesStore._set({
						hardware: (value as { hardware?: string })?.hardware ?? "generic",
						pipelines: value as Record<string, unknown>,
					} as unknown as PipelinesMessage);
				}
				break;
			case "relays":
				RelaysStore._set(value);
				break;
			case "revisions":
				RevisionsStore._set(value);
				break;
			case "sensors":
				SensorsStatusStore._set(value);
				break;
			case "status":
				// Merge status with existing state, preserving modems properly
				if (statusState && value.modems) {
					const mergedModems = mergeModems(
						{ ...statusState.modems },
						value.modems,
					);
					StatusStore._set({ ...statusState, ...value, modems: mergedModems });
				} else {
					StatusStore._set(statusState ? { ...statusState, ...value } : value);
				}
				break;
			case "wifi":
				WifiStore._set(value);
				break;
			case "bitrate":
				if (configState && value?.max_br) {
					ConfigStore._set({ ...configState, max_br: value.max_br });
				}
				break;
			case "log":
				downloadLog(value);
				break;
		}
	}
};

// ============================================
// Initialize Connection
// ============================================
let isInitialized = false;

function initializeConnection() {
	if (isInitialized) return;
	isInitialized = true;

	// Set up message handler
	rpcClient.onMessage((type, data) => {
		const message = JSON.stringify({ [type]: data });
		assignMessage(message);
	});

	// Set up connection handlers
	rpcClient.onConnectionChange((state) => {
		if (state === "connected") {
			toast.success("Connection", {
				duration: 3000,
				description: "Connection established successfully",
			});
		} else if (state === "error" || state === "disconnected") {
			toast.error("Connection", {
				duration: 5000,
				description: "Connection lost, attempting to reconnect...",
			});
		}
	});

	// Connect
	rpcClient.connect();
}

// Initialize on module load
initializeConnection();

// ============================================
// Send Message Utilities
// ============================================
export const sendMessage = (
	message: string,
	onTimeout: (() => unknown) | undefined = undefined,
) => {
	waitForSocketConnection(
		50,
		() => {
			const ws = rpcClient.getSocket();
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(message);
			}
		},
		10000,
		onTimeout,
	);
};

// Make the function wait until the connection is made...
function waitForSocketConnection(
	checkTime: number,
	callback: () => unknown,
	maxWaitingTime: number = 10000,
	onTimeout: undefined | (() => unknown) = undefined,
	executionTime = 0,
) {
	const ws = rpcClient.getSocket();
	if (ws?.readyState === WebSocket.OPEN) {
		callback();
	} else if (executionTime < maxWaitingTime) {
		setTimeout(() => {
			waitForSocketConnection(
				checkTime,
				callback,
				maxWaitingTime,
				onTimeout,
				executionTime + checkTime,
			);
		}, checkTime);
	} else {
		console.error("WebSocket connection timed out");
		onTimeout?.();
	}
}

// ============================================
// Exports for backward compatibility
// ============================================
export const AuthMessages = AuthStore;
export const AudioCodecsMessages = AudioCodecsStore;
export const ConfigMessages = ConfigStore;
export const NetifMessages = NetifStore;
export const NotificationsMessages = NotificationsStore;
export const PipelinesMessages = PipelinesStore;
export const RelaysMessages = RelaysStore;
export const RevisionsMessages = RevisionsStore;
export const SensorsStatusMessages = SensorsStatusStore;
export const StatusMessages = StatusStore;
export const WifiMessages = WifiStore;

export { sendAuthMessage, sendCreatePasswordMessage };
