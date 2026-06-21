/**
 * RPC Event System
 * Manages subscriptions and broadcasts for real-time data
 */
import { logger } from "../helpers/logger.ts";
import { isDevelopment } from "../mocks/mock-config.ts";
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

// Per-add-on state broadcast channel. The manager is the single source of truth
// (it owns the `broadcastMsg(ADDON_EVENT, …)` push); re-exported here so the RPC
// layer resolves the channel name from the events surface like every other event.
export { ADDON_EVENT } from "../modules/addons/manager.ts";

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
					logger.error(`Event handler error for ${event}`, { err: error });
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
 * Dev-only: simulate a device reboot by dropping the authenticated sockets.
 *
 * On a real device `system.reboot`/`system.poweroff` take the host down, so
 * every WebSocket drops and the frontend's DisconnectedBanner takes over the
 * reconnect UX. In dev the OS spawn is gated off (see system.procedure.ts), so
 * that UX was never reachable. Closing the authenticated sockets reproduces the
 * real-reboot effect: each client sees its socket close, then reconnects and
 * RE-AUTHENTICATES through the normal post-reconnect flow — no token is
 * invalidated, the auth_tokens store is untouched.
 *
 * The teardown is deferred to the next macrotask, NOT run synchronously, for
 * real-device parity: the caller's in-flight `system.reboot` reply
 * (`{success:true}`) is sent by the adapter AFTER its `await call(...)`
 * resolves, and Bun drops any `send()` issued after `close()`. On hardware the
 * reply reaches the client before systemd takes the socket down; deferring the
 * close lets that post-await `ws.send` flush first, so the frontend receives
 * `{success:true}`, latches "rebooting", and only THEN sees the disconnect —
 * exactly the sequence the DisconnectedBanner expects.
 *
 * Prod-absence proof: the early return means no production call site can ever
 * perform — or even schedule — socket teardown through this helper.
 */
export function simulateDevReboot(): void {
	if (!isDevelopment()) return;
	const targets = getAuthenticatedClients();
	setTimeout(() => {
		for (const ws of targets) {
			try {
				ws.close();
			} catch (error) {
				logger.debug("simulateDevReboot: close failed", { err: error });
			}
		}
	}, 0);
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
 * Drop clients whose last inbound activity is older than `thresholdMs`.
 *
 * A half-open socket (peer vanished without a TCP FIN) never fires `close`, so
 * it lingers in `clients` forever and every broadcast keeps paying a doomed
 * `send`. Healthy clients refresh `lastActive` via their own keepalive, so a
 * stale timestamp means the link is gone. Pruning closes the socket (best
 * effort) and removes it; the `close` handler's `removeClient` is then a no-op.
 *
 * Returns the number of clients pruned. Pure over the injected clock so the
 * staleness boundary is unit-testable.
 */
export function pruneStaleClients(
	thresholdMs: number,
	now: number = Date.now(),
): number {
	let pruned = 0;
	for (const ws of [...clients]) {
		if (now - ws.data.lastActive <= thresholdMs) continue;
		try {
			ws.close();
		} catch (error) {
			logger.debug("pruneStaleClients: close failed", { err: error });
		}
		clients.delete(ws);
		pruned++;
	}
	if (pruned > 0) {
		logger.warn("pruned stale WS clients", { pruned, thresholdMs });
	}
	return pruned;
}

/**
 * Per-TYPE monotonic sequence counters.
 * Each broadcast type carries an independently increasing seq.
 * NEVER a single global counter. Resets to 0 on process restart (fine).
 */
const seqCounters = new Map<string, number>();

/**
 * Upper bound on distinct broadcast types tracked in a seq map. The legitimate
 * type set is small and fixed, so this is purely a guard against an unbounded
 * leak if a caller ever broadcasts attacker- or bug-controlled dynamic types.
 */
export const SEQ_COUNTERS_MAX_SIZE = 64;

/**
 * Advance and return the next sequence number for a given message type.
 * Pure helper (operates on the passed map) — exported for unit testing.
 * Increments the counter for `type` and returns the new value (1-based).
 *
 * Capacity-bounded: introducing a NEW type while the map is at capacity evicts
 * the oldest entry (Map preserves insertion order) so the map can never grow
 * without bound. An already-tracked type is exempt — its counter stays monotonic.
 */
export function advanceSeq(map: Map<string, number>, type: string): number {
	if (!map.has(type) && map.size >= SEQ_COUNTERS_MAX_SIZE) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
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
		only?: AppWebSocket;
		authedOnly?: boolean;
		minLastActive?: number;
	} = {},
): void {
	const { except, only, authedOnly = true, minLastActive = 0 } = options;

	const now = Date.now();
	if (
		shouldCoalesce(coalesceState, type, data, now, getCoalesceWindowMs(type))
	) {
		return;
	}
	updateCoalesceState(coalesceState, type, data, now);

	const seq = advanceSeq(seqCounters, type);
	const message = JSON.stringify({ [type]: data, seq });

	// Per-client failure isolation. `send` is fired synchronously per client in
	// iteration order (so a given socket keeps receiving in seq order — the
	// guarantee seq-drop-stale relies on — and the post-login snapshot stays
	// strictly ordered), but the OUTCOME of each send is awaited concurrently via
	// Promise.allSettled. A client whose send throws or whose backpressured write
	// settles late can no longer abort or stall the fan-out to the others.
	const settlements: Array<Promise<PromiseSettledResult<void>>> = [];
	let recipients = 0;
	for (const client of clients) {
		if (only && client !== only) continue;
		if (client === except) continue;
		if (authedOnly && !client.data.isAuthenticated) continue;
		if (client.data.lastActive < minLastActive) continue;

		settlements.push(sendToOne(client, message));
		recipients++;
	}

	if (settlements.length > 0) {
		void Promise.allSettled(settlements).then((results) => {
			const failed = results.filter((r) => r.status === "rejected").length;
			if (failed > 0) {
				logger.error("Broadcast send error", { event: type, failed });
			}
		});
	}

	logger.debug("broadcast", { event: type, clients: recipients });
}

/**
 * Dispatch one message to one client, isolating its failure. `send` runs
 * synchronously here (preserving per-socket ordering); a synchronous throw
 * rejects without touching siblings, and a thenable return (a backpressured
 * write) is awaited so Promise.allSettled can wait without blocking dispatch.
 */
function sendToOne(
	client: AppWebSocket,
	message: string,
): Promise<PromiseSettledResult<void>> {
	try {
		const result = client.send(message) as unknown;
		return Promise.resolve(result).then(
			() => ({ status: "fulfilled", value: undefined }),
			(error: unknown) => ({ status: "rejected", reason: error }),
		);
	} catch (error) {
		return Promise.resolve({ status: "rejected", reason: error });
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
		logger.error("Send error", { err: error });
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
