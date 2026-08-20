<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { LinkTelemetryEntry, LinkTelemetryMessage, Modem } from '@ceraui/rpc/schemas';
import { Radio } from '@lucide/svelte';

import LinkIndicator from '$lib/components/custom/LinkIndicator.svelte';
import LinkTelemetry from '$lib/components/custom/LinkTelemetry.svelte';
import Badge from '$lib/components/custom/Badge.svelte';
import { aggregateBondBandwidth, linkUpKbps } from '$lib/helpers/bond-bandwidth';
import { formatThroughput } from '$lib/helpers/network-speed';
import { getStalenessState } from '$lib/helpers/staleness';
import type { LinkSignal } from '$lib/types/hud';
import { cn } from '$lib/utils';
import {
	ambiguousLinkLabels,
	linkDisambiguation,
	linkRowKey,
} from './link-disambiguation';

interface Props {
	links: LinkSignal[];
	modemEntries: [string, Modem][];
	linkTelemetry?: LinkTelemetryMessage | null;
	/** Known interfaces that carry no bonded traffic; stated, never listed here. */
	unbondedCount?: number;
}

const {
	links,
	modemEntries,
	linkTelemetry = undefined,
	unbondedCount = 0,
}: Props = $props();

// The feed is `undefined` only before the first status push lands. Distinguish
// that "not arrived yet" state from a delivered-but-empty feed (null / no entry
// for this link) so cards show a skeleton on first paint instead of a "--" flicker.
const telemetryLoading = $derived(linkTelemetry === undefined);

// Index telemetry rows by their resolved interface name so each card can join
// its own values. `link.id` is the kernel ifname, which the backend resolves per
// link from the id the bind-map writer published (link-telemetry.ts) rather than
// from the shared source address — twins share an IP, so an address-resolved
// name pointed BOTH of their rows at one interface. No match -> "--".
const telemetryByIface = $derived(
	new Map<string, LinkTelemetryEntry>(
		(linkTelemetry?.links ?? []).map((entry) => [entry.iface, entry]),
	),
);

// Two units of one model render identical labels; only then is the extra
// identity line worth its noise.
const ambiguousLabels = $derived(ambiguousLinkLabels(links));

/** A short type tag for a bonded link (WiFi, Ethernet, or the modem's network generation). */
function linkTypeLabel(link: LinkSignal): string {
	if (link.type === 'wifi') return m["network.view.wifi"]();
	if (link.type === 'ethernet') return m["network.view.ethernet"]();
	const modem = modemEntries.find(([, m]) => (m.ifname || '') === link.id)?.[1];
	return modem?.status?.network_type || m["network.view.cellular"]();
}

const total = $derived(aggregateBondBandwidth(links));
const totalUpKbps = $derived(total.upKbps);
const totalDownKbps = $derived(total.downKbps);
const hasDownstream = $derived(total.hasDownstream);

// The bond total is only as fresh as its links: when every link has aged out
// (i.e. on a full disconnect, where `isFullyStale` is baked into each
// `link.isStale`), the aggregate is stale too. Route through the shared helper
// so the dimming threshold matches every other live value (Task 18).
const totalStale = $derived(
	getStalenessState(totalUpKbps, null, links.length > 0 && links.every((link) => link.isStale)) ===
		'stale',
);
</script>

