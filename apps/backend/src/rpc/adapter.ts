/**
 * Bun WebSocket Adapter for ORPC
 * Handles WebSocket connections and routes messages to ORPC procedures
 */

import { call } from "@orpc/server";
import type { ServerWebSocket, WebSocketHandler } from "bun";

import { logger } from "../helpers/logger.ts";
import { createContext, initSocketData } from "./context.ts";
import { addClient, broadcast, removeClient, sendToClient } from "./events.ts";
import {
	loginProcedure,
	logoutProcedure,
	setPasswordProcedure,
} from "./procedures/auth.procedure.ts";
import { buildInitialStatus } from "./procedures/status.procedure.ts";
import {
	setBitrateProcedure,
	streamingStartProcedure,
	streamingStopProcedure,
} from "./procedures/streaming.procedure.ts";
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
 * Legacy message format (for backward compatibility during migration)
 */
interface LegacyMessage {
	[key: string]: unknown;
}

/**
 * Parse incoming message and determine format
 */
function parseMessage(
	data: string,
):
	| { type: "orpc"; message: ORPCMessage }
	| { type: "legacy"; message: LegacyMessage }
	| null {
	try {
		const parsed = JSON.parse(data);

		// ORPC messages have a specific structure with path array
		if (parsed.path && Array.isArray(parsed.path)) {
			return { type: "orpc", message: parsed as ORPCMessage };
		}

		// Legacy messages are key-value objects
		return { type: "legacy", message: parsed as LegacyMessage };
	} catch (error) {
		logger.error(`Failed to parse WebSocket message: ${error}`);
		return null;
	}
}

/**
 * Handle ORPC-style messages
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
 * Handle legacy-style messages (for backward compatibility)
 * This allows gradual migration from the old WebSocket protocol
 */
async function handleLegacyMessage(
	ws: AppWebSocket,
	message: LegacyMessage,
): Promise<void> {
	const context = createContext(ws);

	// Log all received messages except for keepalives
	if (Object.keys(message).length > 1 || !("keepalive" in message)) {
		logger.debug("WS legacy message", message);
	}

	// Handle keepalive
	if ("keepalive" in message) {
		context.markActive();
		return;
	}

	// Handle auth
	if ("auth" in message && message.auth) {
		const authInput = message.auth as {
			password?: string;
			token?: string;
			persistent_token?: boolean;
		};
		try {
			const result = await call(
				loginProcedure,
				{
					password: authInput.password,
					token: authInput.token,
					persistent_token: authInput.persistent_token ?? false,
				},
				{ context },
			);
			sendToClient(ws, "auth", result);
			if (result.success) {
				// Send initial status after successful auth
				sendInitialStatusToClient(ws);
			}
		} catch (error) {
			logger.error(`Login error: ${error}`);
			sendToClient(ws, "auth", { success: false });
		}
		return;
	}

	// Handle config (password setting)
	if ("config" in message && message.config) {
		const configMsg = message.config as { password?: string };
		if (configMsg.password) {
			try {
				await call(
					setPasswordProcedure,
					{ password: configMsg.password },
					{ context },
				);
			} catch (error) {
				logger.error(`Set password error: ${error}`);
			}
		}
		return;
	}

	// Require auth for remaining operations
	if (!context.isAuthenticated()) {
		return;
	}

	// Handle start streaming
	if ("start" in message && message.start) {
		try {
			await call(
				streamingStartProcedure,
				message.start as Record<string, unknown>,
				{ context },
			);
		} catch (error) {
			logger.error(`Start streaming error: ${error}`);
		}
		return;
	}

	// Handle stop streaming
	if ("stop" in message) {
		try {
			await call(streamingStopProcedure, undefined, { context });
		} catch (error) {
			logger.error(`Stop streaming error: ${error}`);
		}
		return;
	}

	// Handle bitrate
	if ("bitrate" in message && message.bitrate) {
		const bitrateMsg = message.bitrate as { max_br?: number };
		if (bitrateMsg.max_br) {
			try {
				const result = await call(
					setBitrateProcedure,
					{ max_br: bitrateMsg.max_br },
					{ context },
				);
				broadcast("bitrate", result, { except: ws });
			} catch (error) {
				logger.error(`Set bitrate error: ${error}`);
			}
		}
		return;
	}

	// Handle logout
	if ("logout" in message) {
		try {
			await call(logoutProcedure, undefined, { context });
		} catch (error) {
			logger.error(`Logout error: ${error}`);
		}
		return;
	}

	// Update activity timestamp for any valid message
	context.markActive();
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
			const parsed = parseMessage(messageStr);

			if (!parsed) {
				logger.warn("Invalid WebSocket message received");
				return;
			}

			if (parsed.type === "orpc") {
				handleORPCMessage(ws, parsed.message);
			} else {
				handleLegacyMessage(ws, parsed.message);
			}
		},

		close(ws: AppWebSocket, code: number, reason: string) {
			logger.debug(`WebSocket client disconnected: ${code} ${reason}`);
			removeClient(ws);
		},

		drain(ws: AppWebSocket) {
			logger.debug("WebSocket backpressure relieved");
		},
	};
}

/**
 * Initialize socket data for new connections
 */
export { initSocketData };
