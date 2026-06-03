/**
 * Unit tests for the PURE heartbeat staleness core (Task 12).
 *
 * Server→client liveness / half-open socket detection. The client already runs
 * its own keepalive (client.ts:187-191); this module derives a deterministic
 * "is the link dead?" verdict from the timestamp of the last observed traffic.
 *
 * Like dirty-registry, these functions are rune-free and side-effect-free: time
 * is ALWAYS injected via explicit `now` numbers (never `Date.now()`, never
 * timers, never `vi.useFakeTimers`), so the suite is fully deterministic.
 */

import { describe, expect, it } from 'vitest';

import {
	createHeartbeatTracker,
	HEARTBEAT_THRESHOLD_MS,
	isHeartbeatStale,
} from './heartbeat';

describe('heartbeat pure core', () => {
	// ----------------------------------------------------------------------
	// Named constant: ≈3 missed 5s pings.
	// ----------------------------------------------------------------------
	it('HEARTBEAT_THRESHOLD_MS is 15000 (≈3 missed 5s pings)', () => {
		expect(HEARTBEAT_THRESHOLD_MS).toBe(15000);
	});

	// ----------------------------------------------------------------------
	// isHeartbeatStale: stale iff (now - lastSeenAt) > threshold.
	// ----------------------------------------------------------------------
	describe('isHeartbeatStale', () => {
		it('is stale one ms past the threshold', () => {
			expect(isHeartbeatStale(0, 15001, 15000)).toBe(true);
		});

		it('is not stale one ms before the threshold', () => {
			expect(isHeartbeatStale(0, 14999, 15000)).toBe(false);
		});

		it('is not stale exactly at the threshold boundary', () => {
			// 20000 - 5000 = 15000, which is NOT > 15000 → not stale.
			expect(isHeartbeatStale(5000, 20000, 15000)).toBe(false);
		});

		it('treats lastSeenAt in the future as fresh', () => {
			expect(isHeartbeatStale(20000, 10000, 15000)).toBe(false);
		});
	});

	// ----------------------------------------------------------------------
	// createHeartbeatTracker: a tiny state holder around isHeartbeatStale.
	// ----------------------------------------------------------------------
	describe('createHeartbeatTracker', () => {
		it('starts at lastSeenAt 0 and uses the default threshold', () => {
			const tracker = createHeartbeatTracker();
			expect(tracker.getLastSeenAt()).toBe(0);
			// now=15001 with default 15000 threshold and lastSeenAt 0 → stale.
			expect(tracker.isStale(15001)).toBe(true);
			expect(tracker.isStale(15000)).toBe(false);
		});

		it('recordTraffic advances lastSeenAt', () => {
			const tracker = createHeartbeatTracker();
			tracker.recordTraffic(5000);
			expect(tracker.getLastSeenAt()).toBe(5000);
		});

		it('traffic resets the staleness window', () => {
			const tracker = createHeartbeatTracker();
			// Record traffic at t=5000; check at t=20000 with threshold 15000.
			// 20000 - 5000 = 15000, NOT > 15000 → not stale.
			tracker.recordTraffic(5000);
			expect(tracker.isStale(20000, 15000)).toBe(false);
			// One ms later it tips over into stale.
			expect(tracker.isStale(20001, 15000)).toBe(true);
		});

		it('honors an explicit threshold override', () => {
			const tracker = createHeartbeatTracker();
			tracker.recordTraffic(0);
			expect(tracker.isStale(5001, 5000)).toBe(true);
			expect(tracker.isStale(4999, 5000)).toBe(false);
		});

		it('later traffic rescues a previously-stale tracker', () => {
			const tracker = createHeartbeatTracker();
			tracker.recordTraffic(0);
			expect(tracker.isStale(20000)).toBe(true);
			tracker.recordTraffic(20000);
			expect(tracker.isStale(20000)).toBe(false);
		});
	});
});
