/**
 * Bun WebSocket Adapter for ORPC
 * Handles WebSocket connections and routes messages to ORPC procedures
 */

import { logBundleFailureReasonSchema } from "@ceraui/rpc/schemas";
import {
	call,
	getRouter,
	ORPCError,
	Procedure,
	type Router,
} from "@orpc/server";
import type { ServerWebSocket, WebSocketHandler } from "bun";

import { logger, logRedact } from "../helpers/logger.ts";
import { isRuntimeConfigAvailable } from "../modules/config.ts";
import { stopFollow } from "../modules/device-logs/follow.ts";
import { SHARING_DIAG_EVENT } from "../modules/network/sharing-diag/status.ts";
import {
	getStreamHealth,
	HEALTH_EVENT_TYPE,
} from "../modules/streaming/health.ts";
import { CPU_EVENT } from "../modules/system/cpu.ts";
import { getDeviceStatsSnapshot } from "../modules/system/device-stats-snapshot.ts";
import {
	createPreviewWebSocketHandler,
	isPreviewSocket,
} from "../modules/ui/preview-proxy.ts";
import {
	closeSocketSession,
	createContext,
	initSocketData,
} from "./context.ts";
import { extractValidationDetails } from "./error-enrichment.ts";
import {
	addClient,
	DEVICE_STATS_EVENT,
	removeClient,
	sendToClient,
} from "./events.ts";
import { sendAddonSnapshot } from "./procedures/addons.procedure.ts";
import {
	buildInitialNotifications,
	buildInitialStatus,
} from "./procedures/status.procedure.ts";
import { appRouter } from "./router.ts";
import { instrumentRpcCall } from "./rpc-logging.ts";
import { getPasswordHash } from "./state/password.ts";
import type {
	AppWebSocket,
	RPCContext,
	ServerSocketData,
	SocketData,
} from "./types.ts";

/**
 * ORPC message format
 */
interface ORPCMessage {
	readonly id?: string | number | undefined;
	readonly path: readonly string[] | null;
	readonly input?: unknown;
}

/**
 * Parse incoming message
 */
