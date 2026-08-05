/**
 * Strip-recorder geometry — the pure half.
 *
 * The cases that matter are the ones where getting it wrong LIES: a gap that
 * gets interpolated away, a downsample that moves a timestamp and therefore
 * closes a real hole, a domain that renormalises so a flat trace looks dramatic,
 * and a stale feed whose trace does not fall behind the playhead.
 */

import { describe, expect, it } from "vitest";

import {
	axisTicks,
	bucketSamples,
	buildLaneView,
	COMPACT_GEOMETRY,
	createLaneViewCache,
	DESKTOP_GEOMETRY,
	DEVICE_STATS_STALE_MS,
	deriveLaneSignalStatus,
	type LaneInput,
	LOAD_GAP_MS,
	laneBox,
	projectX,
	projectY,
	rulerTop,
	selfScalingDomain,
	splitSegments,
	TEMP_BUCKET_MS,
	TEMP_DOMAIN,
	TEMP_GAP_MS,
	TEMP_STALE_MS,
	TRACE_W,
	type TraceSample,
	traceHeight,
	trimWindow,
	WINDOW_MS,
	windowStats,
} from "./health-trace-view";

const NOW = 1_800_000_000_000;

function ramp(count: number, stepMs: number, from = NOW): TraceSample[] {
	return Array.from({ length: count }, (_, i) => ({
		t: from - (count - 1 - i) * stepMs,
		v: 40 + i,
	}));
}

describe("trimWindow", () => {
	it("keeps only the visible window", () => {
		const samples: TraceSample[] = [
			{ t: NOW - WINDOW_MS - 1, v: 1 },
			{ t: NOW - WINDOW_MS, v: 2 },
			{ t: NOW, v: 3 },
		];
		expect(trimWindow(samples, NOW).map((s) => s.v)).toEqual([2, 3]);
	});

	it("drops samples stamped after now", () => {
		expect(trimWindow([{ t: NOW + 1, v: 9 }], NOW)).toEqual([]);
	});
});

describe("splitSegments — the pen lift", () => {
	it("does NOT connect samples further apart than the gap threshold", () => {
		const samples: TraceSample[] = [
			{ t: NOW - 10_000, v: 1 },
			{ t: NOW - 9_000, v: 2 },
			{ t: NOW - 1_000, v: 3 },
		];
		const segments = splitSegments(samples, TEMP_GAP_MS);
		expect(segments).toHaveLength(2);
		expect(segments[0]?.map((s) => s.v)).toEqual([1, 2]);
		expect(segments[1]?.map((s) => s.v)).toEqual([3]);
	});

	it("treats EXACTLY the threshold as jitter, not a hole", () => {
		const samples: TraceSample[] = [
			{ t: NOW - TEMP_GAP_MS, v: 1 },
			{ t: NOW, v: 2 },
		];
		expect(splitSegments(samples, TEMP_GAP_MS)).toHaveLength(1);
	});

	it("splits one millisecond past the threshold", () => {
		const samples: TraceSample[] = [
			{ t: NOW - TEMP_GAP_MS - 1, v: 1 },
			{ t: NOW, v: 2 },
		];
		expect(splitSegments(samples, TEMP_GAP_MS)).toHaveLength(2);
	});
});

describe("bucketSamples", () => {
	it("keeps the most recent sample per bucket", () => {
		const base = Math.floor(NOW / TEMP_BUCKET_MS) * TEMP_BUCKET_MS;
		const samples: TraceSample[] = [
			{ t: base, v: 1 },
			{ t: base + 500, v: 2 },
			{ t: base + TEMP_BUCKET_MS, v: 3 },
		];
		expect(bucketSamples(samples, TEMP_BUCKET_MS).map((s) => s.v)).toEqual([
			2, 3,
		]);
	});

	it("keeps the survivor's REAL timestamp, so the gap rule stays exact", () => {
		const base = Math.floor(NOW / TEMP_BUCKET_MS) * TEMP_BUCKET_MS;
		const kept = bucketSamples(
			[
				{ t: base, v: 1 },
				{ t: base + 1_700, v: 2 },
			],
			TEMP_BUCKET_MS,
		);
		expect(kept[0]?.t).toBe(base + 1_700);
	});

	it("a healthy 1 Hz feed draws ONE unbroken stroke after downsampling", () => {
		// Regression: the pen-lift threshold was `2 x TEMP_CADENCE_MS` while the
		// lane buckets to 2 s. Keeping each survivor's real timestamp means two
		// kept samples can sit nearly two buckets apart, so a perfectly healthy
		// feed tripped the rule on almost every pair — a live render showed 164
		// points shattered into 93 strokes with 91 pen-lift markers.
		const samples = Array.from({ length: 300 }, (_, i) => ({
			t: NOW - (299 - i) * 1_000,
			v: 60 + (i % 3) * 0.1,
		}));
		const view = buildLaneView(
			{
				id: "temp",
				samples,
				domain: TEMP_DOMAIN,
				gapMs: TEMP_GAP_MS,
				bucketMs: TEMP_BUCKET_MS,
			},
			NOW,
			DESKTOP_GEOMETRY,
			0,
		);
		expect(view.segments).toHaveLength(1);
		expect(view.gaps).toHaveLength(0);
	});

	it("a genuinely dead temperature feed still lifts the pen", () => {
		const samples = [
			{ t: NOW - 60_000, v: 60 },
			{ t: NOW - 59_000, v: 60.2 },
			{ t: NOW - 20_000, v: 61 },
			{ t: NOW - 19_000, v: 61.1 },
		];
		const view = buildLaneView(
			{
				id: "temp",
				samples,
				domain: TEMP_DOMAIN,
				gapMs: TEMP_GAP_MS,
				bucketMs: TEMP_BUCKET_MS,
			},
			NOW,
			DESKTOP_GEOMETRY,
			0,
		);
		expect(view.segments).toHaveLength(2);
		expect(view.gaps).toHaveLength(1);
	});

	it("the pen-lift threshold is measured against the BUCKET, not the feed", () => {
		expect(TEMP_GAP_MS).toBe(TEMP_BUCKET_MS * 2);
		expect(TEMP_GAP_MS).toBeGreaterThan(TEMP_BUCKET_MS);
	});

	it("does not manufacture continuity across a hole", () => {
		const samples: TraceSample[] = [
			{ t: NOW - 60_000, v: 1 },
			{ t: NOW, v: 2 },
		];
		const bucketed = bucketSamples(samples, TEMP_BUCKET_MS);
		expect(splitSegments(bucketed, TEMP_GAP_MS)).toHaveLength(2);
	});
});

