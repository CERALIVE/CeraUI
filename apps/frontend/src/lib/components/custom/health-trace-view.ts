/**
 * Device-Health strip-recorder geometry — pure, framework-free, and memoized.
 *
 * The sibling of `ingest-link-view.ts` for the Device Health panel: it turns two
 * timestamped sample rings into the SVG geometry `HealthTraceField.svelte` draws,
 * with no runes, no i18n, and no formatting. Every number here is user-space SVG
 * units; every string is a `points`/`d` payload. Labels and units are formatted by
 * the component, so this module stays unit-testable with no framework.
 *
 * The one idea the whole panel rests on
 * -------------------------------------
 * **The right edge is wall-clock `now`, never the last sample.** A feed that stops
 * does not freeze — its last point scrolls leftward away from the playhead and
 * leaves a widening void. Staleness stops being a badge bolted onto a number and
 * becomes a geometric fact. Three rules carry it:
 *
 *  1. `projectSegment` maps a sample's REAL timestamp onto x against `now`, so a
 *     dead feed's trace visibly falls behind {@link TRACE_RIGHT_EDGE}.
 *  2. `splitSegments` LIFTS THE PEN across any gap wider than the lane's own
 *     `gapMs` — consecutive samples further apart than that are not connected, so
 *     a WS reconnect / backend restart / stalled collector carves a real notch
 *     instead of being interpolated away. Absence is never smoothed.
 *  3. Each lane keeps its OWN timestamps and its OWN cadence. Temperature (1 Hz)
 *     draws densely, load (0.2 Hz) coarsely. Samples are never resampled onto a
 *     shared grid, because resampling invents readings that were never taken.
 *
 * Memoization
 * -----------
 * {@link createLaneViewCache} keys a lane's whole view on the samples-buffer
 * REFERENCE plus the clock tick. The reference half is the `ingest-link-view.ts`
 * rule verbatim (the ring appends a fresh array, so a stable reference means
 * unchanged samples). The clock half is unavoidable and deliberate: the right edge
 * IS wall-clock, so geometry is a function of `now` too. The clock ticks once per
 * second, so a lane recomputes at most 1 Hz and any re-render inside the same
 * second with the same buffer is a memo hit.
 */

// ── Window ───────────────────────────────────────────────────────────────────
/**
 * How much history the recorder shows. Long enough to make a thermal ramp
 * legible; short enough that the ring is populated within a minute of app start.
 */
export const WINDOW_MS = 300_000;

// ── Cadences and the staleness thresholds derived from them ──────────────────
/** `sensors` broadcast cadence — the temperature lane's pen rate. */
export const TEMP_CADENCE_MS = 1_000;
/** `device-stats` broadcast cadence — the load lane's pen rate. */
export const LOAD_CADENCE_MS = 5_000;

/**
 * Temperature staleness. Equal to the global `STALE_THRESHOLD_MS` (5 s = 5x the
 * 1 Hz sensors cadence) — this lane degrades exactly like every other live
 * surface fed by `sensors`.
 */
export const TEMP_STALE_MS = 5_000;

/**
 * Load staleness — **a local constant, deliberately NOT the global one.**
 * `device-stats` broadcasts every 5 000 ms and the global `STALE_THRESHOLD_MS` is
 * also 5 000 ms, so reusing it would flag EVERY load sample stale in the instant
 * before its successor arrives. 2x the cadence + 2 s of slack is the honest
 * window. The global threshold is untouched: the HUD depends on it and its 5 s
 * value is correct for the 1 Hz feed it governs.
 */
export const DEVICE_STATS_STALE_MS = 12_000;

// ── Downsampling ─────────────────────────────────────────────────────────────
/**
 * Temperature bucket. Keeps the most recent sample per 2 s slice (<=150 points
 * over the window) so the polyline stays cheap on an RK3588. The kept sample
 * retains its REAL timestamp — never the bucket centre — so the gap rule below
 * stays exact.
 */
export const TEMP_BUCKET_MS = 2_000;

