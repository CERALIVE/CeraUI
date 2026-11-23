<script lang="ts">
/**
 * LiveGlance — the stream at a glance, for phones (below 1024 px).
 *
 * A streamer checks the phone between moments: is it sending, how much, and
 * is every link carrying. This card answers that in one look: the headline
 * bitrate (measured, or the target while nothing is measured yet), one
 * verdict, and one bar per link with its share of the bond. Round-trip times,
 * retransmits, link weights as numbers, trend lines and the encoder load stay
 * in the Details section below it. From 1024 px the screen keeps its two
 * columns and this card is not shown.
 *
 * Presentational: every value is a prop, nothing is derived from a store.
 */
import { m } from '@ceraui/i18n/svelte';
import type { IngestLink } from '$lib/components/custom/ingest-link-view';

import { formatBitrate } from './bitrate-display';
import CompactRate from './CompactRate.svelte';

interface Props {
	bitrateKbps?: number | undefined;
	bitrateMeasured?: boolean;
	rows: IngestLink[];
	feed: 'disconnected' | 'waiting' | 'unavailable' | 'stale' | 'fresh';
}

const { bitrateKbps, bitrateMeasured = false, rows, feed }: Props = $props();

const sending = $derived(feed === 'fresh' && rows.length > 0 &&
	rows.every(({ link }) => (link.bitrate_bps ?? 0) > 0));
const verdict = $derived.by(() => {
	switch (feed) {
		case 'disconnected': return m["live.glance.disconnected"]();
		case 'waiting': return m["live.ingest.waiting"]();
		case 'unavailable': return m["live.glance.unavailable"]();
		case 'stale': return m["live.glance.linkDown"]();
		case 'fresh':
			if (rows.length === 0) return m["live.glance.empty"]();
			if (sending) return rows.length === 1 ? m["live.glance.linkSending"]() : m["live.glance.allSending"]();
			if (rows.some(({ link }) => link.bitrate_bps === 0)) return m["live.glance.linkIdle"]();
			return m["live.glance.down"]();
	}
});
const total = $derived(rows.reduce((sum, { link }) => sum + (link.bitrate_bps ?? 0), 0));
</script>

<section
	aria-labelledby="live-glance-title"
	class="bg-card space-y-3 rounded-xl border px-4 py-3 lg:hidden"
	data-live-glance
>
	<h2 class="sr-only" id="live-glance-title">{m["live.glance.title"]()}</h2>
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0">
			<p class="text-muted-foreground text-xs font-medium">
				{bitrateMeasured ? m["hud.bitrateSending"]() : m["hud.bitrateTarget"]()}
			</p>
			<p class="font-mono text-2xl font-semibold" style="color: var(--status-live);">
				<CompactRate kbps={bitrateKbps} />
			</p>
		</div>
		<p
			class="mt-1 inline-flex min-w-0 items-baseline gap-1.5 text-sm font-medium"
			role="status"
		>
			<span
				aria-hidden={true}
				class="size-2 shrink-0 rounded-full"
				style:background={sending ? 'var(--status-success)' : 'var(--muted-foreground)'}
			></span>
			{verdict}
		</p>
	</div>

	{#if rows.length > 0}
		<!-- biome-ignore lint/a11y/noRedundantRoles: Safari drops the list role once Tailwind removes the markers. -->
		<ul class="space-y-2" role="list">
			{#each rows as { link, key, label, color, identity } (key)}
				{const rate = $derived(feed === 'fresh' ? link.bitrate_bps : undefined)}
				<li class="space-y-1">
					<div class="flex items-baseline justify-between gap-3 text-sm">
						<span class="min-w-0 break-words font-medium">
							{label}
							{#if identity}
								<small class="text-muted-foreground block">{identity}</small>
							{/if}
						</span>
						<span class="text-muted-foreground shrink-0 font-mono text-xs tabular-nums" dir="ltr">
							{formatBitrate(rate === undefined ? undefined : rate / 1000)}
						</span>
					</div>
					<div aria-hidden={true} class="bg-muted h-1.5 overflow-hidden rounded-full">
						{#if rate && total > 0}
							<div
								class="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
								data-testid="live-traffic-fill"
								style:width={`${(100 * rate) / total}%`}
								style:background-color={color}
							></div>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	@media (orientation: landscape) and (max-height: 420px) and (width < 1024px) {
		section { padding-block: 0.5rem; }
		section > :not(:last-child) { margin-block-end: 0.375rem; }
		ul { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem 1rem; }
		li { margin-block: 0; }
	}
</style>
