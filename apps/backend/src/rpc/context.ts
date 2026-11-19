/**
 * RPC Context - Creates context for each WebSocket message
 */
import type { AppWebSocket, RPCContext } from "./types.ts";

const closedSockets = new WeakSet<AppWebSocket>();
const sessions = new WeakMap<AppWebSocket, AbortController>();
const inactiveSession = AbortSignal.abort();

export function socketSessionSignal(ws: AppWebSocket): AbortSignal {
	if (!ws.data.isAuthenticated || closedSockets.has(ws)) return inactiveSession;
	const current = sessions.get(ws);
	if (current) return current.signal;
	const session = new AbortController();
	sessions.set(ws, session);
	return session.signal;
}

export function closeSocketSession(ws: AppWebSocket): void {
	closedSockets.add(ws);
	createContext(ws).deauthenticate();
}

/**
 * Create an RPC context from a WebSocket connection
 */
export function createContext(ws: AppWebSocket): RPCContext {
	return {
		ws,

		isAuthenticated: () => ws.data.isAuthenticated,

		authenticate: (token?: string) => {
			if (closedSockets.has(ws)) return;
			if (token !== undefined && token !== ws.data.authToken) {
				sessions.get(ws)?.abort();
				sessions.delete(ws);
			}
			ws.data.isAuthenticated = true;
			if (token) {
				ws.data.authToken = token;
			}
			ws.data.lastActive = Date.now();
		},

		deauthenticate: () => {
			ws.data.isAuthenticated = false;
			delete ws.data.authToken;
			sessions.get(ws)?.abort();
			sessions.delete(ws);
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