/**
 * Pen-lift thresholds — below this a gap is jitter, above it a real hole. Each
 * is `2 x the lane's EFFECTIVE PLOTTED cadence`, which for a downsampled lane is
 * the BUCKET, not the feed.
 *
 * Getting that wrong is not cosmetic. Keeping the survivor's real timestamp is
 * what makes the gap rule exact, and it also means two kept samples can sit
 * almost a full bucket apart in each direction — up to ~2x the bucket. Measured
 * against `2 x TEMP_CADENCE_MS` (2 s), a perfectly healthy 1 Hz feed therefore
 * tripped the rule on nearly every adjacent pair: a live board render showed 164
 * points shattered into 93 strokes with 91 pen-lift markers, i.e. the panel
 * reporting continuous data as an outage.
 *
 * A genuinely dead temperature feed still lifts the pen — it just has to be dead
 * for longer than two buckets rather than longer than two samples.
 */
export const TEMP_GAP_MS = TEMP_BUCKET_MS * 2;
export const LOAD_GAP_MS = LOAD_CADENCE_MS * 2;

/** 5 min / 1 s, hard cap on the temperature ring. */
export const MAX_TEMP_SAMPLES = 320;
/** 5 min / 5 s, hard cap on the load ring. */
export const MAX_LOAD_SAMPLES = 80;

// ── Domains ──────────────────────────────────────────────────────────────────
/**
 * Temperature is drawn against a FIXED physical domain, printed on the lane.
 * A fixed scale means a 0.4 degree wobble does not draw like a crisis and two
 * sessions are visually comparable. Self-normalising (the `sparkPoints` approach)
 * is right for RTT and wrong for temperature.
 */
export const TEMP_DOMAIN: LaneDomain = { min: 20, max: 95 };

/**
 * Load has no honest fixed ceiling — converting a load average to a percentage
 * needs the device's core count, which the frontend does not have
 * (`navigator.hardwareConcurrency` describes the OPERATOR'S BROWSER, not the
 * board). So the lane self-scales from 0 to at least this, and prints the
 * resulting maximum: the normalisation is disclosed, not hidden.
 */
export const LOAD_DOMAIN_MIN_CEILING = 2;

// ── Geometry ─────────────────────────────────────────────────────────────────
/**
 * The drawing box. Mirrors the `SPARK_W`/`SPARK_H` export convention in
 * `ingest-link-view.ts`: fixed user-space units, `preserveAspectRatio="none"` on
 * the `<svg>`, `vector-effect="non-scaling-stroke"` on every stroke — so the
 * trace gets horizontally denser on a narrow roll without the stroke thinning,
 * exactly how a narrower paper roll behaves.
 */
export const TRACE_W = 600;

/** The playhead sits at the right edge: `x = TRACE_W` IS wall-clock now. */
export const TRACE_RIGHT_EDGE = TRACE_W;

export interface TraceGeometry {
	/** Height of a lane's printed name row, above its plot. */
	readonly laneLabelH: number;
	/** Height of a lane's plot area. */
	readonly lanePlotH: number;
	/** Gap under each lane (also separates lane 2 from the axis ruler). */
	readonly laneGap: number;
	/** Height of the axis ruler strip at the bottom. */
	readonly rulerH: number;
}

/** Desktop recorder: two full lanes plus the ruler, 132 user units tall. */
export const DESKTOP_GEOMETRY: TraceGeometry = {
	laneLabelH: 12,
	lanePlotH: 38,
	laneGap: 8,
	rulerH: 16,
};

/**
 * Kiosk/compact recorder (<=1024 px, and the 1024x600 touch panel): still TWO
 * FULL LANES — the panel never drops a signal to fit — just a shorter plot and a
 * denser ruler. 104 user units tall.
 */
export const COMPACT_GEOMETRY: TraceGeometry = {
	laneLabelH: 11,
	lanePlotH: 27,
	laneGap: 7,
	rulerH: 14,
};

/** Total height of the drawing box for a geometry (two lanes + ruler). */
export function traceHeight(g: TraceGeometry): number {
	return (g.laneLabelH + g.lanePlotH + g.laneGap) * 2 + g.rulerH;
}

/** Vertical placement of lane `index` (0 = top) under a geometry. */
export function laneBox(
	g: TraceGeometry,
	index: number,
): { labelY: number; plotTop: number; plotH: number; baselineY: number } {
	const stride = g.laneLabelH + g.lanePlotH + g.laneGap;
	const labelTop = index * stride;
	const plotTop = labelTop + g.laneLabelH;
	return {
		// Baseline of the printed lane name, sitting just above its plot.
		labelY: labelTop + g.laneLabelH - 2,
		plotTop,
		plotH: g.lanePlotH,
		baselineY: plotTop + g.lanePlotH,
	};
}

