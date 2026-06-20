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

// Async-operation store (keyed OS-command transition primitive)
export {
	ASYNC_OP_TERMINAL_LINGER_MS,
	ASYNC_OP_TTL_MS,
	type AsyncOpPhase,
	type AsyncOpRegistry,
	beginOperation,
	clearOperation,
	confirmOperation,
	destroyAsyncOperations,
	failOperation,
	getOperationPhase,
	getOperationReason,
	initAsyncOperations,
	isOperationPending,
	reconcileOperationsOnReconnect,
	timeoutOperation,
} from "./async-operation.svelte";

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
