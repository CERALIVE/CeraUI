<!--
  IngestStats.svelte — bonded-ingest telemetry panel for the Live destination.

  A compact per-link table surfacing the srtla_send ingest telemetry that already
  flows through `status.linkTelemetry` (see backend link-telemetry.ts): one row per
  bonded uplink with its interface, RTT, NAK count, and bond weight, plus a totals
  footer. No new backend collector — this is purely a read of the existing feed.

  On top of the live row, each link keeps a FIXED-SIZE in-memory ring buffer of its
  recent samples (RTT / NAK / weight, RING_CAPACITY deep). The buffer feeds:
    • a per-link RTT sparkline reflecting the recent trend, and
    • a simple link-health verdict (stable / degrading) plus a bond-level alert
      when latency is climbing on any uplink.
  The buffer is RAM-only — no persistence, no configurable window, no aggregation
  beyond the raw ring. Oldest samples are dropped once the ring is full.

  Three states mirror the feed:
    • populated — fresh values per link, totals summed, sparkline + health badge
    • stale     — a link's `stale` flag dims its row + earns a StaleBadge
    • waiting   — no links yet (feed null/empty): a calm "waiting" line, panel kept

  rtt_ms=0 and weight_percent=100 are valid sender constants, rendered as-is.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { LinkTelemetryEntry, LinkTelemetryMessage } from '@ceraui/rpc/schemas';
import { Activity, TrendingUp } from '@lucide/svelte';
import { untrack } from 'svelte';

import StaleBadge from '$lib/components/custom/StaleBadge.svelte';
import { cn } from '$lib/utils';

interface Props {
	telemetry: LinkTelemetryMessage | null | undefined;
	class?: string;
}

const { telemetry = undefined, class: className = undefined }: Props = $props();

const links = $derived<LinkTelemetryEntry[]>(telemetry?.links ?? []);
const hasLinks = $derived(links.length > 0);

// Bond-level rollups across every reported uplink.
const totalNak = $derived(links.reduce((sum, link) => sum + link.nak_count, 0));
const totalWeight = $derived(links.reduce((sum, link) => sum + link.weight_percent, 0));

// Shared 4-column track so header, rows, and totals stay aligned on any width.
const COLS = 'grid grid-cols-[minmax(0,1.4fr)_1fr_1fr_1fr] gap-x-3';

// ── Fixed-size history ring (RAM-only, per-link) ──────────────────────────────
// One bounded buffer per uplink (keyed by conn_id). When full, the oldest sample
// is dropped — never persisted, never resized at runtime, never aggregated beyond
// the raw ring.
const RING_CAPACITY = 60;
// Trend math compares the leading vs trailing window of the ring.
const TREND_WINDOW = 10;
const MIN_SAMPLES_FOR_TREND = TREND_WINDOW * 2;
// "Degrading" = trailing RTT average climbed past this multiple of the leading
// average. The floor keeps the rtt_ms=0 startup constant from tripping the alert.
const DEGRADE_FACTOR = 2;
const RTT_FLOOR_MS = 5;
// Sparkline drawing box (unitless SVG user space; the <svg> scales to its cell).
const SPARK_W = 100;
const SPARK_H = 24;

type Sample = { rtt: number; nak: number; weight: number };
type Trend = 'rising' | 'falling' | 'flat';

let history = $state<Record<string, Sample[]>>({});

// Append the current frame's per-link sample, dropping the oldest past capacity.
// Reads only `telemetry` (tracked); the ring write is untracked so it can never
// feed back into its own dependency set.
$effect(() => {
	const current = telemetry?.links ?? [];
	if (current.length === 0) return;
	untrack(() => {
		const next: Record<string, Sample[]> = { ...history };
		for (const link of current) {
			const prev = next[link.conn_id] ?? [];
			const buf = [
				...prev,
				{ rtt: link.rtt_ms, nak: link.nak_count, weight: link.weight_percent },
			];
			if (buf.length > RING_CAPACITY) buf.splice(0, buf.length - RING_CAPACITY);
			next[link.conn_id] = buf;
		}
		history = next;
	});
});