/** Top edge (and rule position) of the axis ruler strip. */
export function rulerTop(g: TraceGeometry): number {
	return (g.laneLabelH + g.lanePlotH + g.laneGap) * 2;
}

/** Horizontal distance one second of wall-clock occupies. */
export const SECOND_WIDTH = TRACE_W / (WINDOW_MS / 1000);

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * One reading, with the timestamp it ARRIVED at.
 *
 * There is no `null` variant on purpose: a collector that degrades to `null`
 * simply appends nothing, which widens the time gap and lifts the pen through
 * the ordinary rule. A hole is a hole; it is never a flat continuation and never
 * a synthesised zero.
 */
export interface TraceSample {
	readonly t: number;
	readonly v: number;
}

export interface LaneDomain {
	readonly min: number;
	readonly max: number;
}

export interface LaneStats {
	readonly min: number;
	readonly max: number;
	readonly first: number;
	readonly last: number;
	/** `last - first` across the visible window. */
	readonly delta: number;
	readonly count: number;
}

/** A pen-lift, expressed on the lane baseline in user-space x units. */
export interface LaneGap {
	readonly x1: number;
	readonly x2: number;
}

export interface LaneInput {
	readonly id: string;
	readonly samples: readonly TraceSample[];
	/** Fixed physical domain, or `"auto"` to self-scale and print the maximum. */
	readonly domain: LaneDomain | "auto";
	/** Pen-lift threshold for this lane (2x its own cadence). */
	readonly gapMs: number;
	/** Optional downsample bucket; omitted lanes keep every sample. */
	readonly bucketMs?: number;
	/** Lower bound for a self-scaling ceiling. Ignored for a fixed domain. */
	readonly autoMinCeiling?: number;
}

export interface LaneView {
	readonly id: string;
	readonly labelY: number;
	readonly plotTop: number;
	readonly plotH: number;
	readonly baselineY: number;
	/** One `points` payload per unbroken pen stroke. Empty ⇒ nothing to draw. */
	readonly segments: readonly string[];
	/** Pen-lifts inside the window, in draw order. */
	readonly gaps: readonly LaneGap[];
	/** The domain actually used — printed on the lane so it is disclosed. */
	readonly domain: LaneDomain;
	/** Newest reading in the window, or `null` when the window is empty. */
	readonly latest: number | null;
	/** Window min/max/delta, or `null` when the window is empty. */
	readonly stats: LaneStats | null;
	/** Samples actually plotted (post-trim, post-bucket). */
	readonly pointCount: number;
	/** x of the newest sample — the playhead void starts here. */
	readonly lastX: number | null;
}

// ── Pure derivations ─────────────────────────────────────────────────────────

/** Keep only the samples inside `[now - windowMs, now]`. Input must be sorted. */
export function trimWindow(
	samples: readonly TraceSample[],
	now: number,
	windowMs: number = WINDOW_MS,
): TraceSample[] {
	const floor = now - windowMs;
	const out: TraceSample[] = [];
	for (const s of samples) {
		if (s.t >= floor && s.t <= now) out.push(s);
	}
	return out;
}

/**
 * Keep the MOST RECENT sample per `bucketMs` slice. The survivor keeps its own
 * real timestamp — never the bucket centre — so the gap rule stays exact and a
 * downsampled trace can never manufacture continuity across a hole.
 */
export function bucketSamples(
	samples: readonly TraceSample[],
	bucketMs: number,
): TraceSample[] {
	if (bucketMs <= 0 || samples.length === 0) return [...samples];
	const out: TraceSample[] = [];
	let currentBucket: number | null = null;
	for (const s of samples) {
		const bucket = Math.floor(s.t / bucketMs);
		if (bucket === currentBucket) {
			out[out.length - 1] = s;
		} else {
			out.push(s);
			currentBucket = bucket;
		}
	}
	return out;
}

/**
 * Split into unbroken strokes. Consecutive samples more than `gapMs` apart are
 * NOT connected — the pen lifts. This is the rule that makes a stalled collector
 * carve a permanent notch instead of being interpolated away.
 */
