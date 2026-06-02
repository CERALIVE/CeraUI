<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Modem } from '@ceraui/rpc/schemas';
import { Radio } from '@lucide/svelte';

import SpeedBadge from '$lib/components/custom/SpeedBadge.svelte';
import { formatThroughput } from '$lib/helpers/network-speed';
import type { LinkSignal } from '$lib/types/hud';
import { cn } from '$lib/utils';

interface Props {
	links: LinkSignal[];
	modemEntries: [string, Modem][];
}

const { links, modemEntries }: Props = $props();

/** signal % → 0..3 bars (null = no data → 0 bars). */
function signalBars(signal: number | null): number {
	if (signal == null) return 0;
	if (signal >= 66) return 3;
	if (signal >= 33) return 2;
	return 1;
}

/** A short type tag for a bonded link (WiFi, Ethernet, or the modem's network generation). */
function linkTypeLabel(link: LinkSignal): string {
	if (link.type === 'wifi') return $LL.network.view.wifi();
	if (link.type === 'ethernet') return $LL.network.view.ethernet();
	const modem = modemEntries.find(([, m]) => (m.ifname || '') === link.id)?.[1];
	return modem?.status?.network_type || $LL.network.view.cellular();
}

// Aggregate throughput across every enabled link — the bond's working bandwidth.
const totalKbps = $derived(
	links.reduce((sum, link) => (link.enabled ? sum + (link.throughputKbps ?? 0) : sum), 0),
);
</script>

<!-- ───────────── Bonded Links overview ───────────── -->
<section class="bg-card rounded-xl border p-4 sm:p-5" aria-label={$LL.network.view.bondedLinks()}>
	<div class="mb-3 flex items-center gap-2">
		<Radio aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{$LL.network.view.bondedLinks()}</h2>
	</div>

	{#if links.length === 0}
		<p class="text-muted-foreground text-sm">{$LL.network.view.noLinks()}</p>
	{:else}
		<div class="flex flex-wrap gap-2.5">
			{#each links as link (link.linkIndex)}
				{@const color = `var(--link-${link.linkIndex + 1})`}
				{@const bars = signalBars(link.signal)}
				{@const hasSignal = link.signal !== null}
				<div
					class={cn(
						'flex items-center gap-2.5 rounded-lg border px-3 py-2',
						link.isStale && 'opacity-60',
					)}
					style="border-color: color-mix(in oklab, {color} 35%, transparent); background-color: color-mix(in oklab, {color} 10%, transparent);"
				>
					<span
						class="text-xs font-bold tabular-nums"
						style="color: {color};">L{link.linkIndex + 1}</span
					>
					<!-- mini signal bars (match HUD aesthetic) — wired links report no signal -->
					{#if hasSignal}
						<div class="flex items-end gap-0.5" aria-hidden="true">
							{#each [1, 2, 3] as bar (bar)}
								<span
									class="w-1 rounded-[1px]"
									style="height: {bar * 3 + 2}px; background-color: {bar <= bars
										? color
										: 'var(--muted)'};"
								></span>
							{/each}
						</div>
					{/if}
					<div class="flex min-w-0 flex-col leading-tight">
						<span class="truncate text-xs font-medium">{link.label}</span>
						<span class="text-muted-foreground text-[10px] uppercase tracking-wide"
							>{linkTypeLabel(link)}</span
						>
					</div>
					{#if hasSignal}
						<span class="ms-1 font-mono text-xs tabular-nums" style="color: {color};">
							{link.signal}%
						</span>
					{/if}
					<!-- per-link throughput (Task 18) -->
					<SpeedBadge class="ms-1" kbps={link.throughputKbps} stale={link.isStale} />
				</div>
			{/each}
		</div>

		<!-- total bonded bandwidth (Task 18) -->
		<div
			class="mt-3 flex items-center justify-between border-t pt-3 text-xs"
		>
			<span class="text-muted-foreground uppercase tracking-wide"
				>{$LL.network.view.totalBandwidth()}</span
			>
			<span class="text-foreground font-mono text-sm font-bold tabular-nums">
				{formatThroughput(totalKbps)}
			</span>
		</div>
	{/if}
</section>
