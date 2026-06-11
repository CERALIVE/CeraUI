<!--
  IngestStats.svelte — bonded-ingest telemetry panel for the Live destination.

  A compact per-link table surfacing the srtla_send ingest telemetry that already
  flows through `status.linkTelemetry` (see backend link-telemetry.ts): one row per
  bonded uplink with its interface, RTT, NAK count, and bond weight, plus a totals
  footer. No new backend collector — this is purely a read of the existing feed.

  Three states mirror the feed:
    • populated — fresh values per link, totals summed
    • stale     — a link's `stale` flag dims its row + earns a StaleBadge
    • waiting   — no links yet (feed null/empty): a calm "waiting" line, panel kept

  rtt_ms=0 and weight_percent=100 are valid sender constants, rendered as-is.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { LinkTelemetryEntry, LinkTelemetryMessage } from '@ceraui/rpc/schemas';
import { Activity } from '@lucide/svelte';

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
			{#each links as link (link.conn_id)}
				<div
					role="listitem"
					data-testid="ingest-row"
					data-iface={link.iface}
					data-stale={link.stale ? 'true' : 'false'}
					class={cn(
						COLS,
						'items-center border-b py-1.5 text-xs transition-opacity last:border-b-0',
						link.stale && 'opacity-50',
					)}
				>
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