describe("domains", () => {
	it("temperature is FIXED, so a 0.4 degree wobble does not fill the lane", () => {
		const flat: TraceSample[] = [
			{ t: NOW - 1_000, v: 62.2 },
			{ t: NOW, v: 62.6 },
		];
		const view = buildLaneView(
			{ id: "temp", samples: flat, domain: TEMP_DOMAIN, gapMs: TEMP_GAP_MS },
			NOW,
			DESKTOP_GEOMETRY,
			0,
		);
		expect(view.domain).toEqual(TEMP_DOMAIN);
		const box = laneBox(DESKTOP_GEOMETRY, 0);
		const y1 = projectY(62.2, TEMP_DOMAIN, box.plotTop, box.plotH);
		const y2 = projectY(62.6, TEMP_DOMAIN, box.plotTop, box.plotH);
		expect(Math.abs(y1 - y2)).toBeLessThan(1);
	});

	it("load self-scales but never below the printed floor", () => {
		expect(selfScalingDomain([{ t: NOW, v: 0.2 }])).toEqual({ min: 0, max: 2 });
		expect(selfScalingDomain([{ t: NOW, v: 4.1 }])).toEqual({ min: 0, max: 5 });
	});
});

describe("the right edge is wall-clock now", () => {
	it("pins a sample taken now to the right edge", () => {
		expect(projectX(NOW, NOW)).toBeCloseTo(TRACE_W, 5);
	});

	it("leaves a widening void as a feed goes silent", () => {
		const samples = ramp(3, 1_000, NOW - 30_000);
		const at = (now: number) =>
			buildLaneView(
				{ id: "temp", samples, domain: TEMP_DOMAIN, gapMs: TEMP_GAP_MS },
				now,
				DESKTOP_GEOMETRY,
				0,
			).lastX;
		const early = at(NOW);
		const later = at(NOW + 60_000);
		expect(early).not.toBeNull();
		expect(later).not.toBeNull();
		expect(later as number).toBeLessThan(early as number);
	});
});

describe("buildLaneView", () => {
	it("reports a gap between the two strokes it split", () => {
		const samples: TraceSample[] = [
			{ t: NOW - 200_000, v: 50 },
			{ t: NOW - 199_000, v: 51 },
			{ t: NOW - 20_000, v: 52 },
			{ t: NOW - 19_000, v: 53 },
		];
		const view = buildLaneView(
			{ id: "temp", samples, domain: TEMP_DOMAIN, gapMs: TEMP_GAP_MS },
			NOW,
			DESKTOP_GEOMETRY,
			0,
		);
		expect(view.segments).toHaveLength(2);
		expect(view.gaps).toHaveLength(1);
		expect(view.gaps[0]?.x1).toBeLessThan(view.gaps[0]?.x2 ?? 0);
	});

	it("an empty window yields no stats and no fabricated zero", () => {
		const view = buildLaneView(
			{ id: "load", samples: [], domain: "auto", gapMs: LOAD_GAP_MS },
			NOW,
			DESKTOP_GEOMETRY,
			1,
		);
		expect(view.stats).toBeNull();
		expect(view.latest).toBeNull();
		expect(view.lastX).toBeNull();
		expect(view.segments).toEqual([]);
	});

	it("a partial window starts mid-field — no left-edge padding", () => {
		const view = buildLaneView(
			{
				id: "temp",
				samples: ramp(3, 1_000, NOW),
				domain: TEMP_DOMAIN,
				gapMs: TEMP_GAP_MS,
			},
			NOW,
			DESKTOP_GEOMETRY,
			0,
		);
		const firstX = Number.parseFloat(
			(view.segments[0] as string).split(" ")[0]?.split(",")[0] ?? "0",
		);
		expect(firstX).toBeGreaterThan(TRACE_W * 0.9);
	});
});

