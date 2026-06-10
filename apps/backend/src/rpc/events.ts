/**
 * RPC Event System
 * Manages subscriptions and broadcasts for real-time data
 */
import {
	type CoalesceState,
	getCoalesceWindowMs,
	shouldCoalesce,
	updateCoalesceState,
} from "./coalesce.ts";
import type { AppWebSocket } from "./types.ts";

type EventHandler<T = unknown> = (data: T) => void;
type UnsubscribeFn = () => void;

// Source-of-truth event name for the 5-signal device-stats broadcast (S1 lock).
// 5s coalescing window registered in coalesce.ts; emitter in device-stats.ts.
export const DEVICE_STATS_EVENT = "device-stats" as const;

/**
 * Simple event emitter for internal broadcasts
 */
class EventEmitter {
	private handlers: Map<string, Set<EventHandler>> = new Map();

	on<T>(event: string, handler: EventHandler<T>): UnsubscribeFn {
		if (!this.handlers.has(event)) {
			this.handlers.set(event, new Set());
		}
		this.handlers.get(event)?.add(handler as EventHandler);

		return () => {
			this.handlers.get(event)?.delete(handler as EventHandler);
		};
	}

	emit<T>(event: string, data: T): void {
		const handlers = this.handlers.get(event);
		if (handlers) {
			for (const handler of handlers) {
				try {
					handler(data);
				} catch (error) {
					console.error(`Event handler error for ${event}:`, error);
				}
			}
		}
	}

	removeAllListeners(event?: string): void {
		if (event) {
			this.handlers.delete(event);
		} else {
			this.handlers.clear();
		}
	}
}

/**
 * Global event emitter for broadcasts
 */
export const broadcastEmitter = new EventEmitter();

/**
 * Connected WebSocket clients
 */
const clients = new Set<AppWebSocket>();

/**
 * Register a new client
 */
export function addClient(ws: AppWebSocket): void {
	clients.add(ws);
}

/**
 * Remove a client
 */
export function removeClient(ws: AppWebSocket): void {
	clients.delete(ws);
}

/**
 * Get all connected clients
 */
export function getClients(): Set<AppWebSocket> {
	return clients;
}

/**
 * Get authenticated clients
 */
export function getAuthenticatedClients(): AppWebSocket[] {
	return Array.from(clients).filter((ws) => ws.data.isAuthenticated);
}

/**
 * Get active clients (recently active)
 */
export function getActiveClients(minLastActive: number = 0): AppWebSocket[] {
	return Array.from(clients).filter(
		(ws) => ws.data.isAuthenticated && ws.data.lastActive >= minLastActive,
	);
}

/**
 * Per-TYPE monotonic sequence counters.
 * Each broadcast type carries an independently increasing seq.
 * NEVER a single global counter. Resets to 0 on process restart (fine).
 */
const seqCounters = new Map<string, number>();

/**
 * Advance and return the next sequence number for a given message type.
 * Pure helper (operates on the passed map) — exported for unit testing.
 * Increments the counter for `type` and returns the new value (1-based).
 */
export function advanceSeq(map: Map<string, number>, type: string): number {
	const next = (map.get(type) ?? 0) + 1;
	map.set(type, next);
	return next;
}

/**
 * Per-type last-value store for broadcast coalescing. Drops an exact duplicate
 * emitted faster than its type's window; local windows = intervals, so the
 * observable local cadence is unchanged. See `coalesce.ts`.
 */
const coalesceState: CoalesceState = new Map();

/**
 * Broadcast a message to all authenticated clients
 */
export function broadcast(
	type: string,
	data: unknown,
	options: {
		except?: AppWebSocket;
		authedOnly?: boolean;
		minLastActive?: number;
	} = {},
): void {
	const { except, authedOnly = true, minLastActive = 0 } = options;

	const now = Date.now();
	if (
		shouldCoalesce(coalesceState, type, data, now, getCoalesceWindowMs(type))
	) {
		return;
	}
	updateCoalesceState(coalesceState, type, data, now);

	const seq = advanceSeq(seqCounters, type);
	const message = JSON.stringify({ [type]: data, seq });

	for (const client of clients) {
		if (client === except) continue;
		if (authedOnly && !client.data.isAuthenticated) continue;
		if (client.data.lastActive < minLastActive) continue;

		try {
			client.send(message);
		} catch (error) {
			console.error("Broadcast send error:", error);
		}
	}
}

/**
 * Send a message to a specific client
 */
export function sendToClient(
	ws: AppWebSocket,
	type: string,
	data: unknown,
): void {
	try {
		ws.send(JSON.stringify({ [type]: data }));
	} catch (error) {
		console.error("Send error:", error);
	}
}

/**
 * Build a message string
 */
export function buildMessage(
	type: string,
	data: unknown,
	id?: string | null,
): string {
	const obj: Record<string, unknown> = { [type]: data };
	if (id !== undefined) {
		obj.id = id;
	}
	return JSON.stringify(obj);
}
