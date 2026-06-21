<!--
  IngestStats.svelte — bonded-ingest telemetry panel for the Live destination.

  A compact per-link table surfacing the srtla_send ingest telemetry that already
  flows through `status.linkTelemetry` (see backend link-telemetry.ts): one row per
  bonded uplink with its interface, RTT, NAK count, and bond weight, plus a totals
  footer. No new backend collector — this is purely a read of the existing feed.

  Three states mirror the feed:
    • populated — fresh values per link, totals summed
    • stale     — a link's `stale` flag dims its row + earns a stale Badge
    • waiting   — no links yet (feed null/empty): a calm "waiting" line, panel kept

  rtt_ms=0 and weight_percent=100 are valid sender constants, rendered as-is.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { LinkTelemetryEntry, LinkTelemetryMessage } from '@ceraui/rpc/schemas';
import { Activity, AlertTriangle, Download, TrendingUp } from '@lucide/svelte';
import { untrack } from 'svelte';

import Badge from '$lib/components/custom/Badge.svelte';
import {
	createLinkViewCache,
	type LinkViewComputed,
	RING_CAPACITY,
	type Sample,
	SPARK_H,
	SPARK_W,
} from '$lib/components/custom/ingest-link-view';
import { Button } from '$lib/components/ui/button';
import {
	computeSessionRollup,
	createSample,
	rollupToCsv,
	rollupToJson,
	type SessionRollup,
	type SessionSample,
} from '$lib/streaming/session-rollup';
import { cn } from '$lib/utils';

interface Props {
	telemetry: LinkTelemetryMessage | null | undefined;
	isStreaming?: boolean | undefined;
	bitrateKbps?: number | undefined;
	class?: string;
}

const {
	telemetry = undefined,
	isStreaming = undefined,
	bitrateKbps = undefined,
	class: className = undefined,
}: Props = $props();

const links = $derived<LinkTelemetryEntry[]>(telemetry?.links ?? []);
const hasLinks = $derived(links.length > 0);

// Bond-level rollups across every reported uplink.
const totalNak = $derived(links.reduce((sum, link) => sum + link.nak_count, 0));
const totalWeight = $derived(links.reduce((sum, link) => sum + link.weight_percent, 0));

// Shared 4-column track so header, rows, and totals stay aligned on any width.
const COLS = 'grid grid-cols-[minmax(0,1.4fr)_1fr_1fr_1fr] gap-x-3';

// Per-link RTT-trend derivation — constants, math, and the memoizing cache — lives
// in `ingest-link-view.ts` (pure + unit-testable). RING_CAPACITY bounds the ring
// appended below; SPARK_W/SPARK_H size the SVG viewBox in the template.
const viewCache = createLinkViewCache();
// Stable empty buffer so a link still awaiting its first frame stays a memo hit.
const EMPTY_SAMPLES: readonly Sample[] = [];

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

type LinkView = LinkViewComputed & { link: LinkTelemetryEntry };

// Memoized per conn_id: a link whose samples buffer is reference-unchanged since
// the last derivation reuses its cached view (path string + trend + health) rather
// than rebuilding the SVG path. The ring effect only swaps a link's array when it
// appends a sample, so the audit's per-tick redraw cost is now paid only on a
// genuinely new sample for that link — not on every component re-render.
const linkViews = $derived<LinkView[]>(
	links.map((link) => ({
		link,
		...viewCache.get(link.conn_id, history[link.conn_id] ?? EMPTY_SAMPLES),
	})),
);

const anyDegraded = $derived(linkViews.some((v) => v.degraded));

// ── Per-session rollup (device-local) ──────────────────────────────────────
// Samples accumulate in a plain (non-reactive) array so the sampling effect never
// re-triggers itself; only the finalized rollup is reactive state. On stream stop
// the samples fold into a summary; nothing here transmits (see session-rollup.ts).
let sessionSamples: SessionSample[] = [];
let wasStreaming = false;
let rollup = $state<SessionRollup | null>(null);

