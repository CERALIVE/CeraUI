/**
 * Unit tests for the PURE reconnect-backoff core (Task 5).
 *
 * Mirrors the time-injection pattern from `dirty-registry.test.ts`: randomness
 * is ALWAYS injected via an explicit `rand` function (never `Math.random`, never
 * `vi.useFakeTimers`), so the suite is fully deterministic and flake-free.
 *
 * The transport retries FOREVER — these tests pin the two properties that make
 * that safe: the delay is always finite (no Infinity/NaN/null give-up), and ±30%
 * jitter is applied on every step including once the cap is reached.
 */

import { describe, expect, it } from 'vitest';

import { JITTER_RATIO, nextBackoffDelay } from './backoff';

const BASE = 1000;
const CAP = 30000;

describe('nextBackoffDelay pure core', () => {
	// rand()=0 → multiplier (1 - 0.3) = 0.7 → 1000 * 0.7 = 700 (jitter on step 0).
	it('applies the lower jitter bound on the very first attempt', () => {
		expect(nextBackoffDelay(0, BASE, CAP, () => 0)).toBeCloseTo(700, 6);
	});

	// rand()=1 → multiplier (1 + 0.3) = 1.3; attempt 20 saturates the cap →
	// 30000 * 1.3 = 39000, the hard upper bound. Must never exceed it.
	it('caps at cap*(1+JITTER) on a saturated attempt with the upper jitter bound', () => {
		expect(nextBackoffDelay(20, BASE, CAP, () => 1)).toBeLessThanOrEqual(39000);
		expect(nextBackoffDelay(20, BASE, CAP, () => 1)).toBeCloseTo(39000, 6);
	});

	// rand()=0.5 → multiplier exactly 1 (no jitter) → un-jittered capped value.
	it('returns the un-jittered capped delay when rand() is the midpoint', () => {
		expect(nextBackoffDelay(2, BASE, CAP, () => 0.5)).toBeCloseTo(4000, 6); // 1000*2^2
		expect(nextBackoffDelay(20, BASE, CAP, () => 0.5)).toBeCloseTo(30000, 6); // capped
	});

	// Jitter must be present on EVERY step — including capped attempts. The same
	// attempt with rand=0 vs rand=1 must differ, proving jitter is not skipped.
	it('applies jitter on every step, including once the cap is reached', () => {
		const low = nextBackoffDelay(20, BASE, CAP, () => 0); // 30000 * 0.7
		const high = nextBackoffDelay(20, BASE, CAP, () => 1); // 30000 * 1.3
		expect(low).toBeCloseTo(21000, 6);
		expect(high).toBeCloseTo(39000, 6);
		expect(low).not.toBe(high);
	});

	// Never returns null / Infinity / NaN — across a wide spread of attempts and
	// both jitter extremes (the give-up bug would surface as a non-finite delay).
	it('never returns null, Infinity, or NaN for any attempt', () => {
		for (const attempt of [0, 1, 5, 6, 10, 20, 50, 100, 1000, 100000]) {
			for (const r of [0, 0.5, 1]) {
				const d = nextBackoffDelay(attempt, BASE, CAP, () => r);
				expect(d).not.toBeNull();
				expect(Number.isFinite(d)).toBe(true);
				expect(Number.isNaN(d)).toBe(false);
				expect(d).toBeGreaterThanOrEqual(0);
			}
		}
	});

	// Attempt 6+ still yields a finite, bounded delay — there is NO give-up after
	// the old maxReconnectAttempts=5 threshold. This is the core regression pin.
	it('attempt 6 and beyond still yields a finite bounded delay (no give-up)', () => {
		for (const attempt of [6, 7, 20, 1000]) {
			const d = nextBackoffDelay(attempt, BASE, CAP, () => 0.5);
			expect(Number.isFinite(d)).toBe(true);
			expect(d).toBeLessThanOrEqual(CAP * (1 + JITTER_RATIO));
		}
	});

	// Huge attempts make 2^attempt overflow to Infinity; capping BEFORE jitter
	// must keep the result finite and at the capped envelope.
	it('keeps the delay finite when 2^attempt overflows to Infinity', () => {
		const d = nextBackoffDelay(100000, BASE, CAP, () => 1);
		expect(Number.isFinite(d)).toBe(true);
		expect(d).toBeCloseTo(39000, 6);
	});

	// Defends the default-argument path (Math.random) without asserting an exact
	// value: still finite and within the jittered envelope.
	it('uses Math.random by default and stays within the jittered envelope', () => {
		const d = nextBackoffDelay(3, BASE, CAP);
		expect(Number.isFinite(d)).toBe(true);
		const undithered = Math.min(CAP, BASE * 2 ** 3);
		expect(d).toBeGreaterThanOrEqual(undithered * (1 - JITTER_RATIO));
		expect(d).toBeLessThanOrEqual(undithered * (1 + JITTER_RATIO));
	});
});
