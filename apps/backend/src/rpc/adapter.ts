/**
 * Bun WebSocket Adapter for ORPC
 * Handles WebSocket connections and routes messages to ORPC procedures
 */

import { call } from "@orpc/server";
import type { WebSocketHandler } from "bun";

import { logger } from "../helpers/logger.ts";
import { createContext, initSocketData } from "./context.ts";
import { addClient, removeClient, sendToClient } from "./events.ts";
import { buildInitialStatus } from "./procedures/status.procedure.ts";
import { appRouter } from "./router.ts";
import { getPasswordHash } from "./state/password.ts";
import type { AppWebSocket, SocketData } from "./types.ts";

/**
 * ORPC message format
 */
interface ORPCMessage {
	id?: string;
	method?: string;
	path?: string[];
	input?: unknown;
}

/**
 * Parse incoming message
 */
function parseMessage(data: string): ORPCMessage | null {
	try {
		const parsed = JSON.parse(data);

		// ORPC messages have a specific structure with path array
		if (parsed.path && Array.isArray(parsed.path)) {
			return parsed as ORPCMessage;
		}

		// Handle keepalive messages silently
		if (parsed.keepalive !== undefined) {
			return null;
		}

		logger.warn("Received non-ORPC message format:", parsed);
		return null;
	} catch (error) {
		logger.error(`Failed to parse WebSocket message: ${error}`);
		return null;
	}
}

/**
 * Handle ORPC messages
 */
async function handleORPCMessage(
	ws: AppWebSocket,
	message: ORPCMessage,
): Promise<void> {
	const context = createContext(ws);

	try {
		// Navigate to the procedure using the path
		let procedure: unknown = appRouter;
		for (const segment of message.path || []) {
			procedure = (procedure as Record<string, unknown>)[segment];
			if (!procedure) {
				throw new Error(`Unknown procedure path: ${message.path?.join(".")}`);
			}
		}

		// Execute the procedure using ORPC's call function
		const result = await call(procedure, message.input, { context });

		// Send response
		ws.send(
			JSON.stringify({
				id: message.id,
				result,
			}),
		);

		// Handle post-login actions
		if (
			message.path?.join(".") === "auth.login" &&
			(result as { success: boolean })?.success
		) {
			sendInitialStatusToClient(ws);
		}
	} catch (error) {
		logger.error(`ORPC procedure error: ${error}`);
		ws.send(
			JSON.stringify({
				id: message.id,
				error: {
					message: error instanceof Error ? error.message : "Unknown error",
					code: "INTERNAL_ERROR",
				},
			}),
		);
	}
}

/**
 * Send initial status to a newly authenticated client
 */
function sendInitialStatusToClient(ws: AppWebSocket): void {
	const initialStatus = buildInitialStatus();

	sendToClient(ws, "config", initialStatus.config);
	sendToClient(ws, "pipelines", initialStatus.pipelines);
	if (initialStatus.relays) {
		sendToClient(ws, "relays", initialStatus.relays);
	}
	sendToClient(ws, "status", initialStatus.status);
	sendToClient(ws, "netif", initialStatus.netif);
	sendToClient(ws, "sensors", initialStatus.sensors);
	sendToClient(ws, "revisions", initialStatus.revisions);
	sendToClient(ws, "acodecs", initialStatus.acodecs);
}

/**
 * Create Bun WebSocket handler
 */
export function createWebSocketHandler(): WebSocketHandler<SocketData> {
	return {
		open(ws: AppWebSocket) {
			logger.debug("WebSocket client connected");
			addClient(ws);

			// If no password is set, prompt for password setup
			if (!getPasswordHash()) {
				sendToClient(ws, "status", { set_password: true });
			}
		},

		message(ws: AppWebSocket, data: string | Buffer) {
			const messageStr = typeof data === "string" ? data : data.toString();
			const message = parseMessage(messageStr);

			if (!message) {
				// Keepalive messages return null, which is expected
				return;
			}

			handleORPCMessage(ws, message);
		},

		close(ws: AppWebSocket, code: number, reason: string) {
			logger.debug(`WebSocket client disconnected: ${code} ${reason}`);
			removeClient(ws);
		},

		drain(_ws: AppWebSocket) {
			logger.debug("WebSocket backpressure relieved");
		},
	};
}

/**
 * Initialize socket data for new connections
 */
export { initSocketData };
