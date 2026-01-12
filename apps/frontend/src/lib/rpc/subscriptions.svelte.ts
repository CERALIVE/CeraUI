/**
 * RPC Subscriptions - Svelte 5 Runes Implementation
 *
 * This module manages real-time data subscriptions using Svelte 5 runes.
 * It provides reactive getters for all server-pushed data.
 */
import { toast } from "svelte-sonner";

import type {
	ConfigMessage,
	ModemList,
	NetifMessage,
	NotificationsMessage,
	PipelinesMessage,
	RelayMessage,
	Revisions,
	SensorsStatus,
	StatusResponse,
	WifiStatus,
} from "@ceraui/rpc/schemas";

import { downloadLog } from "$lib/helpers/SystemHelper";

import type { ConnectionState } from "./client";
import { rpcClient } from "./client";

// ============================================
// Svelte 5 Reactive State ($state)
// ============================================

// Auth state
let authState = $state<{ success: boolean; auth_token?: string } | undefined>(
	undefined,
);

// Config state
let configState = $state<ConfigMessage | undefined>(undefined);

// Status state (aggregated)
let statusState = $state<
	| (StatusResponse & {
			is_streaming: boolean;
			wifi: WifiStatus;
			modems: ModemList;
	  })
	| undefined
>(undefined);

// Individual status components
let isStreamingState = $state<boolean>(false);
let sshState = $state<StatusResponse["ssh"] | undefined>(undefined);
let availableUpdatesState = $state<StatusResponse["available_updates"] | undefined>(undefined);
let updatingState = $state<StatusResponse["updating"]>(null);

// Network state
let netifState = $state<NetifMessage | undefined>(undefined);
let wifiState = $state<WifiStatus | undefined>(undefined);
let modemsState = $state<ModemList | undefined>(undefined);

// System state
let sensorsState = $state<SensorsStatus | undefined>(undefined);
let revisionsState = $state<Revisions | undefined>(undefined);
let pipelinesState = $state<PipelinesMessage | undefined>(undefined);
let audioCodecsState = $state<Record<string, { name: string }> | undefined>(undefined);

// Relay state
let relaysState = $state<RelayMessage | undefined>(undefined);

// Notifications state
let notificationsState = $state<NotificationsMessage | undefined>(undefined);

// Connection state
let connectionState = $state<ConnectionState>("disconnected");
let isConnectedState = $state<boolean>(false);

// ============================================
// Reactive Getters (Svelte 5 Pattern)
// ============================================

export function getAuth() {
	return authState;
}

export function getConfig() {
	return configState;
}

export function getStatus() {
	return statusState;
}

export function getIsStreaming() {
	return isStreamingState;
}

export function getSsh() {
	return sshState;
}

export function getAvailableUpdates() {
	return availableUpdatesState;
}

export function getUpdating() {
	return updatingState;
}

export function getNetif() {
	return netifState;
}

export function getWifi() {
	return wifiState;
}

export function getModems() {
	return modemsState;
}

export function getSensors() {
	return sensorsState;
}

export function getRevisions() {
	return revisionsState;
}

export function getPipelines() {
	return pipelinesState;
}

export function getAudioCodecs() {
	return audioCodecsState;
}

export function getRelays() {
	return relaysState;
}

export function getNotifications() {
	return notificationsState;
}

export function getConnectionState() {
	return connectionState;
}

export function getIsConnected() {
	return isConnectedState;
}

// ============================================
// Message Handlers
// ============================================

/**
 * Handle incoming messages and update state
 */
