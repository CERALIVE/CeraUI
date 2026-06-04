/**
 * Unit tests for the PURE half-open detection wiring helpers (Task 14).
 *
 * These functions turn the heartbeat staleness verdict (Task 12) into the two
 * decisions the connection layer needs: whether to force-close a half-open
 * socket, and whether an inbound frame is a well-formed server→client ping.
 *
 * Like `heartbeat.ts`, they are rune-free and side-effect-free: time is ALWAYS
 * injected via explicit `now` numbers (never `Date.now()`, never timers, never
 * `vi.useFakeTimers`), so the suite is fully deterministic.
 */

import { describe, expect, it } from 'vitest';

import { createHeartbeatTracker } from './heartbeat';
import {
	parseServerPing,
	shouldForceCloseHalfOpen,
	WEBSOCKET_OPEN,
} from './half-open';

describe('half-open detection wiring', () => {
	// ----------------------------------------------------------------------
	// WEBSOCKET_OPEN mirrors the DOM `WebSocket.OPEN` constant (1).
	// ----------------------------------------------------------------------
	it('WEBSOCKET_OPEN is 1 (matches WebSocket.OPEN)', () => {
		expect(WEBSOCKET_OPEN).toBe(1);
	});

	// ----------------------------------------------------------------------
	// shouldForceCloseHalfOpen: force-close ONLY a stale, OPEN socket.
	// ----------------------------------------------------------------------
	describe('shouldForceCloseHalfOpen', () => {
		it('force-closes an OPEN socket whose heartbeat is stale', () => {
			const tracker = createHeartbeatTracker();
			tracker.recordTraffic(0);
			// 15001 - 0 = 15001 > 15000 (default threshold) → stale.
			expect(shouldForceCloseHalfOpen(tracker, 15001, WEBSOCKET_OPEN)).toBe(true);
		});

		it('does NOT force-close an OPEN socket that is still fresh', () => {
			const tracker = createHeartbeatTracker();
			tracker.recordTraffic(0);
			// 15000 - 0 = 15000, NOT > 15000 → fresh.
			expect(shouldForceCloseHalfOpen(tracker, 15000, WEBSOCKET_OPEN)).toBe(false);
		});

		it('never force-closes a CONNECTING socket (owned by reconnect)', () => {
			const tracker = createHeartbeatTracker();
			tracker.recordTraffic(0);
			// readyState 0 = CONNECTING — even when stale, leave it to reconnect.
			expect(shouldForceCloseHalfOpen(tracker, 99999, 0)).toBe(false);
		});

		it('never force-closes a CLOSING socket', () => {
			const tracker = createHeartbeatTracker();
			tracker.recordTraffic(0);
			// readyState 2 = CLOSING.
			expect(shouldForceCloseHalfOpen(tracker, 99999, 2)).toBe(false);
		});

		it('never force-closes a CLOSED socket', () => {
			const tracker = createHeartbeatTracker();
			tracker.recordTraffic(0);
			// readyState 3 = CLOSED.
			expect(shouldForceCloseHalfOpen(tracker, 99999, 3)).toBe(false);
		});

		it('never force-closes when there is no socket (undefined readyState)', () => {
			const tracker = createHeartbeatTracker();
			tracker.recordTraffic(0);
			expect(shouldForceCloseHalfOpen(tracker, 99999, undefined)).toBe(false);
		});

		it('recorded traffic rescues an OPEN socket from force-close', () => {
			const tracker = createHeartbeatTracker();
			tracker.recordTraffic(0);
			expect(shouldForceCloseHalfOpen(tracker, 20000, WEBSOCKET_OPEN)).toBe(true);
			// Fresh inbound frame at t=20000 refutes the half-open verdict.
			tracker.recordTraffic(20000);
			expect(shouldForceCloseHalfOpen(tracker, 20000, WEBSOCKET_OPEN)).toBe(false);
		});
	});

	// ----------------------------------------------------------------------
	// parseServerPing: recognise `{ t: <positive int ms> }` payloads only.
	// ----------------------------------------------------------------------
	describe('parseServerPing', () => {
		it('accepts a well-formed positive integer timestamp', () => {
			expect(parseServerPing({ t: 1700000000000 })).toEqual({ t: 1700000000000 });
		});

		it('accepts a minimal positive timestamp', () => {
			expect(parseServerPing({ t: 1 })).toEqual({ t: 1 });
		});

		it('rejects a zero timestamp (not positive)', () => {
			expect(parseServerPing({ t: 0 })).toBeNull();
		});

		it('rejects a negative timestamp', () => {
			expect(parseServerPing({ t: -5 })).toBeNull();
		});

		it('rejects a non-integer timestamp', () => {
			expect(parseServerPing({ t: 1.5 })).toBeNull();
		});

		it('rejects a non-numeric timestamp', () => {
			expect(parseServerPing({ t: '123' })).toBeNull();
		});

		it('rejects an object missing t', () => {
			expect(parseServerPing({})).toBeNull();
		});

		it('rejects null', () => {
			expect(parseServerPing(null)).toBeNull();
		});

		it('rejects a primitive', () => {
			expect(parseServerPing(123)).toBeNull();
			expect(parseServerPing('ping')).toBeNull();
		});
	});
});