$effect(() => {
	const streaming = isStreaming === true;
	// Touch the live feed + bitrate so the effect re-runs on each telemetry tick.
	const frameLinks = telemetry?.links;
	const br = bitrateKbps;

	if (streaming && !wasStreaming) {
		sessionSamples = [];
		rollup = null;
	}
	if (streaming) {
		sessionSamples.push(createSample(br, frameLinks));
	}
	if (!streaming && wasStreaming) {
		rollup = sessionSamples.length > 0 ? computeSessionRollup(sessionSamples) : null;
	}
	wasStreaming = streaming;
});

// The completed-session summary wins over a lingering stale telemetry frame once
// the stream has stopped; while streaming, rollup is null so the live table shows.
const showSummary = $derived(rollup !== null && isStreaming !== true);

function formatBitrate(kbps: number): string {
	if (kbps >= 1000) {
		const mbps = kbps / 1000;
		const value = Number.isInteger(mbps) ? String(mbps) : mbps.toFixed(1);
		return `${value} ${$LL.units.mbps()}`;
	}
	return `${kbps} ${$LL.units.kbps()}`;
}

// Surfaced inline when a device-local export fails (e.g. Blob/object-URL
// creation throws under storage pressure). Calm, recoverable, never thrown.
let exportError = $state(false);

// Guarded client-side download: any failure in Blob/object-URL/anchor flips the
// inline error state instead of throwing, and the object URL is always revoked
// in `finally` so a partial success never leaks it.
function triggerDownload(filename: string, mime: string, content: string): void {
	if (typeof document === 'undefined') return;
	let url: string | undefined;
	try {
		const blob = new Blob([content], { type: mime });
		url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		anchor.rel = 'noopener';
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		exportError = false;
	} catch {
		exportError = true;
	} finally {
		if (url !== undefined) URL.revokeObjectURL(url);
	}
}

function exportJson(): void {
	if (rollup) triggerDownload('ingest-session.json', 'application/json', rollupToJson(rollup));
}

function exportCsv(): void {
	if (rollup) triggerDownload('ingest-session.csv', 'text/csv', rollupToCsv(rollup));
}
</script>

<section
	data-testid="ingest-stats"
	class={cn('bg-card rounded-xl border p-4 sm:p-5', className)}
	aria-label={$LL.live.ingest.ariaLabel()}
