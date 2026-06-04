/**
 * Half-open socket detection wiring helpers (Task 14).
 *
 * A WebSocket can go "half-open": the socket still reports `OPEN` but the peer
 * is gone and no `close`/`error` ever fires. The pure staleness core lives in
 * `heartbeat.ts` (Task 12); this module turns its verdict into the two decisions
 * the connection layer (`client.ts`) needs:
 *
 *   1. {@link shouldForceCloseHalfOpen} — given the tracker, the current time,
 *      and the socket's `readyState`, decide whether to force-close the socket
 *      (which triggers `onclose` → the Task 5 infinite-retry reconnect path).
 *   2. {@link parseServerPing} — recognise a server→client `{ ping: { t } }`
 *      frame (Task 3/8 schema) and return its validated payload.
 *
 * Both are PURE and dependency-free (no timers, no `Date.now()`, no DOM), so the
 * suite stays deterministic and `vi.useFakeTimers`-free — mirroring `heartbeat.ts`.
 */

/**
 * `WebSocket.OPEN`. Inlined as a constant so this module needs no DOM lib and
 * can be unit-tested under the plain (node) vitest environment.
 */
export const WEBSOCKET_OPEN = 1;

/**
 * Minimal staleness source — structurally satisfied by the
 * `HeartbeatTracker` returned from `createHeartbeatTracker()`.
 */
export interface StalenessSource {
	isStale(now: number, threshold?: number): boolean;
}

/**
 * Decide whether a stale-heartbeat verdict should force-close the socket.
 *
 * Guard (deliberate): only an `OPEN` socket is force-closed. A
 * CONNECTING/CLOSING/CLOSED socket is already owned by the reconnect path;
 * closing it again would race the Task 7 re-auth/hydrate sequence. This is the
 * single rule that keeps stale-detection from fighting reconnect.
 *
 * @param tracker          Staleness source (the heartbeat tracker).
 * @param now              Current timestamp (ms), injected by the caller.
 * @param socketReadyState `WebSocket.readyState`, or `undefined` when no socket.
 */
export function shouldForceCloseHalfOpen(
	tracker: StalenessSource,
	now: number,
	socketReadyState: number | undefined,
): boolean {
	if (socketReadyState !== WEBSOCKET_OPEN) return false;
	return tracker.isStale(now);
}

/** Validated server→client ping payload: `{ t: <positive int ms> }`. */
export interface ServerPing {
	t: number;
}

/**
 * Recognise the inner value of a server→client `{ ping: { t } }` frame and
 * return its validated payload, or `null` when it is not a well-formed ping.
 *
 * Mirrors `pingSchema` from `@ceraui/rpc` (`z.number().int().positive()`)
 * without importing the schema barrel, keeping this module dependency-free.
 */
export function parseServerPing(value: unknown): ServerPing | null {
	if (typeof value !== "object" || value === null) return null;
	const t = (value as { t?: unknown }).t;
	if (typeof t !== "number" || !Number.isInteger(t) || t <= 0) return null;
	return { t };
}