export function parseMessage(
	data: string,
	ws: AppWebSocket,
): ORPCMessage | null {
	try {
		const parsed: unknown = JSON.parse(data);

		if (typeof parsed !== "object" || parsed === null) return null;

		// Keep a malformed RPC request dispatchable so its caller gets a reply.
		if ("path" in parsed && Object.hasOwn(parsed, "path")) {
			const { path } = parsed;
			return {
				// Echo a JSON string or finite number unchanged; never coerce anything else.
				id:
					"id" in parsed &&
					(typeof parsed.id === "string" ||
						(typeof parsed.id === "number" && Number.isFinite(parsed.id)))
						? parsed.id
						: undefined,
				path:
					Array.isArray(path) &&
					path.length > 0 &&
					path.every((segment: unknown) => typeof segment === "string")
						? path
						: null,
				input: "input" in parsed ? parsed.input : undefined,
			};
		}

		// Handle keepalive messages silently
		if ("keepalive" in parsed) {
			return null;
		}

		// Handle the client's heartbeat pong (answer to each server ping) silently
		if ("pong" in parsed) {
			return null;
		}

		logger.warn("rpc: unrecognised frame", {
			module: "rpc.adapter",
			clientId: ws.remoteAddress,
			senderId: ws.data?.senderId,
			bytes: data.length,
			keys: Object.keys(parsed),
			hasId: "id" in parsed,
			// No payload preview: a stringified frame bypasses the logger's key
			// redaction, and a stray frame can carry config credentials.
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
	router: Router<RPCContext> = appRouter,
): Promise<void> {
	const context = createContext(ws);
	const clientId = ws.remoteAddress;
	const senderId = ws.data?.senderId;
	const { path } = message;
	const label = path?.join(".") ?? "<invalid path>";

	try {
		const procedure = path === null ? undefined : getRouter(router, path);
		if (path === null || !(procedure instanceof Procedure)) {
			throw new Error(`Unknown procedure path: ${label}`);
		}

		// Execute the procedure using ORPC's call function, wrapped in the
		// per-RPC logging interceptor (cid + latency + ok/err, dev/debug-gated).
		const result = await instrumentRpcCall(path, message.input, context, () =>
			call(procedure, message.input, { context }),
		);

		// Send response
		ws.send(
			JSON.stringify({
				id: message.id,
				result,
			}),
		);

		// Handle post-login actions
		if (label === "auth.login" && (result as { success: boolean })?.success) {
			sendInitialStatusToClient(ws);
		}
	} catch (error) {
		const validation = extractValidationDetails(error);
		logger.error("rpc: handler error", {
			module: "rpc.adapter",
			procedure: label,
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
		const updateStartupPending =
			error instanceof ORPCError &&
			error.code === "UPDATE_ORCHESTRATOR_INITIALIZING";
		// Additive: only a closed support-bundle stage crosses, never other data.
		const stage =
			error instanceof ORPCError
				? logBundleFailureReasonSchema.safeParse(error.data?.stage).data
				: undefined;
		ws.send(
			JSON.stringify({
				id: message.id,
				error: {
					// logRedact keeps a secret-shaped message from leaking to the client.
					message: String(logRedact(rawMessage)),
					code: updateStartupPending
						? error.code
						: isValidation
							? "VALIDATION_ERROR"
							: "INTERNAL_ERROR",
					...(updateStartupPending ? { retryable: true } : {}),
					...(fields.length > 0 ? { fields } : {}),
					...(stage ? { stage } : {}),
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
	void sendAddonSnapshot((snapshot) =>
		sendToClient(ws, "addons", snapshot),
	).catch((error) =>
		logger.error("addon initial hydration failed", { err: error }),
	);
	sendToClient(ws, "pipelines", initialStatus.pipelines);
	if (initialStatus.relays) {
		sendToClient(ws, "relays", initialStatus.relays);
	}
	sendToClient(ws, "status", initialStatus.status);
	sendToClient(ws, "netif", initialStatus.netif);
	sendToClient(ws, "uplinks", initialStatus.uplinks);
	sendToClient(ws, "uplink-steering", initialStatus.uplinkSteering);
	sendToClient(ws, "uplink-shaper", initialStatus.uplinkShaper);
	sendToClient(ws, SHARING_DIAG_EVENT, initialStatus.sharingDiag);
	sendToClient(ws, "sensors", initialStatus.sensors);
	const deviceStats = getDeviceStatsSnapshot();
	if (deviceStats !== undefined) {
		sendToClient(ws, DEVICE_STATS_EVENT, deviceStats);
	}
	sendToClient(ws, CPU_EVENT, initialStatus.cpu);
	sendToClient(ws, "revisions", initialStatus.revisions);
	sendToClient(ws, "acodecs", initialStatus.acodecs);
	sendToClient(ws, "devices", initialStatus.devices);
	sendToClient(ws, "sources", initialStatus.sources);
	if (initialStatus.capabilities) {
		sendToClient(ws, "capabilities", initialStatus.capabilities);
	}
	// The `health` rollup broadcasts only on a state TRANSITION, so a client that
	// connects mid-idle would otherwise render the pre-broadcast `unknown` dot
	// forever. Seed the current rollup so the HUD shows the truthful idle/live
	// verdict on load.
	sendToClient(ws, HEALTH_EVENT_TYPE, getStreamHealth());
	// Same shape of problem, one layer over: the notifications panel reads the
	// PUSH cache, so a persistent notification raised before this client existed
	// is invisible to it. Only a one-shot one actually breaks — every other is
	// re-raised by its own loop — and the boot-time encoder-mode clamp is exactly
	// that. The legacy relay path has always replayed these.
	sendToClient(ws, "notification", buildInitialNotifications());
}

/**
 * Create Bun WebSocket handler
 */
export function createWebSocketHandler(): WebSocketHandler<SocketData> {
	return {
		open(ws: AppWebSocket) {
			logger.debug("WebSocket client connected");
			addClient(ws);

			// Prompt for first-run password setup only when config was READ and holds
			// none. While config.json is unreadable the stored password is unknown,
			// not absent, so nobody may claim the device by setting one.
			if (!getPasswordHash() && isRuntimeConfigAvailable()) {
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

			return handleORPCMessage(ws, message).catch((err) => {
				logger.error("rpc: message dispatch failed", {
					module: "rpc.adapter",
					messageId: message.id,
					clientId: ws.remoteAddress,
					err,
				});
			});
		},

		async close(ws: AppWebSocket, code: number, reason: string) {
			closeSocketSession(ws);
			logger.debug(`WebSocket client disconnected: ${code} ${reason}`);
			removeClient(ws);
			await stopFollow(ws);
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
				return rpc.message?.(asRpc(ws), data);
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
