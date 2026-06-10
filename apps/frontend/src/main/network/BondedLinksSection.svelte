<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { LinkTelemetryEntry, LinkTelemetryMessage, Modem } from '@ceraui/rpc/schemas';
import { Radio } from '@lucide/svelte';

import LinkIndicator from '$lib/components/custom/LinkIndicator.svelte';
import LinkTelemetry from '$lib/components/custom/LinkTelemetry.svelte';
import SpeedBadge from '$lib/components/custom/SpeedBadge.svelte';
import { formatThroughput } from '$lib/helpers/network-speed';
import { getStalenessState } from '$lib/helpers/staleness';
import type { LinkSignal } from '$lib/types/hud';
import { cn } from '$lib/utils';

interface Props {
	links: LinkSignal[];
	modemEntries: [string, Modem][];
	linkTelemetry?: LinkTelemetryMessage | null;
}

const { links, modemEntries, linkTelemetry = undefined }: Props = $props();

// Index telemetry rows by their resolved interface name so each card can join
// its own values. `link.id` is the kernel ifname, which the backend resolves
// `conn_id` -> `iface` to (link-telemetry.ts). No match -> "--" placeholders.
const telemetryByIface = $derived(
	new Map<string, LinkTelemetryEntry>(
		(linkTelemetry?.links ?? []).map((entry) => [entry.iface, entry]),
	),
);

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

// The bond total is only as fresh as its links: when every link has aged out
// (i.e. on a full disconnect, where `isFullyStale` is baked into each
// `link.isStale`), the aggregate is stale too. Route through the shared helper
// so the dimming threshold matches every other live value (Task 18).
const totalStale = $derived(
	getStalenessState(totalKbps, null, links.length > 0 && links.every((link) => link.isStale)) ===
		'stale',
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
				{@const hasSignal = link.signal !== null}
				<div
					data-testid="bonded-link-card"
					data-link-id={link.id}
					class={cn(
						'flex min-w-[12rem] flex-1 flex-col gap-2 rounded-lg border px-3 py-2',
						link.isStale && 'opacity-50',
					)}
					style="border-color: color-mix(in oklab, {color} 35%, transparent); background-color: color-mix(in oklab, {color} 10%, transparent);"
				>
					<div class="flex items-center gap-2.5">
						<span
							class="text-xs font-bold tabular-nums"
							style="color: {color};">L{link.linkIndex + 1}</span
						>
						<LinkIndicator
							shape="bars"
							size="md"
							type={link.type}
							signal={link.signal}
							connectionState={link.connectionState}
							linkIndex={link.linkIndex}
						/>
						<div class="flex min-w-0 flex-col leading-tight">
							<span class="truncate text-xs font-medium">{link.label}</span>
							<span class="text-muted-foreground text-[10px] uppercase tracking-wide"
								>{linkTypeLabel(link)}</span
							>
						</div>
						{#if hasSignal}
							<span data-live-value class="ms-1 font-mono text-xs tabular-nums" style="color: {color};">
								{link.signal}%
							</span>
						{:else if link.type === 'modem' && link.connectionState === 'no_sim'}
							<span class="text-muted-foreground ms-1 text-[10px] uppercase tracking-wide">
								{$LL.network.view.noSimLink()}
							</span>
						{:else if link.type === 'modem' && link.connectionState === 'scanning'}
							<span class="text-muted-foreground ms-1 text-[10px] uppercase tracking-wide">
								{$LL.network.modem.scanning()}
							</span>
						{/if}
						<!-- per-link throughput (Task 18) -->
						<SpeedBadge class="ms-1" kbps={link.throughputKbps} stale={link.isStale} />
					</div>

					<!-- per-link srtla telemetry: RTT / NAK / weight (Task 22) -->
					<div
						class="border-t pt-2"
						style="border-color: color-mix(in oklab, {color} 20%, transparent);"
					>
						<LinkTelemetry entry={telemetryByIface.get(link.id)} />
					</div>
				</div>
			{/each}
		</div>

		<!-- total bonded bandwidth (Task 18) — dims with its links when stale -->
		<div
			class={cn(
				'mt-3 flex items-center justify-between border-t pt-3 text-xs transition-opacity',
				totalStale && 'opacity-50',
			)}
		>
			<span class="text-muted-foreground uppercase tracking-wide"
				>{$LL.network.view.totalBandwidth()}</span
			>
			<span data-live-value class="text-foreground font-mono text-sm font-bold tabular-nums">
				{formatThroughput(totalKbps)}
			</span>
		</div>
	{/if}
</section>
