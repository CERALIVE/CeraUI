/**
 * Pure, rune-free MSE live-edge policy for `PreviewCanvas.svelte`.
 *
 * The MSE fallback tier feeds fragmented-MP4 segments into a `<video>`
 * SourceBuffer. Without a live-edge policy the `<video>` element plays from
 * wherever it started and the playhead drifts ever further behind live as
 * segments accumulate — at 1.5 Mbps the proxy's old keep-oldest buffering left
 * preview ~5.6 s behind. This module is the pure decision core that keeps the
 * playhead pinned to the live edge:
 *
 *   1. `pushBoundedSegment` bounds the pending-append queue (drop-oldest) so a
 *      stalled SourceBuffer can never grow it without bound.
 *   2. `deriveLiveEdgeAction` decides, from the current buffered range and
 *      playhead, whether to hard-seek to the live edge (large drift), apply a
 *      modest catch-up `playbackRate` (moderate drift, soft window), and/or trim
 *      the back-buffer.
 *
 * Both are pure so the policy is unit-testable in isolation from the Svelte
 * component (`preview-live-edge.test.ts`).
 */

/** Tunable thresholds for the live-edge policy. All times are in seconds. */
export interface LiveEdgePolicy {
	/** Hard cap on queued (not-yet-appended) media segments — drop-oldest above it. */
	maxPendingSegments: number;
	/** Drift above this (below {@link seekThresholdSec}) applies the catch-up rate. */
	catchupThresholdSec: number;
	/** Drift above this triggers a hard seek to the live edge. */
	seekThresholdSec: number;
	/** The modest playback rate used to gently catch up inside the soft window. */
	catchupPlaybackRate: number;
	/** Keep at most this many seconds of already-played media behind the playhead. */
	backBufferSec: number;
	/** Seek target is `bufferedEnd - seekMarginSec` (a hair off the very edge). */
	seekMarginSec: number;
}

/**
 * Default policy: seek when >1 s behind live, gently catch up (1.05×) once >0.5 s
 * behind, trim the back-buffer beyond 8 s, and bound the pending queue at 48
 * segments (~a few seconds of fragments — ample slack on a briefly-slow
 * SourceBuffer without unbounded growth).
 */
export const DEFAULT_LIVE_EDGE_POLICY: LiveEdgePolicy = {
	maxPendingSegments: 48,
	catchupThresholdSec: 0.5,
	seekThresholdSec: 1,
	catchupPlaybackRate: 1.05,
	backBufferSec: 8,
	seekMarginSec: 0.1,
};

/**
 * Push `segment` onto `queue` and enforce a drop-OLDEST bound of `maxSegments`.
 * Mutates `queue` in place (matching the component's `pendingSegments` array) and
 * returns the number of oldest segments evicted (0 when under the cap). Keeping
 * the NEWEST segments is the live-edge choice — a stalled consumer resumes at the
 * freshest media, and the frontend `deriveLiveEdgeAction` seek closes any gap the
 * eviction opened.
 */
export function pushBoundedSegment<T>(
	queue: T[],
	segment: T,
	maxSegments: number,
): number {
	queue.push(segment);
	let dropped = 0;
	while (queue.length > maxSegments && queue.length > 0) {
		queue.shift();
		dropped++;
	}
	return dropped;
}

/** A snapshot of the `<video>` playback position vs. its buffered range. */
export interface PlaybackSample {
	/** `video.buffered.start(0)` — the oldest buffered timestamp. */
	bufferedStart: number;
	/** `video.buffered.end(video.buffered.length - 1)` — the live edge. */
	bufferedEnd: number;
	/** `video.currentTime` — the playhead. */
	currentTime: number;
}

/** The live-edge correction to apply to the `<video>` element this tick. */
export interface LiveEdgeDecision {
	/** Seek the playhead here, or `null` to leave it. */
	seekTo: number | null;
	/** The `playbackRate` to set (always defined; `1` = normal). */
	playbackRate: number;
	/** `SourceBuffer.remove(0, trimBackBufferTo)`, or `null` to leave the buffer. */
	trimBackBufferTo: number | null;
}

/**
 * Decide the live-edge correction for the current {@link PlaybackSample}.
 *
 * - No buffered media (`bufferedEnd <= bufferedStart`) → a no-op decision.
 * - drift (`bufferedEnd - currentTime`) `>` {@link LiveEdgePolicy.seekThresholdSec}
 *   → hard seek to `bufferedEnd - seekMarginSec`, rate reset to `1`.
 * - drift `>` {@link LiveEdgePolicy.catchupThresholdSec} (soft window) → keep the
 *   playhead, apply the modest {@link LiveEdgePolicy.catchupPlaybackRate}.
 * - otherwise → normal rate `1`, no seek.
 * - back-buffer (`currentTime - bufferedStart`) `>` {@link LiveEdgePolicy.backBufferSec}
 *   → trim to `currentTime - backBufferSec` (independent of the drift branch).
 */
export function deriveLiveEdgeAction(
	sample: PlaybackSample,
	policy: LiveEdgePolicy = DEFAULT_LIVE_EDGE_POLICY,
): LiveEdgeDecision {
	const { bufferedStart, bufferedEnd, currentTime } = sample;

	// No usable buffered range yet — nothing to correct.
	if (!(bufferedEnd > bufferedStart)) {
		return { seekTo: null, playbackRate: 1, trimBackBufferTo: null };
	}

	const drift = bufferedEnd - currentTime;

	let seekTo: number | null = null;
	let playbackRate = 1;
	if (drift > policy.seekThresholdSec) {
		seekTo = bufferedEnd - policy.seekMarginSec;
		playbackRate = 1;
	} else if (drift > policy.catchupThresholdSec) {
		playbackRate = policy.catchupPlaybackRate;
	}

	let trimBackBufferTo: number | null = null;
	const backBuffer = currentTime - bufferedStart;
	if (backBuffer > policy.backBufferSec) {
		trimBackBufferTo = currentTime - policy.backBufferSec;
	}

	return { seekTo, playbackRate, trimBackBufferTo };
}
