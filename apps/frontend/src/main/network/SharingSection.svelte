<!--
  SharingSection.svelte — the Internet-Sharing status surface (todo 13).

  STATUS ONLY. Every input it renders — `uplinks`, `sharing_diag`,
  `uplink-steering`, `uplink-shaper` — is diagnostic or informational by its own
  backend contract, so this card carries NO control: it disables no interface,
  gates no stream and refuses no mutation. The one transient it participates in
  (`uplink-flows-reset`) is a toast raised by the ingestion layer, never a band
  that lingers here.

  Every state resolves to a typed band or a stated value. There is deliberately
  no skeleton and no spinner: a snapshot that has not arrived renders the honest
  "not reported yet" band, because an unbounded spinner is the one thing an
  operator cannot act on.

  The DNS note at the foot is STATIC and unconditional — a recorded limitation
  (Metis G-4) rather than a reading, so it never depends on a wire field.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type {
	NetifMessage,
	SharingDiag,
	UplinkShaperStatus,
	UplinksMessage,
	UplinkSteeringStatus,
	WifiInterface,
} from '@ceraui/rpc/schemas';
import { Info, Share2, TriangleAlert } from '@lucide/svelte';

import Badge from '$lib/components/custom/Badge.svelte';
import { cn } from '$lib/utils';

import { deriveSharingSection } from './sharing-section-view';

interface Props {
	uplinks: UplinksMessage | undefined;
	diag: SharingDiag | undefined;
	steering: UplinkSteeringStatus | undefined;
	shaper: UplinkShaperStatus | undefined;
	netif: NetifMessage | undefined;
	/** The SAME live AP interfaces `HotspotSection` renders its roster from. */
	hotspotInterfaces: [string, WifiInterface][];
	/** Injected so the staleness verdict is drivable in a test without a clock. */
	now?: number;
}

const {
	uplinks,
	diag,
	steering,
	shaper,
	netif,
	hotspotInterfaces,
	now = undefined,
}: Props = $props();

const view = $derived(
	deriveSharingSection({
		uplinks,
		diag,
		steering,
		shaper,
		netif,
		hotspotInterfaces: hotspotInterfaces.map(([, iface]) => iface),
		now: now ?? Date.now(),
	}),
);

const STATE_VARIANT = {
	up: 'success',
	degraded: 'warning',
	down: 'error',
} as const;
</script>

<section
	class="bg-card rounded-xl border p-4 sm:p-5"
	data-testid="sharing-section"
	aria-label={m['network.sharing.title']()}
