/**
 * RPC Module Entry Point
 * Exports all RPC-related functionality
 */

// Adapter
export { createWebSocketHandler } from "./adapter.ts";

// Context
export { createContext, initSocketData } from "./context.ts";

// Events & Broadcasting
export {
	addClient,
	broadcast,
	broadcastEmitter,
	buildMessage,
	getActiveClients,
	getAuthenticatedClients,
	getClients,
	removeClient,
	sendToClient,
} from "./events.ts";
// Procedures (for direct access if needed)
export {
	getPasswordHash,
	setPasswordHash,
} from "./procedures/auth.procedure.ts";
// Router
export { type AppRouter, appRouter } from "./router.ts";
// Server
export { getServer, initServer, stopServer } from "./server.ts";
// Types
export type {
	AppWebSocket,
	BroadcastEvent,
	RPCContext,
	SocketData,
} from "./types.ts";
