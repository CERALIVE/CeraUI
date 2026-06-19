/**
 * Server→client heartbeat emitter + pure liveness helper
 *
 * The server periodically broadcasts an app-level `{ ping: { t } }` message so
 * that clients can prove the link is still alive (half-open detection). This is
 * the SERVER→CLIENT direction only — the client→server keepalive already exists
 * (see adapter.ts:40, client.ts:187-191) and must NOT be duplicated here.
 *
 * Bun's `ServerWebSocket` does expose a protocol-level `ping()` frame, but the
 * browser auto-answers those pongs at the protocol layer where the JS client
 * cannot observe them. The Task 3 schema (`heartbeat.schema.ts`) therefore
 * defines an app-level ping carrying a timestamp, which we emit via the existing
 * broadcast path (per-type seq is appended automatically — backward-additive).
 */
import type { Ping } from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import { applyJitter } from "../modules/streaming/constants.ts";
import { broadcast, pruneStaleClients } from "./events.ts";

/**
 * Interval between server→client pings (~5s).
 */
export const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * Default staleness threshold (~15s ≈ 3 missed 5s pings).
 * The client treats the link as stale once no ping/traffic is seen within this
 * window. Kept as a named constant — never inline the literal.
 */
export const HEARTBEAT_STALE_THRESHOLD_MS = 15000;

/**
 * Active timer handle, or null when the heartbeat is stopped. A self-rescheduling
 * `setTimeout` (not `setInterval`) so each tick's delay carries its own jitter.
 */
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

/** Monotonic tick counter for the debug-level cadence trace. */
let heartbeatTickCount = 0;

/**
 * Extra work to run on each heartbeat tick (e.g. stream-health broadcast), kept
 * decoupled so heartbeat.ts owns no domain imports. Listeners run after the ping.
 */
const tickListeners = new Set<() => void>();

export function onHeartbeatTick(listener: () => void): () => void {
	tickListeners.add(listener);
	return () => {
		tickListeners.delete(listener);
	};
}

/**
 * Broadcast a single ping to all authenticated clients.
 * Exported for testing the emitted shape without driving the timer.
 */
export function emitHeartbeat(now: number = Date.now()): void {
	const ping: Ping = { t: now };
	broadcast("ping", ping);
}

/**
 * Start the periodic server→client heartbeat.
 * Idempotent: a second call while running is a no-op (avoids double timers).
 */
export function startHeartbeat(
	intervalMs: number = HEARTBEAT_INTERVAL_MS,
): void {
	if (heartbeatTimer !== null) {
		return;
	}
	const tick = (): void => {
		logger.debug("heartbeat tick", { tick: ++heartbeatTickCount });
		emitHeartbeat();
		// A half-open client never advances lastActive; ~3 missed pings (the
		// client's own staleness window) means the link is gone — drop it so the
		// broadcast loop stops paying for a doomed socket.
		pruneStaleClients(HEARTBEAT_STALE_THRESHOLD_MS);
		for (const listener of tickListeners) {
			try {
				listener();
			} catch (error) {
				logger.error("Heartbeat tick listener error", { err: error });
			}
		}
		// Reschedule with fresh jitter so a fleet of devices never phase-aligns
		// onto the same wall-clock boundary.
		heartbeatTimer = setTimeout(tick, applyJitter(intervalMs));
	};
	heartbeatTimer = setTimeout(tick, applyJitter(intervalMs));
}

/**
 * Stop the periodic heartbeat and clear the timer.
 * Idempotent: safe to call when already stopped.
 */
export function stopHeartbeat(): void {
	if (heartbeatTimer !== null) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
}

/**
 * Pure liveness helper: returns true when the time since `lastSeenAt` exceeds
 * `threshold`. No timers, no side effects — deterministic for unit testing.
 *
 * Boundary is strictly-greater: an elapsed time exactly equal to `threshold` is
 * considered still-alive (not stale).
 */
export function isHeartbeatStale(
	lastSeenAt: number,
	now: number,
	threshold: number,
): boolean {
	return now - lastSeenAt > threshold;
}