>
	<div class="mb-3 flex items-center gap-2">
		<Share2 aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{m['network.sharing.title']()}</h2>
	</div>

	<!-- ── honest bands: sharing off / no healthy uplink / steering unavailable ── -->
	{#each view.bands as band (band.kind)}
		<div
			class={cn(
				'mb-3 flex items-start gap-3 rounded-xl border p-3',
				band.tone === 'warning'
					? 'bg-status-warning/10 border-status-warning/30'
					: 'bg-status-info/10 border-status-info/30',
			)}
			data-testid="sharing-band-{band.kind}"
			data-tone={band.tone}
			data-reason={band.reason}
			role="status"
		>
			{#if band.tone === 'warning'}
				<TriangleAlert class="text-status-warning mt-0.5 size-4 shrink-0" aria-hidden="true" />
			{:else}
				<Info class="text-status-info mt-0.5 size-4 shrink-0" aria-hidden="true" />
			{/if}
			<div class="min-w-0 space-y-1">
				<p class="text-sm font-semibold tracking-tight">{resolveMessageKey(band.titleKey)}</p>
				<p class="text-muted-foreground text-sm">{resolveMessageKey(band.bodyKey)}</p>
				{#if band.reasonKey}
					<p class="text-muted-foreground text-sm" data-testid="sharing-band-reason-{band.kind}">
						<span class="font-medium">{m['network.sharing.band.reasonLabel']()}:</span>
						{resolveMessageKey(band.reasonKey)}
					</p>
				{/if}
			</div>
		</div>
	{/each}

	<!-- ── per-uplink health ── -->
	{#if view.rows.length > 0}
		<h3 class="text-muted-foreground mb-1.5 text-[10px] font-medium uppercase tracking-wide">
			{m['network.sharing.uplinksHeading']()}
		</h3>
		<ul class="flex flex-col gap-1.5" data-testid="sharing-uplinks">
			{#each view.rows as row (row.iface)}
				{@const color = `var(--link-${row.linkIndex})`}
				<li
					class={cn(
						'flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border px-3 py-1.5',
						row.stale && 'opacity-50',
					)}
					data-testid="sharing-uplink-{row.iface}"
					data-state={row.state}
					data-reason={row.reason}
					data-stale={row.stale ? 'true' : 'false'}
					style="border-color: color-mix(in oklab, {color} 35%, transparent); background-color: color-mix(in oklab, {color} 10%, transparent);"
				>
					<div class="flex min-w-0 flex-[1_1_7rem] flex-col leading-tight">
						<span class="truncate font-mono text-xs font-medium" dir="ltr">{row.iface}</span>
						<span class="text-muted-foreground truncate text-[10px] uppercase tracking-wide">
							{resolveMessageKey(row.kindLabelKey)}
						</span>
					</div>

					<Badge
						variant={STATE_VARIANT[row.state]}
						label={resolveMessageKey(row.stateLabelKey)}
						class="shrink-0"
						data-testid="sharing-uplink-state-{row.iface}"
					/>

					<div class="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2.5">
						{#if row.stale}
							<!-- The `stale` family drops `...rest`; this attr is the selector. -->
							<Badge variant="stale" data-stale-interface={row.iface} />
						{/if}
						<span
							class="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums"
							data-testid="sharing-uplink-probes-{row.iface}"
						>
							{m['network.sharing.probes']({
								successes: row.probes.successes,
								failures: row.probes.failures,
							})}
						</span>
						<!-- The weight bar is the device's own selection share, so it is a
						     real 0-100 fraction rather than a fabricated denominator. -->
						<div
							class="flex shrink-0 items-center gap-1.5"
							data-testid="sharing-uplink-weight-{row.iface}"
							data-weight={row.weight}
						>
							<span
								class="bg-muted relative block h-1.5 w-16 overflow-hidden rounded-full"
								role="img"
								aria-label={m['network.sharing.weightLabel']({ weight: row.weight })}
							>
								<span
									class="absolute inset-y-0 start-0 block rounded-full"
									style="inline-size: {row.weight}%; background-color: {color};"
								></span>
							</span>
							<span data-live-value class="font-mono text-xs tabular-nums" style="color: {color};">
								{row.weight}%
							</span>
						</div>
					</div>

					{#if row.reasonKey}
						<p
							class="text-muted-foreground basis-full text-xs"
							data-testid="sharing-uplink-reason-{row.iface}"
							role="status"
						>
							{resolveMessageKey(row.reasonKey)}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<!-- ── client zones ── -->
	<div class="mt-3 border-t pt-3" data-testid="sharing-zones" data-active={view.zones.active}>
		<h3 class="text-muted-foreground mb-1.5 text-[10px] font-medium uppercase tracking-wide">
			{m['network.sharing.zonesHeading']()}
		</h3>
		{#if !view.zones.active}
			<p class="text-muted-foreground text-sm" data-testid="sharing-zones-none">
				{m['network.sharing.zonesNone']()}
			</p>
		{:else}
			<ul class="flex flex-col gap-1 text-sm">
				{#if view.zones.hotspots > 0}
					<li class="flex flex-wrap items-baseline gap-x-2" data-testid="sharing-zone-hotspot">
						<span class="font-medium">{m['network.view.hotspot']()}</span>
						<span class="text-muted-foreground text-xs" data-testid="sharing-zone-hotspot-clients">
							{#if view.zones.hotspotClients === undefined}
								{m['network.sharing.clientsNotReported']()}
							{:else if view.zones.hotspotClients === 0}
								{m['network.view.hotspotClientsNone']()}
							{:else if view.zones.hotspotClients === 1}
								{m['network.view.hotspotClientsOne']({ count: view.zones.hotspotClients })}
							{:else}
								{m['network.view.hotspotClientsMany']({ count: view.zones.hotspotClients })}
							{/if}
						</span>
					</li>
				{/if}
				{#each view.zones.sharedLan as zone (zone.ifname)}
					<li
						class="flex flex-wrap items-baseline gap-x-2"
						data-testid="sharing-zone-shared-lan-{zone.ifname}"
						data-zone={zone.zone}
					>
						<span class="font-medium">{m['network.ethRole.sharedLan']()}</span>
						<span class="text-muted-foreground font-mono text-xs" dir="ltr">{zone.ifname}</span>
						<span class="text-muted-foreground text-xs">{resolveMessageKey(zone.zoneLabelKey)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<!-- ── streaming priority ── -->
	<div
		class="mt-3 border-t pt-3"
		data-testid="sharing-priority"
		data-priority={view.priority.kind}
		data-reason={view.priority.reason}
	>
		<h3 class="text-muted-foreground mb-1.5 text-[10px] font-medium uppercase tracking-wide">
			{m['network.sharing.priorityHeading']()}
		</h3>
		<div class="flex flex-wrap items-center gap-2">
			<Badge
				variant={view.priority.kind === 'degraded'
					? 'warning'
					: view.priority.kind === 'adaptive-cap'
						? 'success'
						: 'neutral'}
				label={resolveMessageKey(view.priority.labelKey)}
				data-testid="sharing-priority-state"
			/>
			{#if view.priority.algorithmKey}
				<span
					class="text-muted-foreground font-mono text-[10px] uppercase tracking-wide"
					data-testid="sharing-priority-algorithm"
				>
					{resolveMessageKey(view.priority.algorithmKey)}
				</span>
			{/if}
		</div>
		<p class="text-muted-foreground mt-1 text-sm">{resolveMessageKey(view.priority.bodyKey)}</p>
		{#if view.priority.reasonKey}
			<p class="text-muted-foreground mt-1 text-sm" data-testid="sharing-priority-reason">
				<span class="font-medium">{m['network.sharing.band.reasonLabel']()}:</span>
				{resolveMessageKey(view.priority.reasonKey)}
			</p>
		{/if}
	</div>

	<!-- ── coexistence diagnostics (read-only; nothing here gates anything) ── -->
	{#if view.diag}
		<div
			class={cn(
				'mt-3 flex items-start gap-3 rounded-xl border p-3',
				view.diag.tone === 'warning'
					? 'bg-status-warning/10 border-status-warning/30'
					: 'bg-status-info/10 border-status-info/30',
			)}
			data-testid="sharing-diag"
			data-tone={view.diag.tone}
			role="status"
		>
			{#if view.diag.tone === 'warning'}
				<TriangleAlert class="text-status-warning mt-0.5 size-4 shrink-0" aria-hidden="true" />
			{:else}
				<Info class="text-status-info mt-0.5 size-4 shrink-0" aria-hidden="true" />
			{/if}
			<div class="min-w-0 space-y-1">
				<p class="text-sm font-semibold tracking-tight">{m['network.sharing.diag.title']()}</p>
				<ul class="text-muted-foreground space-y-0.5 text-sm">
					{#each view.diag.findings as finding (finding.check)}
						<li data-testid="sharing-diag-{finding.check}" data-reason={finding.reason}>
							{resolveMessageKey(finding.reasonKey)}
						</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}

	<p class="text-muted-foreground mt-3 text-xs" data-testid="sharing-dns-note">
		{m['network.sharing.dnsNote']()}
	</p>
</section>
