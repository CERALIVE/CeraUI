import { get, readonly, writable } from "svelte/store";
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

const AuthStore = writable<AuthMessage>();
const AudioCodecsStore = writable<AudioCodecsMessage>();
const ConfigStore = writable<ConfigMessage>();
const NetifStore = writable<NetifMessage>();
const NotificationsStore = writable<NotificationsMessage>();
const PipelinesStore = writable<PipelinesMessage>();
const RelaysStore = writable<RelayMessage>();
const RevisionsStore = writable<RevisionsMessage>();
const SensorsStatusStore = writable<SensorsStatusMessage>();
const StatusStore = writable<StatusMessage>();
const WifiStore = writable<WifiMessage>();

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

function sendCreatePasswordMessage(password: string) {
	sendMessage(JSON.stringify({ config: { password } }));
	StatusStore.set({ ...get(StatusStore), set_password: false });
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

	// Debug log for log-related messages
	if (messageType === "log") {
		console.log("📥 Received log message:", parsedMessage);
	}

	switch (messageType) {
		case "auth":
			AuthStore.set(parsedMessage.auth);
			break;
		case "acodecs":
			AudioCodecsStore.set(parsedMessage.acodecs);
			break;
		case "config":
			ConfigStore.set(parsedMessage.config);
			break;
		case "netif":
			NetifStore.set(parsedMessage.netif);
			break;
		case "notification":
			NotificationsStore.set(parsedMessage.notification);
			break;
		case "pipelines":
			PipelinesStore.set(parsedMessage.pipelines);
			break;
		case "relays":
			RelaysStore.set(parsedMessage.relays);
			break;
		case "revisions":
			RevisionsStore.set(parsedMessage.revisions);

			// Store server version for display only - no update checking
			if (parsedMessage.revisions.belaUI) {
				console.log("📡 Server version stored (frontend updates only):", {
					belaUI: parsedMessage.revisions.belaUI,
					frontendVersion: CLIENT_VERSION,
				});
			}
			break;
		case "sensors":
			SensorsStatusStore.set(parsedMessage.sensors);
			break;
		case "status":
			{
				const currentStatus = get(StatusStore);
				if (parsedMessage.status.modems) {
					StatusStore.set({
						...currentStatus,
						...parsedMessage.status,
						modems: mergeModems(
							currentStatus?.modems ? currentStatus.modems : {},
							parsedMessage.status?.modems,
						),
					});
				} else {
					StatusStore.set({ ...currentStatus, ...parsedMessage.status });
				}
			}

			break;
		case "wifi":
			WifiStore.set(parsedMessage.wifi);
			break;
		case "log":
			downloadLog(parsedMessage.log);
			break;
	}
};

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
				console.log("wait for connection...");
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

const AuthMessages = readonly(AuthStore);
const AudioCodecsMessages = readonly(AudioCodecsStore);
const NetifMessages = readonly(NetifStore);
const NotificationsMessages = readonly(NotificationsStore);
const ConfigMessages = readonly(ConfigStore);
const PipelinesMessages = readonly(PipelinesStore);
const RelaysMessages = readonly(RelaysStore);
const RevisionsMessages = readonly(RevisionsStore);
const SensorsStatusMessages = readonly(SensorsStatusStore);
const StatusMessages = readonly(StatusStore);
const WifiMessages = readonly(WifiStore);

export {
	AudioCodecsMessages,
	AuthMessages,
	ConfigMessages,
	NetifMessages,
	NotificationsMessages,
	PipelinesMessages,
	RelaysMessages,
	RevisionsMessages,
	sendAuthMessage,
	sendCreatePasswordMessage,
	sendMessage,
	SensorsStatusMessages,
	socket,
	StatusMessages,
	WifiMessages,
};

// Debug functions for version tracking
if (typeof window !== "undefined" && !BUILD_INFO.IS_PROD) {
	console.log("📱 Frontend build version:", CLIENT_VERSION);

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
