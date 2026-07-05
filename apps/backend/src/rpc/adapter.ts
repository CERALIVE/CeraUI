/**
 * Bun WebSocket Adapter for ORPC
 * Handles WebSocket connections and routes messages to ORPC procedures
 */

import { call } from "@orpc/server";
import type { ServerWebSocket, WebSocketHandler } from "bun";

import { logger, logRedact } from "../helpers/logger.ts";
import {
	createPreviewWebSocketHandler,
	isPreviewSocket,
} from "../modules/ui/preview-proxy.ts";
import { createContext, initSocketData } from "./context.ts";
import { extractValidationDetails } from "./error-enrichment.ts";
import { addClient, removeClient, sendToClient } from "./events.ts";
import { buildInitialStatus } from "./procedures/status.procedure.ts";
import { appRouter } from "./router.ts";
import { instrumentRpcCall } from "./rpc-logging.ts";
import { getPasswordHash } from "./state/password.ts";
import type { AppWebSocket, ServerSocketData, SocketData } from "./types.ts";

/** Cap on the redacted frame preview so a stray giant payload never bloats a log. */
const FRAME_PREVIEW_MAX_CHARS = 100;

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
export function parseMessage(
	data: string,
	ws: AppWebSocket,
): ORPCMessage | null {
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

		// Handle the client's heartbeat pong (answer to each server ping) silently
		if (parsed.pong !== undefined) {
			return null;
		}

		logger.warn("rpc: unrecognised frame", {
			module: "rpc.adapter",
			clientId: ws.remoteAddress,
			senderId: ws.data?.senderId,
			bytes: data.length,
			keys: Object.keys(parsed),
			hasId: "id" in parsed,
			preview: logRedact(
				JSON.stringify(parsed).slice(0, FRAME_PREVIEW_MAX_CHARS),
			),
		});
		return null;
	} catch (error) {
		logger.error(`Failed to parse WebSocket message: ${error}`);
		return null;
	}
}

/**
 * Handle ORPC messages
 */
export async function handleORPCMessage(
	ws: AppWebSocket,
	message: ORPCMessage,
	router: unknown = appRouter,
): Promise<void> {
	const context = createContext(ws);
	const clientId = ws.remoteAddress;
	const senderId = ws.data?.senderId;

	try {
		// Navigate to the procedure using the path
		let procedure: unknown = router;
		for (const segment of message.path || []) {
			procedure = (procedure as Record<string, unknown>)[segment];
			if (!procedure) {
				throw new Error(`Unknown procedure path: ${message.path?.join(".")}`);
			}
		}

		// Execute the procedure using ORPC's call function, wrapped in the
		// per-RPC logging interceptor (cid + latency + ok/err, dev/debug-gated).
		const result = await instrumentRpcCall(
			message.path ?? [],
			message.input,
			context,
			() =>
				call(procedure as Parameters<typeof call>[0], message.input, {
					context,
				}),
		);

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
		const validation = extractValidationDetails(error);
		logger.error("rpc: handler error", {
			module: "rpc.adapter",
			procedure: message.path?.join("."),
			messageId: message.id,
			clientId,
			senderId,
			validation,
		});

		// A `phase: "unknown"` (raw ZodError, no oRPC input/output signal) is
		// deliberately NOT claimed as a validation failure — it stays internal.
		const isValidation =
			validation?.phase === "input" || validation?.phase === "output";
		const fields = isValidation
			? [
					...new Set(
						validation.issues
							.map((issue) => issue.path)
							.filter((path) => path.length > 0),
					),
				]
			: [];

		const rawMessage = error instanceof Error ? error.message : "Unknown error";
		ws.send(
			JSON.stringify({
				id: message.id,
				error: {
					// logRedact keeps a secret-shaped message from leaking to the client.
					message: String(logRedact(rawMessage)),
					code: isValidation ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
					...(fields.length > 0 ? { fields } : {}),
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
	sendToClient(ws, "devices", initialStatus.devices);
	sendToClient(ws, "sources", initialStatus.sources);
	if (initialStatus.capabilities) {
		sendToClient(ws, "capabilities", initialStatus.capabilities);
	}
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

			// Security gate: only resend state to a socket that is ALREADY
			// authenticated (per-socket flag). No-op for unauthenticated sockets.
			const context = createContext(ws);
			if (context.isAuthenticated()) {
				sendInitialStatusToClient(ws);
			}
		},

		message(ws: AppWebSocket, data: string | Buffer) {
			// Any inbound frame proves the link is alive. pruneStaleClients() drops
			// sockets with no inbound activity for HEARTBEAT_STALE_THRESHOLD_MS, so
			// the client's keepalive/pong (which parseMessage discards) MUST refresh
			// lastActive here — otherwise an idle authed client making no RPC calls
			// is pruned every ~15s and reconnect-loops.
			ws.data.lastActive = Date.now();

			const messageStr = typeof data === "string" ? data : data.toString();
			const message = parseMessage(messageStr, ws);

			if (!message) {
				// Keepalive / pong frames return null, which is expected.
				return;
			}

			void handleORPCMessage(ws, message);
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
 * The single Bun `websocket` handler for the whole server. It routes each socket
 * by its `kind` discriminant: `/preview` sockets (forked on pathname in the fetch
 * handler BEFORE the oRPC upgrade) go to the preview proxy; every other socket is
 * an oRPC socket handled as before. Bun.serve exposes exactly one websocket
 * handler, so the dispatch lives here rather than at the upgrade site.
 */
export function createServerWebSocketHandler(): WebSocketHandler<ServerSocketData> {
	const rpc = createWebSocketHandler();
	const preview = createPreviewWebSocketHandler();

	const asRpc = (ws: ServerWebSocket<ServerSocketData>): AppWebSocket =>
		ws as unknown as AppWebSocket;

	return {
		open(ws) {
			if (isPreviewSocket(ws)) {
				preview.open(ws);
			} else {
				rpc.open?.(asRpc(ws));
			}
		},
		message(ws, data) {
			if (isPreviewSocket(ws)) {
				preview.message(ws, data);
			} else {
				rpc.message(asRpc(ws), data);
			}
		},
		close(ws, code, reason) {
			if (isPreviewSocket(ws)) {
				preview.close(ws);
			} else {
				rpc.close?.(asRpc(ws), code, reason);
			}
		},
		drain(ws) {
			if (isPreviewSocket(ws)) {
				preview.drain(ws);
			} else {
				rpc.drain?.(asRpc(ws));
			}
		},
	};
}

/**
 * Initialize socket data for new connections
 */
export { initSocketData };
