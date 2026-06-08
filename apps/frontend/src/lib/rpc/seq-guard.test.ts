/**
 * Unit tests for the PURE seq-guard module (Task 11).
 *
 * These exercise the rune-free functions directly — no Svelte env, no runes.
 * All logic is deterministic and parameter-injected (no Date.now, no timers).
 *
 * Coverage map:
 *   T1 — shouldDropMessage: duplicate (incomingSeq === lastSeen) → drop
 *   T2 — shouldDropMessage: stale (incomingSeq < lastSeen) → drop
 *   T3 — shouldDropMessage: newer (incomingSeq > lastSeen) → accept
 *   T4 — shouldDropMessage: post-reconnect reset (opts.reset=true) → accept
 *   T5 — createSeqTracker: shouldDrop with no prior state → accept (prevSeen=-1)
 *   T6 — createSeqTracker: shouldDrop after advance → drop stale, accept newer
 *   T7 — createSeqTracker: resetOnReconnect clears all lastSeen
 *   T8 — createSeqTracker: per-type independence (type A and B separate)
 */

import { describe, expect, it } from "vitest";

import { createSeqTracker, shouldDropMessage } from "./seq-guard";

describe("seq-guard pure core", () => {
	// -----------------------------------------------------------------------
	// T1 — Duplicate: incomingSeq === lastSeen → drop
	// -----------------------------------------------------------------------
	it("T1: shouldDropMessage drops duplicate (incomingSeq === lastSeen)", () => {
		expect(shouldDropMessage(42, 42)).toBe(true);
	});

	// -----------------------------------------------------------------------
	// T2 — Stale: incomingSeq < lastSeen → drop
	// -----------------------------------------------------------------------
	it("T2: shouldDropMessage drops stale (incomingSeq < lastSeen)", () => {
		expect(shouldDropMessage(41, 42)).toBe(true);
	});

	// -----------------------------------------------------------------------
	// T3 — Newer: incomingSeq > lastSeen → accept
	// -----------------------------------------------------------------------
	it("T3: shouldDropMessage accepts newer (incomingSeq > lastSeen)", () => {
		expect(shouldDropMessage(43, 42)).toBe(false);
	});

	// -----------------------------------------------------------------------
	// T4 — Post-reconnect reset: opts.reset=true → accept regardless
	// -----------------------------------------------------------------------
	it("T4: shouldDropMessage accepts with reset=true (post-reconnect)", () => {
		// Even if incomingSeq <= lastSeen, reset=true forces acceptance
		expect(shouldDropMessage(1, 999, { reset: true })).toBe(false);
		expect(shouldDropMessage(42, 42, { reset: true })).toBe(false);
	});

	// -----------------------------------------------------------------------
	// T5 — createSeqTracker: shouldDrop with no prior state → accept
	// -----------------------------------------------------------------------
	it("T5: tracker.shouldDrop with no prior state accepts (prevSeen=-1)", () => {
		const tracker = createSeqTracker();
		// First message for type 'config' — no prior state, so prevSeen=-1
		// shouldDropMessage(0, -1) → 0 > -1 → false (accept)
		expect(tracker.shouldDrop("config", 0)).toBe(false);
	});

	// -----------------------------------------------------------------------
	// T6 — createSeqTracker: shouldDrop after advance → drop stale, accept newer
	// -----------------------------------------------------------------------
	it("T6: tracker.shouldDrop after advance drops stale, accepts newer", () => {
		const tracker = createSeqTracker();

		// Advance 'status' to seq 10
		tracker.advance("status", 10);

		// Stale message (seq 9) → drop
		expect(tracker.shouldDrop("status", 9)).toBe(true);

		// Duplicate (seq 10) → drop
		expect(tracker.shouldDrop("status", 10)).toBe(true);

		// Newer (seq 11) → accept
		expect(tracker.shouldDrop("status", 11)).toBe(false);

		// Advance to 11
		tracker.advance("status", 11);

		// Gap is fine: seq 15 > 11 → accept
		expect(tracker.shouldDrop("status", 15)).toBe(false);
	});

	// -----------------------------------------------------------------------
	// T7 — createSeqTracker: resetOnReconnect clears all lastSeen
	// -----------------------------------------------------------------------
	it("T7: tracker.resetOnReconnect clears all lastSeen values", () => {
		const tracker = createSeqTracker();

		// Advance multiple types
		tracker.advance("config", 5);
		tracker.advance("status", 10);
		tracker.advance("telemetry", 20);

		// Before reset: stale messages are dropped
		expect(tracker.shouldDrop("config", 4)).toBe(true);
		expect(tracker.shouldDrop("status", 9)).toBe(true);

		// Reset on reconnect
		tracker.resetOnReconnect();

		// After reset: seq 0 is accepted (prevSeen=-1 again)
		expect(tracker.shouldDrop("config", 0)).toBe(false);
		expect(tracker.shouldDrop("status", 0)).toBe(false);
		expect(tracker.shouldDrop("telemetry", 0)).toBe(false);

		// Old stale messages are now accepted (no prior state)
		expect(tracker.shouldDrop("config", 4)).toBe(false);
	});

	// -----------------------------------------------------------------------
	// T8 — createSeqTracker: per-type independence
	// -----------------------------------------------------------------------
	it("T8: tracker maintains per-type independence", () => {
		const tracker = createSeqTracker();

		// Type A: advance to 100
		tracker.advance("typeA", 100);

		// Type B: advance to 50
		tracker.advance("typeB", 50);

		// Type A: seq 99 is stale
		expect(tracker.shouldDrop("typeA", 99)).toBe(true);

		// Type B: seq 99 is newer (50 < 99)
		expect(tracker.shouldDrop("typeB", 99)).toBe(false);

		// Type C (never seen): seq 0 is accepted
		expect(tracker.shouldDrop("typeC", 0)).toBe(false);

		// Advance type C
		tracker.advance("typeC", 0);

		// Type C: seq 1 is newer
		expect(tracker.shouldDrop("typeC", 1)).toBe(false);

		// Type A is unaffected
		expect(tracker.shouldDrop("typeA", 101)).toBe(false);
	});
});
