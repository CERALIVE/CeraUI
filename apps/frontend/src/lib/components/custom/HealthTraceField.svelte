<!--
  HealthTraceField.svelte — the strip-chart recorder.

  A ground-station pen recorder: two signals traced on ONE shared wall-clock time
  axis whose right edge is *now*. A feed that stops does not freeze — it visibly
  falls behind the playhead and leaves a widening void, so staleness is a
  geometric fact rather than a badge bolted onto a number.

  Hand-rolled SVG, matching `ingest-link-view.ts`'s conventions: fixed user-space
  `viewBox`, `preserveAspectRatio="none"`, `vector-effect="non-scaling-stroke"` on
  every stroke. No chart library.

  Why the text is HTML and not `<text>`
  -------------------------------------
  `preserveAspectRatio="none"` distorts x, which is exactly what makes a narrow
  paper roll read correctly — and exactly what would squash a printed label. The
  element's pixel height is set to the viewBox height, so **y maps 1:1** while
  only x stretches; labels are therefore positioned with `top: <y>px` and
  `left: <x/W>%` over the SVG, staying crisp and translatable.

  Motion — one mechanism, and it conveys state
  --------------------------------------------
  No entrance animation (the panel renders its current state instantly on open).
  The single GSAP tween is THE PAPER ADVANCING: a `repeat: -1`, `duration: 1`,
  `ease: 'none'` translateX on the trace group, from +SECOND_WIDTH to 0. It is
  transform-only (compositor-resident, holds frame rate on the SBC) and it says
  something true — time is passing and the feed is being watched. Without it the
  trace steps once per second, which reads as a broken refresh.

  Guards mirror `BondConstellation.svelte` exactly: `gsap.matchMedia` for
  reduced-motion, a `frozen` bail for the e-ink profile (the app.css freeze kills
  CSS animation but NOT GSAP's inline transforms), and `killTweensOf` BEFORE
  `ctx.revert()` (a `repeat: -1` tween survives revert alone and the next open
  would stack a second loop). In every static case the trace renders at its exact
  current geometry — the shape is the information; the scroll is only smoothing.

  A pen lift never eases in. A gap appears at full contrast, instantly, on the
  frame it is known: softening an absence is the visual form of the lie this
  panel exists to prevent.
-->
<script module lang="ts">
import type { LaneDomain, TraceSample } from './health-trace-view';

export interface RenderLane {
	id: string;
	/** Printed channel name, the way a recorder prints it on the paper. */
	label: string;
	samples: readonly TraceSample[];
	domain: LaneDomain | 'auto';
	gapMs: number;
	bucketMs?: number;
	autoMinCeiling?: number;
	/** Aging / no-reading — swaps this lane's stroke to the warning token. */
	degraded: boolean;
	/** Formats a domain-space value for the printed scale. */
	formatScale: (value: number) => string;
}
</script>

<script lang="ts">
import { gsap } from 'gsap';
import { CircleSlash } from '@lucide/svelte';

import { cn } from '$lib/utils';

import {
	axisTicks,
	COMPACT_GEOMETRY,
	createLaneViewCache,
	DESKTOP_GEOMETRY,
	rulerTop,
	SECOND_WIDTH,
	TRACE_W,
	traceHeight,
} from './health-trace-view';

interface Props {
	lanes: RenderLane[];
	/** Wall-clock now — the right edge. Advanced by the 1 s health clock. */
	now: number;
	/** Kiosk / narrow layout: shorter lanes, sparser ruler. Still two lanes. */
	compact?: boolean;
	/** E-ink / mono profile — freeze all motion. */
	frozen?: boolean;
	/** Accessible summary; the SVG's internal geometry is aria-hidden. */
	ariaLabel: string;
	/** Shown over an empty ruled grid before the first reading arrives. */
	waitingLabel: string;
	/** Tooltip on a pen-lift marker. */
	gapLabel: string;
	axisNowLabel: string;
	axisMinutesAgo: (minutes: number) => string;
	class?: string;
}

let {
	lanes,
	now,
	compact = false,
	frozen = false,
	ariaLabel,
	waitingLabel,
	gapLabel,
	axisNowLabel,
	axisMinutesAgo,
	class: className,
}: Props = $props();

const geometry = $derived(compact ? COMPACT_GEOMETRY : DESKTOP_GEOMETRY);
const height = $derived(traceHeight(geometry));
const ruleY = $derived(rulerTop(geometry));
const ticks = $derived(axisTicks(!compact));

const cache = createLaneViewCache();
const views = $derived(
	lanes.map((lane, index) => cache.get(lane, now, geometry, index)),
);
const hasAnyPoint = $derived(views.some((view) => view.pointCount > 0));

/** Percent-of-width for an x in user space — the overlay's positioning unit. */
function pct(x: number): string {
	return `${((x / TRACE_W) * 100).toFixed(3)}%`;
}

// GSAP owns this node's transform; deliberately NOT $state (Svelte must not
// re-touch it per tick).
let paperEl: SVGGElement | null = null;

let animated = $state(false);
let activeContext: gsap.MatchMedia | undefined;
let activeKey: string | undefined;

function teardownTimeline(): void {
	// Kill FIRST: `revert()` restores inline styles but does not stop an
	// infinitely-repeating tween, so without this the rAF loop survives teardown
	// and the next open stacks a second one.
	if (paperEl) gsap.killTweensOf(paperEl);
	activeContext?.revert();
	activeContext = undefined;
	animated = false;
}

function buildTimeline(isFrozen: boolean): void {
	const target = paperEl;
	if (!target) return;
	const mm = gsap.matchMedia();
	activeContext = mm;
	mm.add('(prefers-reduced-motion: no-preference)', () => {
		if (isFrozen) return;
		gsap.fromTo(
			target,
			{ x: SECOND_WIDTH },
			{ x: 0, duration: 1, ease: 'none', repeat: -1 },
		);
		animated = true;
	});
}

$effect(() => {
	const isFrozen = frozen;
	// Depend ONLY on the freeze flag: the point set is re-seeded every second
	// underneath a tween that must keep running, so a per-tick rebuild would
	// restart the scroll mid-flight.
	const key = `${isFrozen}`;
	if (key === activeKey) return;
	activeKey = key;
	teardownTimeline();
	buildTimeline(isFrozen);
});

$effect(() => () => teardownTimeline());
</script>

<div
	class={cn('bg-card relative w-full overflow-hidden rounded-lg border', className)}
	style="height: {height}px"
	data-testid="health-trace-field"
	data-animated={animated}
	data-compact={compact}
	data-points={views.reduce((sum, view) => sum + view.pointCount, 0)}
>
	<svg
		aria-hidden="true"
		class="absolute inset-0 h-full w-full"
		preserveAspectRatio="none"
		viewBox="0 0 {TRACE_W} {height}"
	>
		<!-- Lane baselines + the axis rule are the ruled paper: always drawn, even
		     with zero samples, so "no strip" is never confusable with "no data". -->
		{#each views as view (view.id)}
			<line
				stroke="var(--border)"
				stroke-width="1"
				vector-effect="non-scaling-stroke"
				x1="0"
				x2={TRACE_W}
				y1={view.baselineY}
				y2={view.baselineY}
			/>
		{/each}
		<line
			stroke="var(--border)"
			stroke-width="1"
			vector-effect="non-scaling-stroke"
			x1="0"
			x2={TRACE_W}
			y1={ruleY}
			y2={ruleY}
		/>

		<g bind:this={paperEl}>
			{#each views as view, laneIndex (view.id)}
				{@const stroke = lanes[laneIndex]?.degraded
					? 'var(--status-warning)'
					: 'var(--primary)'}
				{#each view.segments as points, segmentIndex (segmentIndex)}
					<polyline
						fill="none"
						{points}
						stroke={stroke}
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1.5"
						vector-effect="non-scaling-stroke"
					/>
				{/each}

				<!-- Pen lifts: a dotted hairline across the hole on the lane baseline. -->
				{#each view.gaps as gap, gapIndex (gapIndex)}
					<line
						opacity="0.4"
						stroke="var(--muted-foreground)"
						stroke-dasharray="2 3"
						stroke-width="1"
						vector-effect="non-scaling-stroke"
						x1={gap.x1}
						x2={gap.x2}
						y1={view.baselineY}
						y2={view.baselineY}
					/>
				{/each}
			{/each}
		</g>

		<!-- Playhead: x = TRACE_W IS wall-clock now. -->
		<line
			opacity="0.45"
			stroke="var(--primary)"
			stroke-width="1.5"
			vector-effect="non-scaling-stroke"
			x1={TRACE_W}
			x2={TRACE_W}
			y1="0"
			y2={ruleY}
		/>
	</svg>

	<!-- Printed channel names + disclosed scales. HTML so they neither stretch
	     with the x-distorted viewBox nor resist translation. -->
	{#each views as view, laneIndex (view.id)}
		{@const lane = lanes[laneIndex]}
		<span
			class="text-muted-foreground pointer-events-none absolute start-2 font-mono text-[10px] leading-none"
			style="top: {view.labelY - 8}px"
			data-testid="health-lane-label-{view.id}"
		>
			{lane?.label ?? view.id}
		</span>
		<span
			class="text-muted-foreground/70 pointer-events-none absolute end-2 font-mono text-[10px] leading-none tabular-nums"
			style="top: {view.labelY - 8}px"
			data-testid="health-lane-scale-{view.id}"
		>
			{lane?.formatScale(view.domain.min) ?? view.domain.min}–{lane?.formatScale(
				view.domain.max,
			) ?? view.domain.max}
		</span>
		{#each view.gaps as gap, gapIndex (gapIndex)}
			<span
				class="text-muted-foreground/50 pointer-events-none absolute -translate-x-1/2"
				style="left: {pct((gap.x1 + gap.x2) / 2)}; top: {view.baselineY + 1}px"
				data-testid="health-lane-gap-{view.id}"
				title={gapLabel}
				aria-hidden="true"
			>
				<CircleSlash class="size-2.5" />
			</span>
		{/each}
	{/each}

	<!-- Time axis. Deliberately LTR in every locale: mirroring it would put *now*
	     on the left while the mono numerals beside it still read left-to-right,
	     and would invert the "falls behind the playhead" language the design
	     rests on. SVG content is not auto-mirrored either. -->
	<div
		class="text-muted-foreground pointer-events-none absolute inset-x-0 bottom-0 font-mono text-[10px] leading-none tabular-nums"
		dir="ltr"
		style="height: {geometry.rulerH}px"
	>
		{#each ticks as tick, index (tick.minutesAgo)}
			<!-- The two edge numerals hug their edge instead of centring on it —
			     a centred tick at x=0 or x=W loses half its glyphs off-canvas. -->
			<span
				class={cn(
					'absolute top-1',
					tick.minutesAgo === 0 && 'text-primary/80 -translate-x-full pe-1',
					index === 0 && 'ps-1',
					index > 0 && tick.minutesAgo !== 0 && '-translate-x-1/2',
				)}
				style="left: {pct(tick.x)}"
			>
				{tick.minutesAgo === 0 ? axisNowLabel : axisMinutesAgo(tick.minutesAgo)}
			</span>
		{/each}
	</div>

	{#if !hasAnyPoint}
		<span
			class="text-muted-foreground absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-xs"
			data-testid="health-trace-waiting"
		>
			{waitingLabel}
		</span>
	{/if}

	<span class="sr-only" role="img" aria-label={ariaLabel}></span>
</div>
