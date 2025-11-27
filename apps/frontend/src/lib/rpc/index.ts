/**
 * RPC Module Entry Point
 *
 * Provides type-safe RPC communication with the backend.
 */

// Client
export {
	type ConnectionHandler,
	type ConnectionState,
	initRPC,
	type MessageHandler,
	rpc,
	rpcClient,
} from "./client";

// Subscriptions (reactive state)
export {
	getAudioCodecs,
	getAuth,
	getAvailableUpdates,
	getConfig,
	getConnectionState,
	getIsConnected,
	getIsStreaming,
	getModems,
	getNetif,
	getNotifications,
	getPipelines,
	getRelays,
	getRevisions,
	getSensors,
	getSocket,
	getSsh,
	getStatus,
	getUpdating,
	getWifi,
	initSubscriptions,
	resetState,
	sendMessage,
	socket,
} from "./subscriptions.svelte";