>
	<div class="mb-4 flex items-center gap-2.5">
		<span
			aria-hidden="true"
			class="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-lg"
		>
			<Activity class="size-4" />
		</span>
		<h2 class="text-sm font-semibold tracking-tight">
			{showSummary ? $LL.live.ingest.summary() : $LL.live.ingest.title()}
		</h2>
		{#if showSummary && rollup}
			<span
				class="bg-secondary/60 text-muted-foreground ms-auto rounded-full px-2 py-0.5 font-mono text-xs tabular-nums"
			>
				{rollup.sampleCount}&nbsp;{$LL.live.ingest.samples()}
			</span>
		{:else if hasLinks}
			<span
				class="bg-secondary/60 text-muted-foreground ms-auto rounded-full px-2 py-0.5 font-mono text-xs tabular-nums"
			>
				{links.length}&nbsp;{$LL.live.ingest.links()}
			</span>
		{/if}
	</div>

	{#if anyDegraded}
		<!-- Bond-level degradation alert — calm amber band, bordered for definition. -->
		<div
			role="alert"
			data-testid="ingest-alert"
			class="border-status-warning/30 bg-status-warning/10 text-status-warning mb-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium"
		>
			<TrendingUp aria-hidden="true" class="size-4 shrink-0" />
			<span>{$LL.live.ingest.alert()}</span>
		</div>
	{/if}

	{#if showSummary && rollup}
		<!-- Per-session summary: peak/avg bitrate, drops, then per-link uptime. -->
		<div data-testid="ingest-summary">
			<div class="grid grid-cols-3 gap-3">
				<div class="bg-secondary/40 flex flex-col gap-1.5 rounded-lg p-3">
					<div
						class="text-muted-foreground flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide"
					>
						<TrendingUp aria-hidden="true" class="size-3 shrink-0" />
						<span class="truncate">{$LL.live.ingest.peak()}</span>
					</div>
					<div
						data-testid="ingest-summary-peak"
						class="text-foreground font-mono text-sm font-semibold tabular-nums"
					>
						{formatBitrate(rollup.peakBitrateKbps)}
					</div>
				</div>
				<div class="bg-secondary/40 flex flex-col gap-1.5 rounded-lg p-3">
					<div
						class="text-muted-foreground flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide"
					>
						<Activity aria-hidden="true" class="size-3 shrink-0" />
						<span class="truncate">{$LL.live.ingest.avg()}</span>
					</div>
					<div
						data-testid="ingest-summary-avg"
						class="text-foreground font-mono text-sm font-semibold tabular-nums"
					>
						{formatBitrate(rollup.avgBitrateKbps)}
					</div>
				</div>
				<div class="bg-secondary/40 flex flex-col gap-1.5 rounded-lg p-3">
					<div
						class="text-muted-foreground flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide"
					>
						<AlertTriangle aria-hidden="true" class="size-3 shrink-0" />
						<span class="truncate">{$LL.live.ingest.drops()}</span>
					</div>
					<!-- Informational, not actionable: a passive drop tally uses the
					     info token; amber is reserved for the actionable alert. -->
					<div
						data-testid="ingest-summary-drops"
						class={cn(
							'font-mono text-sm font-semibold tabular-nums',
							rollup.dropCount > 0 ? 'text-status-info' : 'text-foreground',
						)}
					>
						{rollup.dropCount}
					</div>
				</div>
			</div>

			{#if rollup.links.length > 0}
				<div
					class={cn(
						'text-muted-foreground mt-4 mb-1.5 flex items-center gap-3 border-b pb-1.5',
						'text-[10px] font-medium uppercase tracking-wide',
					)}
				>
					<span class="w-20 shrink-0">{$LL.live.ingest.link()}</span>
					<span class="flex-1">{$LL.live.ingest.uptime()}</span>
					<span class="w-10 text-end">%</span>
				</div>
				<div role="list">
					{#each rollup.links as link (link.iface)}
						<div
							role="listitem"
							data-testid="ingest-uptime-row"
							data-iface={link.iface}
							class="flex items-center gap-3 border-b py-2 text-xs last:border-b-0"
						>
							<span class="w-20 shrink-0 truncate font-medium">{link.iface}</span>
							<div
								aria-hidden="true"
								class="bg-secondary/60 relative h-1.5 flex-1 overflow-hidden rounded-full"
							>
								<div
									class="bg-primary h-full rounded-full"
									style={`width:${link.uptimePercent}%`}
								></div>
							</div>
							<span
								data-testid="ingest-uptime"
								class="text-foreground w-10 text-end font-mono tabular-nums"
							>
								{link.uptimePercent}%
							</span>
						</div>
					{/each}
				</div>
			{/if}

			<div
				class="mt-4 flex flex-wrap gap-2 border-t pt-4"
				aria-label={$LL.live.ingest.exportAria()}
			>
				<Button
					data-testid="ingest-export-json"
					variant="outline"
					size="sm"
					class="flex-1 gap-1.5 sm:flex-none"
					onclick={exportJson}
				>
					<Download aria-hidden="true" class="size-3.5" />
					{$LL.live.ingest.exportJson()}
				</Button>
				<Button
					data-testid="ingest-export-csv"
					variant="outline"
					size="sm"
					class="flex-1 gap-1.5 sm:flex-none"
					onclick={exportCsv}
				>
					<Download aria-hidden="true" class="size-3.5" />
					{$LL.live.ingest.exportCsv()}
				</Button>
			</div>

			{#if exportError}
				<!-- Calm, recoverable export-failure notice; the panel stays interactive. -->
				<p
					role="alert"
					data-testid="ingest-export-error"
					class="border-status-warning/30 bg-status-warning/10 text-status-warning mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
				>
					<AlertTriangle aria-hidden="true" class="size-4 shrink-0" />
					<span>{$LL.live.ingest.exportError()}</span>
				</p>
			{/if}
		</div>
	{:else if !hasLinks}
		<div class="text-muted-foreground flex items-center gap-2 py-2 text-sm" data-testid="ingest-waiting">
			<Activity aria-hidden="true" class="size-4 shrink-0 opacity-60" />
			<span>{$LL.live.ingest.waiting()}</span>
		</div>
	{:else}
		<!-- column header (ps-4 aligns "Link" past the per-link signal dot) -->
		<div
			class={cn(
				COLS,
				'text-muted-foreground border-b pb-1.5 text-[10px] font-medium uppercase tracking-wide',
			)}
		>
			<span class="ps-4">{$LL.live.ingest.link()}</span>
			<span class="text-end">{$LL.live.ingest.rtt()}</span>
			<span class="text-end">{$LL.live.ingest.nak()}</span>
			<span class="text-end">{$LL.live.ingest.weight()}</span>
		</div>

		<!-- per-link rows -->
		<div role="list">
			{#each linkViews as view, i (view.link.conn_id)}
				{@const link = view.link}
				<div
					role="listitem"
					data-testid="ingest-row"
					data-iface={link.iface}
					data-stale={link.stale ? 'true' : 'false'}
					data-health={view.degraded ? 'degraded' : 'healthy'}
					class={cn(
						'border-b py-2 transition-opacity last:border-b-0',
						link.stale && 'opacity-50',
					)}
				>
					<div class={cn(COLS, 'items-center text-xs')}>
						<div class="flex min-w-0 items-center gap-2">
							<!-- Spectral per-link identity dot (--link-1..6 ramp). -->
							<span
								aria-hidden="true"
								class="size-2 shrink-0 rounded-full"
								style={`background-color: var(--link-${(i % 6) + 1})`}
							></span>
							<span class="truncate font-medium">{link.iface}</span>
							{#if link.stale}
								<Badge variant="stale" data-stale-interface={link.iface} />
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

					<!-- recent-trend strip: labelled RTT sparkline + per-link health pill -->
					<div class="mt-2 flex items-center gap-2">
						<span
							class="text-muted-foreground shrink-0 text-[10px] font-medium uppercase tracking-wide"
						>
							{$LL.live.ingest.trend()}
						</span>
						<svg
							data-testid="ingest-sparkline"
							data-iface={link.iface}
							data-samples={view.count}
							data-trend={view.trend}
							viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
							preserveAspectRatio="none"
							class={cn(
								'h-6 min-w-0 flex-1',
								view.degraded ? 'text-status-warning' : 'text-primary',
							)}
							role="img"
							aria-label={$LL.live.ingest.trendLabel({ iface: link.iface })}
						>
							<!-- Baseline track so a short/empty trace still reads as calibrated. -->
							<line
								x1="0"
								y1={SPARK_H - 0.75}
								x2={SPARK_W}
								y2={SPARK_H - 0.75}
								stroke="currentColor"
								stroke-width="1"
								vector-effect="non-scaling-stroke"
								class="text-muted-foreground/25"
							/>
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
								'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5',
								'font-mono text-[10px] uppercase tracking-wide tabular-nums',
								view.degraded
									? 'bg-status-warning/10 text-status-warning'
									: 'bg-secondary/60 text-muted-foreground',
							)}
						>
							<span
								aria-hidden="true"
								class={cn(
									'size-1.5 rounded-full',
									view.degraded ? 'bg-status-warning' : 'bg-primary',
								)}
							></span>
							{view.degraded ? $LL.live.ingest.degraded() : $LL.live.ingest.healthy()}
						</span>
					</div>
				</div>
			{/each}
		</div>

		<!-- bond totals -->
		<div class={cn(COLS, 'items-center pt-3 text-xs')}>
			<span class="text-muted-foreground ps-4 uppercase tracking-wide"
				>{$LL.live.ingest.total()}</span
			>
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
