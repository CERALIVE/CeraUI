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
import type { LinkTelemetryMessage } from '@ceraui/rpc/schemas';

import CompactRate from './CompactRate.svelte';

interface Props {
	/** The headline rate, already formatted. */
	bitrate: string;
	/** Whether `bitrate` is a measurement rather than the engine's target. */
	bitrateMeasured?: boolean;
	telemetry: LinkTelemetryMessage | null | undefined;
}

const { bitrate, bitrateMeasured = false, telemetry }: Props = $props();

const links = $derived(telemetry?.links ?? []);
// What the rows can actually show. A stale row is a link whose report has not
// been refreshed, which is not proof the link failed, so it reads as "stopped
// reporting". A fresh row with no share of the bond is idle. Only when every
// row is fresh and carrying a share does it read "All links sending".
type Verdict = 'waiting' | 'stopped-reporting' | 'idle' | 'sending';
const verdictKind = $derived<Verdict>(
	links.length === 0
		? 'waiting'
		: links.some((link) => link.stale)
			? 'stopped-reporting'
			: links.some((link) => !(link.weight_percent > 0))
				? 'idle'
				: 'sending',
);
const verdict = $derived(
	verdictKind === 'waiting'
		? m["live.ingest.waiting"]()
		: verdictKind === 'stopped-reporting'
			? m["live.glance.linkDown"]()
			: verdictKind === 'idle'
				? m["live.glance.linkIdle"]()
				: m["live.glance.allSending"](),
);
const anyDown = $derived(verdictKind !== 'sending');
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
				<CompactRate value={bitrate} />
			</p>
		</div>
		<p
			class="mt-1 inline-flex shrink-0 items-center gap-1.5 text-sm font-medium"
			data-verdict={verdictKind}
			role="status"
		>
			<span
				aria-hidden={true}
				class="size-2 rounded-full"
				style="background: {verdictKind === 'waiting'
					? 'var(--muted-foreground)'
					: anyDown
						? 'var(--status-warning)'
						: 'var(--status-success)'};"
			></span>
			{verdict}
		</p>
	</div>

	{#if links.length > 0}
		<!-- biome-ignore lint/a11y/noRedundantRoles: Safari drops the list role once Tailwind removes the markers. -->
		<ul class="space-y-2" role="list">
			{#each links as link, i (`${link.conn_id}:${link.iface}:${i}`)}
				<li class="space-y-1" data-iface={link.iface} data-stale={link.stale ? 'true' : 'false'}>
					<div class="flex items-baseline justify-between gap-3 text-sm">
						<span class="min-w-0 truncate font-medium">{link.iface}</span>
						<span class="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
							{link.stale ? m["live.glance.down"]() : `${link.weight_percent}%`}
						</span>
					</div>
					<div aria-hidden={true} class="bg-muted h-1.5 overflow-hidden rounded-full">
						<div
							class="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
							style="width: {link.stale ? 0 : Math.max(2, Math.min(100, link.weight_percent))}%; background-color: var(--link-{(i % 6) + 1});"
						></div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