describe("windowStats", () => {
	it("reports delta across the window", () => {
		const stats = windowStats([
			{ t: NOW - 2, v: 60 },
			{ t: NOW - 1, v: 65 },
			{ t: NOW, v: 63.1 },
		]);
		expect(stats?.min).toBe(60);
		expect(stats?.max).toBe(65);
		expect(stats?.delta).toBeCloseTo(3.1, 5);
	});

	it("is null for an empty window", () => {
		expect(windowStats([])).toBeNull();
	});
});

describe("geometry", () => {
	it("desktop is 132 units and compact is 104 — both keep TWO lanes", () => {
		expect(traceHeight(DESKTOP_GEOMETRY)).toBe(132);
		expect(traceHeight(COMPACT_GEOMETRY)).toBe(104);
		for (const g of [DESKTOP_GEOMETRY, COMPACT_GEOMETRY]) {
			expect(laneBox(g, 1).baselineY).toBeLessThan(rulerTop(g));
			expect(rulerTop(g) + g.rulerH).toBe(traceHeight(g));
		}
	});

	it("the compact ruler prints fewer numerals so the kiosk panel cannot collide", () => {
		expect(axisTicks(true)).toHaveLength(6);
		expect(axisTicks(false).map((t) => t.minutesAgo)).toEqual([5, 3, 1, 0]);
		expect(axisTicks(false).at(-1)?.x).toBeCloseTo(TRACE_W, 5);
	});
});

describe("createLaneViewCache", () => {
	const input = (samples: readonly TraceSample[]): LaneInput => ({
		id: "temp",
		samples,
		domain: TEMP_DOMAIN,
		gapMs: TEMP_GAP_MS,
	});

	it("is a hit for the same buffer inside the same tick", () => {
		const cache = createLaneViewCache();
		const samples = ramp(4, 1_000);
		cache.get(input(samples), NOW, DESKTOP_GEOMETRY, 0);
		cache.get(input(samples), NOW, DESKTOP_GEOMETRY, 0);
		expect(cache.computeCount).toBe(1);
	});

	it("misses on a genuinely new sample", () => {
		const cache = createLaneViewCache();
		const samples = ramp(4, 1_000);
		cache.get(input(samples), NOW, DESKTOP_GEOMETRY, 0);
		cache.get(input([...samples, { t: NOW, v: 99 }]), NOW, DESKTOP_GEOMETRY, 0);
		expect(cache.computeCount).toBe(2);
	});

	it("misses on a clock tick — the right edge IS part of the geometry", () => {
		const cache = createLaneViewCache();
		const samples = ramp(4, 1_000);
		cache.get(input(samples), NOW, DESKTOP_GEOMETRY, 0);
		cache.get(input(samples), NOW + 1_000, DESKTOP_GEOMETRY, 0);
		expect(cache.computeCount).toBe(2);
	});
});

describe("deriveLaneSignalStatus", () => {
	it("waits before anything has been delivered", () => {
		expect(deriveLaneSignalStatus(null, null, NOW, TEMP_STALE_MS).state).toBe(
			"waiting",
		);
	});

	it("is live on a fresh delivery carrying a value", () => {
		const status = deriveLaneSignalStatus(NOW - 500, 62.4, NOW, TEMP_STALE_MS);
		expect(status.state).toBe("live");
		expect(status.value).toBe(62.4);
	});

	it("distinguishes a fresh NULL delivery from an aged one", () => {
		expect(
			deriveLaneSignalStatus(NOW - 500, null, NOW, TEMP_STALE_MS).state,
		).toBe("unavailable");
		expect(
			deriveLaneSignalStatus(NOW - TEMP_STALE_MS, 62.4, NOW, TEMP_STALE_MS)
				.state,
		).toBe("aging");
	});

	it("retains the last known value through aging", () => {
		const status = deriveLaneSignalStatus(
			NOW - TEMP_STALE_MS - 1,
			62.4,
			NOW,
			TEMP_STALE_MS,
		);
		expect(status.state).toBe("aging");
		expect(status.value).toBe(62.4);
	});

	it("the load threshold does NOT flag every sample stale before its successor", () => {
		// device-stats broadcasts every 5 s; the global 5 s threshold would call a
		// 4.9 s-old sample stale in the instant before the next one lands.
		expect(
			deriveLaneSignalStatus(NOW - 4_900, 1.24, NOW, DEVICE_STATS_STALE_MS)
				.state,
		).toBe("live");
		expect(DEVICE_STATS_STALE_MS).toBeGreaterThan(TEMP_STALE_MS);
	});
});