function avg(nums: number[]): number {
	return nums.length === 0 ? 0 : nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

// Build an SVG polyline from RTT values, normalised over the ring's own min/max so
// the trace fills the box regardless of absolute latency. A higher RTT draws higher.
function sparkPoints(values: number[]): string {
	if (values.length === 0) return '';
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
		.join(' ');
}

function trendOf(samples: Sample[]): Trend {
	if (samples.length < 4) return 'flat';
	const w = Math.min(TREND_WINDOW, Math.floor(samples.length / 2));
	const lead = avg(samples.slice(0, w).map((s) => s.rtt));
	const trail = avg(samples.slice(-w).map((s) => s.rtt));
	const delta = trail - lead;
	const threshold = Math.max(2, lead * 0.1);
	if (delta > threshold) return 'rising';
	if (delta < -threshold) return 'falling';
	return 'flat';
}

// Degradation: trailing RTT average more than DEGRADE_FACTOR× the leading average,
// with a floor so a link still settling from rtt_ms=0 doesn't false-alarm.
function isDegraded(samples: Sample[]): boolean {
	if (samples.length < MIN_SAMPLES_FOR_TREND) return false;
	const lead = avg(samples.slice(0, TREND_WINDOW).map((s) => s.rtt));
	const trail = avg(samples.slice(-TREND_WINDOW).map((s) => s.rtt));
	if (trail < RTT_FLOOR_MS) return false;
	return trail > DEGRADE_FACTOR * Math.max(lead, RTT_FLOOR_MS / DEGRADE_FACTOR);
}

// 100 = stable; drops ~50 pts per doubling of trailing RTT, clamped to [0,100].
function healthScore(samples: Sample[]): number {
	if (samples.length < MIN_SAMPLES_FOR_TREND) return 100;
	const lead = avg(samples.slice(0, TREND_WINDOW).map((s) => s.rtt));
	const trail = avg(samples.slice(-TREND_WINDOW).map((s) => s.rtt));
	const ratio = trail / Math.max(lead, RTT_FLOOR_MS);
	return Math.round(Math.max(0, Math.min(100, 100 - (ratio - 1) * 50)));
}

type LinkView = {
	link: LinkTelemetryEntry;
	count: number;
	points: string;
	trend: Trend;
	degraded: boolean;
	score: number;
};

const linkViews = $derived<LinkView[]>(
	links.map((link) => {
		const samples = history[link.conn_id] ?? [];
		return {
			link,
			count: samples.length,
			points: sparkPoints(samples.map((s) => s.rtt)),
			trend: trendOf(samples),
			degraded: isDegraded(samples),
			score: healthScore(samples),
		};
	}),
);

const anyDegraded = $derived(linkViews.some((v) => v.degraded));
</script>

<section
	data-testid="ingest-stats"
	class={cn('bg-card rounded-xl border p-4 sm:p-5', className)}
	aria-label={$LL.live.ingest.ariaLabel()}
>
	<div class="mb-3 flex items-center gap-2">
		<Activity aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{$LL.live.ingest.title()}</h2>
		{#if hasLinks}
			<span class="text-muted-foreground ms-auto font-mono text-xs tabular-nums">
				{links.length}&nbsp;{$LL.live.ingest.links()}
			</span>
		{/if}
	</div>

	{#if anyDegraded}
		<!-- Bond-level degradation alert — raised when any link's RTT trend climbs. -->
		<div
			role="alert"
			data-testid="ingest-alert"
			class="bg-status-warning/10 text-status-warning mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium"
		>
			<TrendingUp aria-hidden="true" class="size-4 shrink-0" />
			<span>{$LL.live.ingest.alert()}</span>
		</div>
	{/if}

	{#if !hasLinks}
		<p class="text-muted-foreground text-sm" data-testid="ingest-waiting">
			{$LL.live.ingest.waiting()}
		</p>
	{:else}
		<!-- column header -->
		<div
			class={cn(
				COLS,
				'text-muted-foreground border-b pb-1.5 text-[10px] uppercase tracking-wide',
			)}
		>
			<span>{$LL.live.ingest.link()}</span>
			<span class="text-end">{$LL.live.ingest.rtt()}</span>
			<span class="text-end">{$LL.live.ingest.nak()}</span>
			<span class="text-end">{$LL.live.ingest.weight()}</span>
		</div>

		<!-- per-link rows -->
		<div role="list">
			{#each linkViews as view (view.link.conn_id)}
				{@const link = view.link}
				<div
					role="listitem"
					data-testid="ingest-row"
					data-iface={link.iface}
					data-stale={link.stale ? 'true' : 'false'}
					data-health={view.degraded ? 'degraded' : 'healthy'}
					class={cn(
						'border-b py-1.5 transition-opacity last:border-b-0',
						link.stale && 'opacity-50',
					)}
				>
					<div class={cn(COLS, 'items-center text-xs')}>
						<div class="flex min-w-0 items-center gap-1.5">
							<span class="truncate font-medium">{link.iface}</span>
							{#if link.stale}
								<StaleBadge data-stale-interface={link.iface} />
							{/if}
						</div>
						<span data-testid="ingest-rtt" class="text-foreground text-end font-mono tabular-nums">
							{`${link.rtt_ms} ${$LL.units.ms()}`}
						</span>
						<span data-testid="ingest-nak" class="text-foreground text-end font-mono tabular-nums">
							{link.nak_count}
						</span>
						<span data-testid="ingest-weight" class="text-foreground text-end font-mono tabular-nums">
							{link.weight_percent}%
						</span>
					</div>

					<!-- recent-trend strip: RTT sparkline + per-link health verdict -->
					<div class="mt-1.5 flex items-center gap-2">
						<svg
							data-testid="ingest-sparkline"
							data-iface={link.iface}
							data-samples={view.count}
							data-trend={view.trend}
							viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
							preserveAspectRatio="none"
							class={cn(
								'h-5 min-w-0 flex-1',
								view.degraded ? 'text-status-warning' : 'text-primary',
							)}
							role="img"
							aria-label={$LL.live.ingest.trendLabel({ iface: link.iface })}
						>
							{#if view.points}
								<polyline
									points={view.points}
									fill="none"
									stroke="currentColor"
									stroke-width="1.5"
									stroke-linejoin="round"
									stroke-linecap="round"
									vector-effect="non-scaling-stroke"
								/>
							{/if}
						</svg>
						<span
							data-testid="ingest-health"
							data-iface={link.iface}
							data-status={view.degraded ? 'degraded' : 'healthy'}
							data-score={view.score}
							class={cn(
								'shrink-0 font-mono text-[10px] uppercase tracking-wide tabular-nums',
								view.degraded ? 'text-status-warning' : 'text-muted-foreground',
							)}
						>
							{view.degraded ? $LL.live.ingest.degraded() : $LL.live.ingest.healthy()}
						</span>
					</div>
				</div>
			{/each}
		</div>

		<!-- bond totals -->
		<div class={cn(COLS, 'items-center pt-2 text-xs')}>
			<span class="text-muted-foreground uppercase tracking-wide">{$LL.live.ingest.total()}</span>
			<span aria-hidden="true" class="text-end">&nbsp;</span>
			<span
				data-testid="ingest-total-nak"
				class="text-foreground text-end font-mono font-bold tabular-nums"
			>
				{totalNak}
			</span>
			<span
				data-testid="ingest-total-weight"
				class="text-foreground text-end font-mono font-bold tabular-nums"
			>
				{totalWeight}%
			</span>
		</div>
	{/if}
</section>
