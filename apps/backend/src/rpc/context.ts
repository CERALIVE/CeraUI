/**
 * RPC Context - Creates context for each WebSocket message
 */
import type { AppWebSocket, RPCContext } from "./types.ts";

/**
 * Create an RPC context from a WebSocket connection
 */
export function createContext(ws: AppWebSocket): RPCContext {
	return {
		ws,

		isAuthenticated: () => ws.data.isAuthenticated,

		authenticate: (token?: string) => {
			ws.data.isAuthenticated = true;
			if (token) {
				ws.data.authToken = token;
			}
			ws.data.lastActive = Date.now();
		},

		deauthenticate: () => {
			ws.data.isAuthenticated = false;
			delete ws.data.authToken;
		},

		markActive: () => {
			ws.data.lastActive = Date.now();
		},

		getLastActive: () => ws.data.lastActive,

		setSenderId: (id: string) => {
			ws.data.senderId = id;
		},

		getSenderId: () => ws.data.senderId,

		clearSenderId: () => {
			delete ws.data.senderId;
		},
	};
}

/**
 * Initialize socket data for a new connection
 */
export function initSocketData(): import("./types.ts").SocketData {
	return {
		isAuthenticated: false,
		lastActive: Date.now(),
	};
}
