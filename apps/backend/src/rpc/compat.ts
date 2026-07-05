/**
 * Compatibility Bridge
 * Provides backward-compatible functions for existing modules
 * that still use the old WebSocket message patterns
 */
import type WebSocket from "ws";

import {
	isRelayable,
	nextRelaySeq,
	relayStatusToGateway,
} from "../modules/remote-control/status-relay.ts";
import { broadcast, buildMessage } from "./events.ts";
import type { AppWebSocket } from "./types.ts";

/**
 * Build a message string (compatible with old buildMsg)
 */
export function buildMsg(
	type: string,
	data?: unknown,
	id?: string | null,
): string {
	return buildMessage(type, data, id ?? undefined);
}

/**
 * Broadcast to local clients (compatible with old broadcastMsgLocal)
 */
export function broadcastMsgLocal(
	type: string,
	data: unknown,
	activeMin = 0,
	except?: WebSocket | AppWebSocket,
	authedOnly = true,
): string {
	const msg = buildMsg(type, data);
	broadcast(type, data, {
		...(except !== undefined ? { except: except as AppWebSocket } : {}),
		authedOnly,
		minLastActive: activeMin,
	});
	return msg;
}

/**
 * Broadcast to all clients including remote (compatible with old broadcastMsg).
 *
 * Local clients are served first (unchanged); relayable status types are then
 * mirrored onto the control channel as `kind:status` frames (spec §8). The relay
 * is a no-op until the control channel is wired (Task 13) and only fires while
 * it reports connected — the local path is never affected.
 */
export function broadcastMsg(
	type: string,
	data: unknown,
	activeMin = 0,
	authedOnly = true,
): void {
	broadcastMsgLocal(type, data, activeMin, undefined, authedOnly);
	if (isRelayable(type)) {
		relayStatusToGateway(type, data, nextRelaySeq(type));
	}
}

/**
 * Broadcast to all except one client (compatible with old broadcastMsgExcept).
 *
 * Same dual delivery as {@link broadcastMsg}: unchanged local broadcast, then a
 * control-channel `kind:status` relay for relayable types (spec §8).
 */
export function broadcastMsgExcept(
	conn: WebSocket | AppWebSocket,
	type: string,
	data: unknown,
): void {
	broadcastMsgLocal(type, data, 0, conn);
	if (isRelayable(type)) {
		relayStatusToGateway(type, data, nextRelaySeq(type));
	}
}

/**
 * Wrapper to make AppWebSocket work with legacy code expecting ws.WebSocket
 * This allows existing handlers to work without modification
 */
export function wrapSocket(ws: AppWebSocket): WebSocket {
	return ws as unknown as WebSocket;
}

/**
 * Check if a connection is authenticated
 * Compatible with the old isAuthedSocket function
 */
export function isAuthedSocket(conn: WebSocket | AppWebSocket): boolean {
	const ws = conn as AppWebSocket;
	return ws.data?.isAuthenticated ?? false;
}

/**
 * Add a socket to authenticated set
 * Compatible with old addAuthedSocket function
 */
export function addAuthedSocket(conn: WebSocket | AppWebSocket): void {
	const ws = conn as AppWebSocket;
	if (ws.data) {
		ws.data.isAuthenticated = true;
	}
}

/**
 * Remove a socket from authenticated set
 * Compatible with old deleteAuthedSocket function
 */
export function deleteAuthedSocket(conn: WebSocket | AppWebSocket): void {
	const ws = conn as AppWebSocket;
	if (ws.data) {
		ws.data.isAuthenticated = false;
	}
}

/**
 * Mark connection as active
 * Compatible with old markConnectionActive function
 */
export function markConnectionActive(
	conn: WebSocket | AppWebSocket,
	timestamp: number = Date.now(),
): void {
	const ws = conn as AppWebSocket;
	if (ws.data) {
		ws.data.lastActive = timestamp;
	}
}

/**
 * Get last active timestamp
 * Compatible with old getLastActive function
 */
export function getLastActive(conn: WebSocket | AppWebSocket): number {
	const ws = conn as AppWebSocket;
	return ws.data?.lastActive ?? 0;
}

/**
 * Get socket sender ID
 * Compatible with old getSocketSenderId function
 */
export function getSocketSenderId(
	conn: WebSocket | AppWebSocket,
): string | undefined {
	const ws = conn as AppWebSocket;
	return ws.data?.senderId;
}

/**
 * Set socket sender ID
 * Compatible with old setSocketSenderId function
 */
export function setSocketSenderId(
	conn: WebSocket | AppWebSocket,
	senderId: string,
): void {
	const ws = conn as AppWebSocket;
	if (ws.data) {
		ws.data.senderId = senderId;
	}
}

/**
 * Delete socket sender ID
 * Compatible with old deleteSocketSenderId function
 */
export function deleteSocketSenderId(conn: WebSocket | AppWebSocket): void {
	const ws = conn as AppWebSocket;
	if (ws.data) {
		delete ws.data.senderId;
	}
}