export function splitSegments(
	samples: readonly TraceSample[],
	gapMs: number,
): TraceSample[][] {
	const segments: TraceSample[][] = [];
	let current: TraceSample[] = [];
	let prev: TraceSample | undefined;
	for (const s of samples) {
		if (prev !== undefined && s.t - prev.t > gapMs) {
			if (current.length > 0) segments.push(current);
			current = [];
		}
		current.push(s);
		prev = s;
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

/** Window min/max/delta. `null` for an empty window — never a fabricated zero. */
export function windowStats(samples: readonly TraceSample[]): LaneStats | null {
	const first = samples[0];
	const last = samples[samples.length - 1];
	if (first === undefined || last === undefined) return null;
	let min = first.v;
	let max = first.v;
	for (const s of samples) {
		if (s.v < min) min = s.v;
		if (s.v > max) max = s.v;
	}
	return {
		min,
		max,
		first: first.v,
		last: last.v,
		delta: last.v - first.v,
		count: samples.length,
	};
}

/**
 * Self-scaling domain: `0 → max(minCeiling, ceil(window peak))`. Used only where
 * no honest fixed ceiling exists (the load lane), and the resulting maximum is
 * always printed on the lane so the normalisation is disclosed.
 */
export function selfScalingDomain(
	samples: readonly TraceSample[],
	minCeiling: number = LOAD_DOMAIN_MIN_CEILING,
): LaneDomain {
	let peak = 0;
	for (const s of samples) {
		if (s.v > peak) peak = s.v;
	}
	return { min: 0, max: Math.max(minCeiling, Math.ceil(peak)) };
}

/** Map a timestamp onto x, with `now` pinned to the right edge. */
export function projectX(
	t: number,
	now: number,
	windowMs: number = WINDOW_MS,
): number {
	return TRACE_W - ((now - t) / windowMs) * TRACE_W;
}

/** Map a value onto y inside a lane's plot box (higher value draws higher). */
export function projectY(
	v: number,
	domain: LaneDomain,
	plotTop: number,
	plotH: number,
): number {
	const span = domain.max - domain.min || 1;
	const clamped = Math.min(Math.max(v, domain.min), domain.max);
	return plotTop + plotH - ((clamped - domain.min) / span) * plotH;
}

/** Build one stroke's `points` payload. */
export function projectSegment(
	segment: readonly TraceSample[],
	now: number,
	domain: LaneDomain,
	plotTop: number,
	plotH: number,
	windowMs: number = WINDOW_MS,
): string {
	return segment
		.map(
			(s) =>
				`${projectX(s.t, now, windowMs).toFixed(1)},${projectY(s.v, domain, plotTop, plotH).toFixed(1)}`,
		)
		.join(" ");
}

/** Full lane derivation. Pure: same inputs → same output. */
export function buildLaneView(
	input: LaneInput,
	now: number,
	geometry: TraceGeometry,
	laneIndex: number,
	windowMs: number = WINDOW_MS,
): LaneView {
	const box = laneBox(geometry, laneIndex);
	const windowed = trimWindow(input.samples, now, windowMs);
	const plotted =
		input.bucketMs === undefined
			? windowed
			: bucketSamples(windowed, input.bucketMs);
	const domain =
		input.domain === "auto"
			? selfScalingDomain(plotted, input.autoMinCeiling)
			: input.domain;
	const segments = splitSegments(plotted, input.gapMs);
	const gaps: LaneGap[] = [];
	for (let i = 1; i < segments.length; i++) {
		const prevSeg = segments[i - 1];
		const nextSeg = segments[i];
		const prevLast = prevSeg?.[prevSeg.length - 1];
		const nextFirst = nextSeg?.[0];
		if (prevLast === undefined || nextFirst === undefined) continue;
		gaps.push({
			x1: projectX(prevLast.t, now, windowMs),
			x2: projectX(nextFirst.t, now, windowMs),
		});
	}
	const last = plotted[plotted.length - 1];
	return {
		id: input.id,
		labelY: box.labelY,
		plotTop: box.plotTop,
		plotH: box.plotH,
		baselineY: box.baselineY,
		segments: segments
			// A single-sample stroke has no line to draw, but its dot still matters
			// for the "where did the feed stop" read, so it is kept as a 1-point
			// payload the component renders as a vertex marker.
			.map((seg) =>
				projectSegment(seg, now, domain, box.plotTop, box.plotH, windowMs),
			)
			.filter((points) => points.length > 0),
		gaps,
		domain,
		latest: last?.v ?? null,
		stats: windowStats(plotted),
		pointCount: plotted.length,
		lastX: last === undefined ? null : projectX(last.t, now, windowMs),
	};
}

// ── Memoization ──────────────────────────────────────────────────────────────

export interface LaneViewCache {
	/**
	 * Return the derived view for `laneId`. Recomputes only when the samples
	 * buffer is a different array reference OR the clock tick changed — the right
	 * edge is wall-clock, so `now` is genuinely part of the geometry. Any
	 * re-render inside the same second with the same buffer is a memo hit.
	 */
	get(
		input: LaneInput,
		now: number,
		geometry: TraceGeometry,
		laneIndex: number,
	): LaneView;
	/** Number of actual {@link buildLaneView} invocations — for tests/profiling. */
	readonly computeCount: number;
}

export function createLaneViewCache(): LaneViewCache {
	const cache = new Map<
		string,
		{
			ref: readonly TraceSample[];
			now: number;
			geometry: TraceGeometry;
			laneIndex: number;
			view: LaneView;
		}
	>();
	let computeCount = 0;
	return {
		get(input, now, geometry, laneIndex) {
			const hit = cache.get(input.id);
			if (
				hit !== undefined &&
				hit.ref === input.samples &&
				hit.now === now &&
				hit.geometry === geometry &&
				hit.laneIndex === laneIndex
			) {
				return hit.view;
			}
			computeCount++;
			const view = buildLaneView(input, now, geometry, laneIndex);
			cache.set(input.id, {
				ref: input.samples,
				now,
				geometry,
				laneIndex,
				view,
			});
			return view;
		},
		get computeCount() {
			return computeCount;
		},
	};
}

// ── Per-signal state ─────────────────────────────────────────────────────────

/**
 * The five per-signal states the panel renders reduce to four here; the fifth,
 * `not-instrumented`, is a property of the BOARD rather than of a feed and is
 * decided elsewhere — it is a provable statement, never a timeout.
 *
 * `unavailable` means a FRESH delivery whose collector degraded to `null`: a
 * hole, never a flat continuation and never a synthesised zero.
 */
export type LaneSignalState = "waiting" | "live" | "aging" | "unavailable";

export interface LaneSignalStatus {
	readonly state: LaneSignalState;
	/** Last KNOWN value — retained through `aging` so the operator keeps context. */
	readonly value: number | null;
	readonly lastDeliveryAt: number | null;
	/** Age of the last delivery in ms, or `null` when nothing has arrived. */
	readonly ageMs: number | null;
}

/**
 * Arrival-stamped, and that is correct HERE — deliberately unlike the audio
 * meter's content-keyed watchdog. That rule exists because a capture device can
 * clock FROZEN buffers forever. Neither producer behind this panel does that:
 * every `sensors`/`device-stats` tick re-reads `/proc` and `/sys`, and a failed
 * collector degrades to `null` rather than retaining its previous value. So a
 * dead source arrives as a hole, and two identical consecutive readings are a
 * legitimate steady state rather than evidence of a stall.
 */
export function deriveLaneSignalStatus(
	lastDeliveryAt: number | null,
	lastValue: number | null,
	now: number,
	staleMs: number,
): LaneSignalStatus {
	if (lastDeliveryAt === null) {
		return { state: "waiting", value: null, lastDeliveryAt: null, ageMs: null };
	}
	const ageMs = now - lastDeliveryAt;
	if (ageMs >= staleMs) {
		return { state: "aging", value: lastValue, lastDeliveryAt, ageMs };
	}
	if (lastValue === null) {
		return { state: "unavailable", value: null, lastDeliveryAt, ageMs };
	}
	return { state: "live", value: lastValue, lastDeliveryAt, ageMs };
}

// ── Axis ─────────────────────────────────────────────────────────────────────

export interface AxisTick {
	/** Whole minutes before now (0 = the playhead). */
	readonly minutesAgo: number;
	readonly x: number;
}

/**
 * Ruler ticks for the window. `dense` (desktop) prints every minute; the compact
 * ruler prints -5 / -3 / -1 / now only, so the 1024x600 kiosk panel never
 * collides its numerals.
 */
export function axisTicks(
	dense: boolean,
	windowMs: number = WINDOW_MS,
): AxisTick[] {
	const totalMinutes = Math.round(windowMs / 60_000);
	const minutes = dense
		? Array.from({ length: totalMinutes + 1 }, (_, i) => totalMinutes - i)
		: [5, 3, 1, 0].filter((m) => m <= totalMinutes);
	return minutes.map((minutesAgo) => ({
		minutesAgo,
		x: TRACE_W - (minutesAgo * 60_000 * TRACE_W) / windowMs,
	}));
}
