/**
 * IngestStats sparkline derivation — pure, framework-free, and memoized.
 *
 * Extracted from `IngestStats.svelte` (Task 19) so the per-link RTT trend math is
 * unit-testable in isolation and, crucially, *cacheable*. The audit flagged the
 * SVG sparkline being rebuilt on every telemetry tick — on a low-end SoC (Jetson)
 * during active streaming that full-string recompute is wasteful whenever a link's
 * samples have not actually changed since the last derivation.
 *
 * `createLinkViewCache()` memoizes the entire per-`conn_id` view (path string +
 * trend + degrade + health) keyed on the *identity* of the samples buffer. The
 * ring effect in the component allocates a fresh array only when it appends a new
 * sample (`[...prev, sample]`), so a stable reference == unchanged samples == a
 * memo hit. A genuinely new sample swaps the reference and forces exactly one
 * recompute. No data is ever dropped: the buffer (last 60 samples) is the input,
 * the cache only avoids redundant re-derivation of the same buffer.
 *
 * This module is rune-free and never imported for its side effects, mirroring the
 * `hud/` pure-derivation split (see `lib/stores/hud.svelte.ts`).
 */

// ── Fixed-size history ring (RAM-only, per-link) ──────────────────────────────
// One bounded buffer per uplink (keyed by conn_id). When full, the oldest sample
// is dropped — never persisted, never resized at runtime, never aggregated beyond
// the raw ring.
export const RING_CAPACITY = 60;
// Trend math compares the leading vs trailing window of the ring.
export const TREND_WINDOW = 10;
export const MIN_SAMPLES_FOR_TREND = TREND_WINDOW * 2;
// "Degrading" = trailing RTT average climbed past this multiple of the leading
// average. The floor keeps the rtt_ms=0 startup constant from tripping the alert.
export const DEGRADE_FACTOR = 2;
export const RTT_FLOOR_MS = 5;
// Sparkline drawing box (unitless SVG user space; the <svg> scales to its cell).
export const SPARK_W = 100;
export const SPARK_H = 24;

export type Sample = { rtt: number; nak: number; weight: number };
export type Trend = "rising" | "falling" | "flat";

export interface LinkViewComputed {
	count: number;
	points: string;
	trend: Trend;
	degraded: boolean;
	score: number;
}

function avg(nums: readonly number[]): number {
	return nums.length === 0
		? 0
		: nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

// Build an SVG polyline from RTT values, normalised over the ring's own min/max so
// the trace fills the box regardless of absolute latency. A higher RTT draws higher.
export function sparkPoints(values: readonly number[]): string {
	if (values.length === 0) return "";
	if (values.length === 1) return `0,${SPARK_H / 2} ${SPARK_W},${SPARK_H / 2}`;
	const min = Math.min(...values);
	const max = Math.max(...values);
	const span = max - min || 1;
	const stepX = SPARK_W / (values.length - 1);
	return values
		.map((v, i) => {
			const x = i * stepX;
			const y = SPARK_H - ((v - min) / span) * SPARK_H;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
}

export function trendOf(samples: readonly Sample[]): Trend {
	if (samples.length < 4) return "flat";
	const w = Math.min(TREND_WINDOW, Math.floor(samples.length / 2));
	const lead = avg(samples.slice(0, w).map((s) => s.rtt));
	const trail = avg(samples.slice(-w).map((s) => s.rtt));
	const delta = trail - lead;
	const threshold = Math.max(2, lead * 0.1);
	if (delta > threshold) return "rising";
	if (delta < -threshold) return "falling";
	return "flat";
}

// Degradation: trailing RTT average more than DEGRADE_FACTOR× the leading average,
// with a floor so a link still settling from rtt_ms=0 doesn't false-alarm.
export function isDegraded(samples: readonly Sample[]): boolean {
	if (samples.length < MIN_SAMPLES_FOR_TREND) return false;
	const lead = avg(samples.slice(0, TREND_WINDOW).map((s) => s.rtt));
	const trail = avg(samples.slice(-TREND_WINDOW).map((s) => s.rtt));
	if (trail < RTT_FLOOR_MS) return false;
	return trail > DEGRADE_FACTOR * Math.max(lead, RTT_FLOOR_MS / DEGRADE_FACTOR);
}

// 100 = stable; drops ~50 pts per doubling of trailing RTT, clamped to [0,100].
export function healthScore(samples: readonly Sample[]): number {
	if (samples.length < MIN_SAMPLES_FOR_TREND) return 100;
	const lead = avg(samples.slice(0, TREND_WINDOW).map((s) => s.rtt));
	const trail = avg(samples.slice(-TREND_WINDOW).map((s) => s.rtt));
	const ratio = trail / Math.max(lead, RTT_FLOOR_MS);
	return Math.round(Math.max(0, Math.min(100, 100 - (ratio - 1) * 50)));
}

// Full per-link derivation from a samples buffer. Pure: same input → same output.
export function computeLinkView(samples: readonly Sample[]): LinkViewComputed {
	return {
		count: samples.length,
		points: sparkPoints(samples.map((s) => s.rtt)),
		trend: trendOf(samples),
		degraded: isDegraded(samples),
		score: healthScore(samples),
	};
}

export interface LinkViewCache {
	/**
	 * Return the derived view for `connId`. Recomputes only when `samples` is a
	 * different array reference than the last call for the same id; an unchanged
	 * buffer returns the cached view without rebuilding the path string.
	 */
	get(connId: string, samples: readonly Sample[]): LinkViewComputed;
	/** Number of actual {@link computeLinkView} invocations — for tests/profiling. */
	readonly computeCount: number;
}

export function createLinkViewCache(): LinkViewCache {
	const cache = new Map<
		string,
		{ ref: readonly Sample[]; view: LinkViewComputed }
	>();
	let computeCount = 0;
	return {
		get(connId, samples) {
			const hit = cache.get(connId);
			if (hit !== undefined && hit.ref === samples) return hit.view;
			computeCount++;
			const view = computeLinkView(samples);
			cache.set(connId, { ref: samples, view });
			return view;
		},
		get computeCount() {
			return computeCount;
		},
	};
}