function handleMessage(type: string, data: unknown): void {
	switch (type) {
		case "auth":
			authState = data as typeof authState;
			break;

		case "config":
			configState = data as ConfigMessage;
			break;

		case "status": {
			const statusData = data as StatusResponse;

			// Update individual states
			if (statusData.is_streaming !== undefined) {
				isStreamingState = statusData.is_streaming;
			}
			if (statusData.ssh !== undefined) {
				sshState = statusData.ssh;
			}
			if (statusData.available_updates !== undefined) {
				availableUpdatesState = statusData.available_updates;
			}
			if (statusData.updating !== undefined) {
				updatingState = statusData.updating;
			}
			if (statusData.wifi !== undefined) {
				wifiState = statusData.wifi;
			}
			if (statusData.modems !== undefined) {
				modemsState = statusData.modems;
			}

			// Update aggregated status
			statusState = {
				...statusState,
				...statusData,
				is_streaming: isStreamingState,
				wifi: wifiState ?? {},
				modems: modemsState ?? {},
			} as typeof statusState;
			break;
		}

		case "netif":
			netifState = data as NetifMessage;
			break;

		case "wifi":
			// WiFi responses can have multiple formats
			const wifiData = data as {
				connect?: string[];
				disconnect?: string;
				new?: { error?: string; success?: boolean };
			};

			// Handle connection responses
			if (wifiData.new?.error === "auth") {
				toast.error("WiFi authentication failed");
			} else if (wifiData.new?.success) {
				toast.success("Connected to WiFi network");
			}
			break;

		case "modems":
			// Modems data is usually part of status, but can come separately
			if (data && typeof data === "object") {
				modemsState = { ...modemsState, ...(data as ModemList) };
			}
			break;

		case "sensors":
			sensorsState = data as SensorsStatus;
			break;

		case "revisions":
			revisionsState = data as Revisions;
			break;

		case "pipelines":
			if (data && typeof data === "object" && "pipelines" in (data as Record<string, unknown>)) {
				pipelinesState = data as PipelinesMessage;
			} else {
				pipelinesState = {
					hardware: (data as { hardware?: string })?.hardware ?? "generic",
					pipelines: data as Record<string, unknown>,
				} as unknown as PipelinesMessage;
			}
			break;

		case "acodecs":
			audioCodecsState = data as Record<string, { name: string }>;
			break;

		case "relays":
			relaysState = data as RelayMessage;
			break;

		case "notifications":
			notificationsState = data as NotificationsMessage;
			handleNotifications(data as NotificationsMessage);
			break;

		case "bitrate":
			// Bitrate updates during streaming
			if (configState && (data as { max_br?: number }).max_br) {
				configState = {
					...configState,
					max_br: (data as { max_br: number }).max_br,
				};
			}
			break;

		case "log":
			// Download log file
			if (typeof data === "object" && data !== null) {
				downloadLog(data as { name: string; contents: string });
			}
			break;

		default:
			console.debug("Unhandled message type:", type, data);
	}
}

/**
 * Handle notification display
 */
function handleNotifications(data: NotificationsMessage): void {
	if (!data.show) return;

	for (const notification of data.show) {
		const toastFn =
			notification.type === "error"
				? toast.error
				: notification.type === "warning"
					? toast.warning
					: notification.type === "success"
						? toast.success
						: toast.info;

		toastFn(notification.msg, {
			duration: notification.duration * 1000,
		});
	}
}

/**
 * Handle connection state changes
 */
function handleConnectionChange(state: ConnectionState): void {
	connectionState = state;
	isConnectedState = state === "connected";

	if (state === "connected") {
		toast.success("Connection established");
	} else if (state === "disconnected") {
		toast.error("Connection lost, attempting to reconnect...");
	}
}

// ============================================
// Initialization
// ============================================

let isInitialized = false;

/**
 * Initialize subscriptions
 */
export function initSubscriptions(): void {
	if (isInitialized) return;
	isInitialized = true;

	// Set up message handler
	rpcClient.onMessage(handleMessage);

	// Set up connection handler
	rpcClient.onConnectionChange(handleConnectionChange);

	// Connect to server
	rpcClient.connect();
}

/**
 * Reset all state (for testing or logout)
 */
export function resetState(): void {
	authState = undefined;
	configState = undefined;
	statusState = undefined;
	isStreamingState = false;
	sshState = undefined;
	availableUpdatesState = undefined;
	updatingState = null;
	netifState = undefined;
	wifiState = undefined;
	modemsState = undefined;
	sensorsState = undefined;
	revisionsState = undefined;
	pipelinesState = undefined;
	audioCodecsState = undefined;
	relaysState = undefined;
	notificationsState = undefined;
}

// ============================================
// Legacy API Compatibility
// ============================================

/**
 * Send a message (legacy API)
 * @deprecated Use rpc.* methods directly
 */
export function sendMessage(message: string): void {
	const parsed = JSON.parse(message);
	for (const [type, data] of Object.entries(parsed)) {
		rpcClient.sendLegacy(type, data);
	}
}

/**
 * Get the raw socket (legacy API)
 * @deprecated Use rpcClient directly
 */
export function getSocket(): WebSocket | null {
	return rpcClient.getSocket();
}

/**
 * Alias for backwards compatibility
 */
export const socket = {
	get send() {
		return (message: string) => {
			const ws = rpcClient.getSocket();
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(message);
			}
		};
	},
	get readyState() {
		return rpcClient.getSocket()?.readyState ?? WebSocket.CLOSED;
	},
};
