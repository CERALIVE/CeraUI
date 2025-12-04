/**
 * RPC Types - Bun WebSocket context types
 */
import type { ServerWebSocket } from "bun";

/**
 * Data attached to each WebSocket connection
 */
export interface SocketData {
	/** Whether the socket has been authenticated */
	isAuthenticated: boolean;
	/** Auth token if using persistent authentication */
	authToken?: string;
	/** Last activity timestamp for keepalive */
	lastActive: number;
	/** Sender ID for remote relay identification */
	senderId?: string;
}

/**
 * Bun ServerWebSocket with our custom data
 */
export type AppWebSocket = ServerWebSocket<SocketData>;

/**
 * Context passed to each RPC procedure
 */
export interface RPCContext {
	/** The WebSocket connection */
	ws: AppWebSocket;
	/** Check if connection is authenticated */
	isAuthenticated: () => boolean;
	/** Authenticate the connection */
	authenticate: (token?: string) => void;
	/** Deauthenticate the connection */
	deauthenticate: () => void;
	/** Update last activity timestamp */
	markActive: () => void;
	/** Get last activity timestamp */
	getLastActive: () => number;
	/** Set sender ID for relay */
	setSenderId: (id: string) => void;
	/** Get sender ID */
	getSenderId: () => string | undefined;
	/** Clear sender ID */
	clearSenderId: () => void;
}

/**
 * Event types for subscription broadcasts
 */
export type BroadcastEvent =
	| { type: "status"; data: unknown }
	| { type: "sensors"; data: unknown }
	| { type: "netif"; data: unknown }
	| { type: "modems"; data: unknown }
	| { type: "config"; data: unknown }
	| { type: "wifi"; data: unknown }
	| { type: "notifications"; data: unknown }
	| { type: "auth"; data: unknown }
	| { type: "bitrate"; data: unknown }
	| { type: "log"; data: unknown };
