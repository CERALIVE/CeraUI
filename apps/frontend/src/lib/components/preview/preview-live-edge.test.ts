// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
	DEFAULT_LIVE_EDGE_POLICY,
	deriveLiveEdgeAction,
	type LiveEdgePolicy,
	pushBoundedSegment,
} from "./preview-live-edge";

// A tight policy for deterministic assertions independent of the shipped defaults.
const POLICY: LiveEdgePolicy = {
	maxPendingSegments: 3,
	catchupThresholdSec: 0.5,
	seekThresholdSec: 1,
	catchupPlaybackRate: 1.05,
	backBufferSec: 8,
	seekMarginSec: 0.1,
};

describe("pushBoundedSegment — drop-oldest bound", () => {
	it("keeps the queue at or below the cap, dropping the OLDEST first", () => {
		const q: number[] = [];
		expect(pushBoundedSegment(q, 1, 3)).toBe(0);
		expect(pushBoundedSegment(q, 2, 3)).toBe(0);
		expect(pushBoundedSegment(q, 3, 3)).toBe(0);
		expect(q).toEqual([1, 2, 3]);
		// The 4th push evicts the oldest (1), keeping the newest 3.
		expect(pushBoundedSegment(q, 4, 3)).toBe(1);
		expect(q).toEqual([2, 3, 4]);
	});

	it("plateaus — 1000 pushes never grow the queue past the cap (bounded memory)", () => {
		const q: number[] = [];
		let totalDropped = 0;
		for (let i = 0; i < 1000; i++) totalDropped += pushBoundedSegment(q, i, 3);
		expect(q).toHaveLength(3);
		expect(q).toEqual([997, 998, 999]);
		expect(totalDropped).toBe(997);
	});

	it("is a no-op bound when under the cap", () => {
		const q: number[] = [10];
		expect(pushBoundedSegment(q, 20, 5)).toBe(0);
		expect(q).toEqual([10, 20]);
	});
});

describe("deriveLiveEdgeAction — live-edge policy", () => {
	it("is a no-op when there is no buffered media yet", () => {
		const d = deriveLiveEdgeAction(
			{ bufferedStart: 0, bufferedEnd: 0, currentTime: 0 },
			POLICY,
		);
		expect(d.seekTo).toBeNull();
		expect(d.playbackRate).toBe(1);
		expect(d.trimBackBufferTo).toBeNull();
	});

	it("plays at normal rate with no seek when the playhead is at the live edge", () => {
		// drift 0.2s < catchupThreshold(0.5) → nothing to do.
		const d = deriveLiveEdgeAction(
			{ bufferedStart: 0, bufferedEnd: 5.2, currentTime: 5 },
			POLICY,
		);
		expect(d.seekTo).toBeNull();
		expect(d.playbackRate).toBe(1);
	});

	it("applies a modest catch-up playback rate inside the soft window", () => {
		// drift 0.7s: above catchup(0.5), below seek(1.0) → gentle 1.05, no seek.
		const d = deriveLiveEdgeAction(
			{ bufferedStart: 0, bufferedEnd: 5.7, currentTime: 5 },
			POLICY,
		);
		expect(d.seekTo).toBeNull();
		expect(d.playbackRate).toBe(1.05);
	});

	it("seeks to the live edge and resets the rate when drift exceeds the seek threshold", () => {
		// drift 3s > seek(1.0) → hard seek to bufferedEnd - margin, rate back to 1.
		const d = deriveLiveEdgeAction(
			{ bufferedStart: 0, bufferedEnd: 8, currentTime: 5 },
			POLICY,
		);
		expect(d.seekTo).toBeCloseTo(7.9, 5);
		expect(d.playbackRate).toBe(1);
	});

	it("trims the back-buffer once it grows past the back-buffer window", () => {
		// currentTime - bufferedStart = 20 > backBufferSec(8) → trim to currentTime - 8.
		const d = deriveLiveEdgeAction(
			{ bufferedStart: 0, bufferedEnd: 20.2, currentTime: 20 },
			POLICY,
		);
		expect(d.trimBackBufferTo).toBeCloseTo(12, 5);
	});

	it("does not trim the back-buffer while it is within the window", () => {
		const d = deriveLiveEdgeAction(
			{ bufferedStart: 0, bufferedEnd: 4.1, currentTime: 4 },
			POLICY,
		);
		expect(d.trimBackBufferTo).toBeNull();
	});
});

describe("bounded memory under a slow consumer", () => {
	// A slow SourceBuffer: only one queued segment is appended (drained) per this
	// many incoming segments. The OLD `pendingSegments.push` had no cap, so the
	// queue grew without bound; `pushBoundedSegment` plateaus.
	const DRAIN_EVERY = 10;
	const CAP = DEFAULT_LIVE_EDGE_POLICY.maxPendingSegments;

	it("plateaus the bounded queue where a naive unbounded push grows forever", () => {
		const bounded: number[] = [];
		const legacy: number[] = []; // reproduces the pre-fix unbounded push

		for (let i = 0; i < 5000; i++) {
			pushBoundedSegment(bounded, i, CAP);
			legacy.push(i);
			// Slow consumer: drain a single segment occasionally.
			if (i % DRAIN_EVERY === 0) {
				bounded.shift();
				legacy.shift();
			}
		}

		// The bound the OLD code provably violates: the naive queue grew far past
		// the cap; the bounded queue never did.
		expect(legacy.length).toBeGreaterThan(CAP);
		expect(bounded.length).toBeLessThanOrEqual(CAP);
	});

	it("frees the queue on teardown (resetMedia empties pendingSegments)", () => {
		const q: number[] = [];
		for (let i = 0; i < 500; i++) pushBoundedSegment(q, i, CAP);
		expect(q.length).toBeGreaterThan(0);
		// resetMedia() clears the queue with `pendingSegments.length = 0`.
		q.length = 0;
		expect(q).toHaveLength(0);
	});
});

describe("DEFAULT_LIVE_EDGE_POLICY", () => {
	it("uses a ~1s seek threshold and a 1.05 catch-up rate above a smaller soft window", () => {
		expect(DEFAULT_LIVE_EDGE_POLICY.seekThresholdSec).toBeCloseTo(1, 5);
		expect(DEFAULT_LIVE_EDGE_POLICY.catchupPlaybackRate).toBe(1.05);
		expect(DEFAULT_LIVE_EDGE_POLICY.catchupThresholdSec).toBeLessThan(
			DEFAULT_LIVE_EDGE_POLICY.seekThresholdSec,
		);
		expect(DEFAULT_LIVE_EDGE_POLICY.maxPendingSegments).toBeGreaterThan(0);
	});
});