<!-- ───────────── Bonded Links overview ───────────── -->
<section class="bg-card rounded-xl border p-4 sm:p-5" aria-label={m["network.view.bondedLinks"]()}>
	<div class="mb-3 flex items-center gap-2">
		<Radio aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{m["network.view.bondedLinks"]()}</h2>
	</div>

	{#if links.length === 0}
		<p class="text-muted-foreground text-sm">{m["network.view.noLinks"]()}</p>
		{@render notBondedNote()}
	{:else}
		<!-- SOLE home of live per-link numbers on the Network page (Task 19): the
		     per-interface sections no longer duplicate them (Task 20). -->
		<div class="flex flex-col gap-1.5">
			{#each links as link (linkRowKey(link, telemetryByIface.get(link.id)))}
				{@const entry = telemetryByIface.get(link.id)}
				{@const color = `var(--link-${link.linkIndex + 1})`}
				{@const hasSignal = link.signal !== null}
				{@const identity = linkDisambiguation(link, entry, ambiguousLabels)}
				<div
					data-testid="bonded-link-card"
					data-link-id={link.id}
					data-link-key={linkRowKey(link, entry)}
					class={cn(
						'flex flex-wrap items-center gap-2.5 rounded-lg border px-3 py-1.5',
						link.isStale && 'opacity-50',
					)}
					style="border-color: color-mix(in oklab, {color} 35%, transparent); background-color: color-mix(in oklab, {color} 10%, transparent);"
				>
					<span class="shrink-0 text-xs font-bold tabular-nums" style="color: {color};"
						>L{link.linkIndex + 1}</span
					>
					<LinkIndicator
						shape="bars"
						size="md"
						type={link.type}
						signal={link.signal}
						connectionState={link.connectionState}
						linkIndex={link.linkIndex}
					/>
					<!-- A REAL BASIS, not `flex-1`'s zero. Every instrument to the right is
					     `shrink-0`, so a zero-basis identity column is the only thing in the
					     row that can absorb a squeeze — and at 375px it absorbed all of it
					     and measured 0, which is the known gap this pass closes. With a
					     basis the instruments wrap to a second line instead, and the device
					     name keeps its width. Written as ONE `flex` shorthand on purpose:
					     `flex-1 basis-32` sets `flex-basis` twice and which one wins is
					     decided by Tailwind's stylesheet order, not by the class attribute. -->
					<div class="flex min-w-0 flex-[1_1_8rem] flex-col leading-tight">
						<span class="truncate text-xs font-medium">{link.label}</span>
						<span class="text-muted-foreground truncate text-[10px] uppercase tracking-wide">
							{linkTypeLabel(link)}{#if identity}<!--
							-->&nbsp;·&nbsp;<!--
							--><span data-testid="bonded-link-identity" dir="ltr" class="font-mono normal-case"
									>{identity}</span
								>{/if}
						</span>
					</div>
					<!-- The instruments travel as ONE unit so a wrap cannot strand the
					     speed badge on a line away from the telemetry it belongs with, and
					     so the group wraps whole rather than item by item. Every member is
					     `shrink-0`, so before this their combined min-content simply pushed
					     the identity column above out of existence. -->
					<div class="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2.5">
						{#if hasSignal}
							<span
								data-live-value
								class="shrink-0 font-mono text-xs tabular-nums"
								style="color: {color};"
							>
								{link.signal}%
							</span>
						{:else if link.type === 'modem' && link.connectionState === 'no_sim'}
							<span class="text-muted-foreground shrink-0 text-[10px] uppercase tracking-wide">
								{m["network.view.noSimLink"]()}
							</span>
						{:else if link.type === 'modem' && link.connectionState === 'scanning'}
							<span class="text-muted-foreground shrink-0 text-[10px] uppercase tracking-wide">
								{m["network.modem.scanning"]()}
							</span>
						{/if}
						<!-- per-link throughput (Task 18) -->
						<Badge variant="speed" class="shrink-0" kbps={linkUpKbps(link)} stale={link.isStale} />

						<!-- per-link srtla telemetry: RTT / NAK / weight (Task 22) — rides
						     the same row via a left divider, at reduced size (Task 19). -->
						<div
							class="min-w-0 border-s ps-2.5"
							style="border-color: color-mix(in oklab, {color} 20%, transparent);"
						>
							<LinkTelemetry class="gap-x-2.5" {entry} loading={telemetryLoading} />
						</div>
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
				>{m["network.view.totalBandwidth"]()}</span
			>
			<span class="flex items-baseline gap-2.5">
				<span
					data-live-value
					data-testid="total-bandwidth-up"
					class="text-foreground font-mono text-sm font-bold tabular-nums"
				>
					<span aria-hidden="true">↑</span>
					{formatThroughput(totalUpKbps)}
				</span>
				{#if hasDownstream}
					<span
						data-live-value
						data-testid="total-bandwidth-down"
						class="text-muted-foreground font-mono text-xs tabular-nums"
					>
						<span aria-hidden="true">↓</span>
						{formatThroughput(totalDownKbps)}
					</span>
				{/if}
			</span>
		</div>

		{@render notBondedNote()}
	{/if}
</section>

<!--
	The panel lists the bond and nothing else, so a link that carries no traffic
	has no row here. Its EXISTENCE still has to be discoverable, so the count is
	stated and the operator is pointed at the per-device row — the one surface
	that can actually explain WHY, and that already does.
-->
{#snippet notBondedNote()}
	{#if unbondedCount > 0}
		<p
			data-testid="bonded-links-not-bonded"
			data-not-bonded-count={unbondedCount}
			class="text-muted-foreground mt-3 text-xs"
		>
			{unbondedCount === 1
				? m["network.view.notBondedOne"]()
				: m["network.view.notBondedMany"]({ count: unbondedCount })}
		</p>
	{/if}
{/snippet}
