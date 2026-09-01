<!--
  SharingSection.svelte — the Internet-Sharing status surface (todo 13,
  restructured by todo 34).

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

  ONE STATE AUTHORITY. The card used to stack up to two bands above a row list
  whose every row restated the same alarm in its own chip, above two more
  always-open instrument blocks. It now leads with a SINGLE headline
  (`deriveSharingHeadline`) and demotes everything that merely instruments it:
  a band the headline did not speak for, the shaping-priority block, the
  coexistence verdict and the DNS limitation all live behind one Diagnostics
  disclosure, and each uplink's probe counts and reason live behind that row's
  own. Nothing is dropped — the disclosures are closed, not empty, and the
  diagnostics summary carries a state-coloured chip so a folded warning is still
  visible from outside.

  The headline CARRIES the band testid it speaks for, so every selector written
  against the old two-band layout still resolves to the element stating that
  fact. The DNS note is likewise MOVED into the disclosure, not removed: it is a
  recorded limitation (Metis G-4) rather than a reading, and it stays reachable.
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
import { ChevronRight, CircleCheck, Info, Share2, TriangleAlert } from '@lucide/svelte';

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

const TONE_SURFACE = {
	ok: 'bg-status-success/10 border-status-success/30',
	info: 'bg-status-info/10 border-status-info/30',
	warning: 'bg-status-warning/10 border-status-warning/30',
} as const;

const SUMMARY =
	'flex min-h-[var(--touch-target-min)] cursor-pointer list-none items-center gap-1.5 select-none';
</script>

{#snippet toneGlyph(tone: 'ok' | 'info' | 'warning')}
	{#if tone === 'warning'}
		<TriangleAlert class="text-status-warning mt-0.5 size-4 shrink-0" aria-hidden="true" />
	{:else if tone === 'ok'}
		<CircleCheck class="text-status-success mt-0.5 size-4 shrink-0" aria-hidden="true" />
	{:else}
		<Info class="text-status-info mt-0.5 size-4 shrink-0" aria-hidden="true" />
	{/if}
{/snippet}

<section
	class="bg-card rounded-xl border p-4 sm:p-5"
	data-testid="sharing-section"
	aria-label={m['network.sharing.title']()}
>
	<div class="mb-3 flex items-center gap-2">
		<Share2 aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{m['network.sharing.title']()}</h2>
	</div>

	<!-- ── the ONE headline: sharing off / nowhere to send / not steered / active ── -->
	<div
		class={cn(
			'mb-3 flex items-start gap-3 rounded-xl border p-3',
			TONE_SURFACE[view.headline.tone],
		)}
		data-testid="sharing-band-{view.headline.kind}"
		data-headline="true"
		data-kind={view.headline.kind}
		data-tone={view.headline.tone}
		data-reason={view.headline.reason}
		role="status"
	>
		{@render toneGlyph(view.headline.tone)}
		<div class="min-w-0 space-y-1">
			<p class="text-sm font-semibold tracking-tight">
				{resolveMessageKey(view.headline.titleKey)}
			</p>
			<p class="text-muted-foreground text-sm">
				{resolveMessageKey(view.headline.bodyKey, {
					usable: view.headline.usableUplinks,
					total: view.headline.totalUplinks,
				})}
			</p>
			{#if view.headline.reasonKey}
				<p
					class="text-muted-foreground text-sm"
					data-testid="sharing-band-reason-{view.headline.kind}"
				>
					<span class="font-medium">{m['network.sharing.band.reasonLabel']()}:</span>
					{resolveMessageKey(view.headline.reasonKey)}
				</p>
			{/if}
		</div>
	</div>

	<!-- ── per-uplink health: name · kind · state · share, detail on request ── -->
	{#if view.rows.length > 0}
		<h3 class="text-muted-foreground mb-1.5 text-[10px] font-medium tracking-wide uppercase">
			{m['network.sharing.uplinksHeading']()}
		</h3>
		<ul class="flex flex-col gap-1.5" data-testid="sharing-uplinks">
			{#each view.rows as row (row.iface)}
				{@const color = `var(--link-${row.linkIndex})`}
				<li
					class={cn('rounded-lg border', row.stale && 'opacity-50')}
					data-testid="sharing-uplink-{row.iface}"
					data-state={row.state}
					data-reason={row.reason}
					data-stale={row.stale ? 'true' : 'false'}
					style="border-color: color-mix(in oklab, {color} 35%, transparent); background-color: color-mix(in oklab, {color} 10%, transparent);"
				>
					<details class="group" data-testid="sharing-uplink-detail-{row.iface}">
						<summary
							class={cn(SUMMARY, 'flex-wrap gap-x-2.5 gap-y-1 px-3 py-1.5')}
							data-testid="sharing-uplink-toggle-{row.iface}"
						>
							<span class="flex min-w-0 flex-[1_1_7rem] flex-col leading-tight">
								<span class="truncate font-mono text-xs font-medium" dir="ltr">{row.iface}</span>
								<span class="text-muted-foreground truncate text-[10px] tracking-wide uppercase">
									{resolveMessageKey(row.kindLabelKey)}
								</span>
							</span>

							<!-- MUTED, NOT REMOVED. When the headline already asserts that every
							     uplink is down, this chip is the same alarm repeated once per row —
							     so it drops to the neutral register and keeps its WORD, because
							     colour is only ever reinforcement here. -->
							<Badge
								variant={view.headline.restatesRowState ? 'neutral' : STATE_VARIANT[row.state]}
								label={resolveMessageKey(row.stateLabelKey)}
								class="shrink-0"
								data-testid="sharing-uplink-state-{row.iface}"
								data-muted={view.headline.restatesRowState ? 'true' : undefined}
							/>

							<span class="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2.5">
								{#if row.stale}
									<!-- The `stale` family drops `...rest`; this attr is the selector.
									     Staleness is a STATE, not a detail, so it stays on the row: a
									     dimmed row with its word folded away is colour carrying a state
									     alone. -->
									<Badge variant="stale" data-stale-interface={row.iface} />
								{/if}
								<!-- The weight is a STEERING SHARE, not link quality: how much
								     shared-client traffic this uplink is asked to carry. It therefore
								     renders only where client traffic is really being steered, and it
								     is LABELLED, because an unlabelled percentage beside a health
								     state reads as a quality score for the link. -->
								{#if view.showSteeringShare}
									<span
										class="inline-flex shrink-0 items-center gap-1.5"
										data-testid="sharing-uplink-weight-{row.iface}"
										data-weight={row.weight}
									>
										<span class="text-muted-foreground text-[10px] tracking-wide uppercase">
											{m['network.sharing.steeringShare']()}
										</span>
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
										<span
											data-live-value
											class="font-mono text-xs tabular-nums"
											style="color: {color};"
										>
											{row.weight}%
										</span>
									</span>
								{/if}
								<ChevronRight
									aria-hidden="true"
									class="text-muted-foreground size-3.5 shrink-0 transition-transform group-open:rotate-90 rtl:rotate-180 rtl:group-open:-rotate-90"
								/>
								<span class="sr-only">{m['network.sharing.uplinkDetail.disclosure']()}</span>
							</span>

							<!-- WHY a link is not up belongs beside its state, not behind a
							     disclosure: the state word alone ("Degraded") is the one thing an
							     operator cannot act on. `basis-full` wraps it onto its own line
							     inside the same summary, so it is on screen at rest. -->
							{#if row.reasonKey}
								<p
									class="text-muted-foreground basis-full text-xs"
									data-testid="sharing-uplink-reason-{row.iface}"
									role="status"
								>
									{resolveMessageKey(row.reasonKey)}
								</p>
							{/if}
						</summary>

						<div class="space-y-1 border-t px-3 pt-1.5 pb-2">
							<p class="text-muted-foreground text-xs">
								<span class="font-medium">{m['network.sharing.probesLabel']()}:</span>
								<span
									class="font-mono tabular-nums"
									data-testid="sharing-uplink-probes-{row.iface}"
								>
									{m['network.sharing.probes']({
										successes: row.probes.successes,
										failures: row.probes.failures,
									})}
								</span>
							</p>
						</div>
					</details>
				</li>
			{/each}
		</ul>
	{/if}

	<!-- ── client zones ── -->
	<div class="mt-3 border-t pt-3" data-testid="sharing-zones" data-active={view.zones.active}>
		<h3 class="text-muted-foreground mb-1.5 text-[10px] font-medium tracking-wide uppercase">
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

	<!-- ── diagnostics: the instruments, folded, with their state still visible ── -->
	<details
		class="group mt-3 border-t pt-3"
		data-testid="sharing-diagnostics"
		data-tone={view.diagnostics.tone}
		data-findings={view.diagnostics.findings}
	>
		<summary class={cn(SUMMARY, 'gap-2')} data-testid="sharing-diagnostics-toggle">
			<ChevronRight
				aria-hidden="true"
				class="text-muted-foreground size-3.5 shrink-0 transition-transform group-open:rotate-90 rtl:rotate-180 rtl:group-open:-rotate-90"
			/>
			<span class="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
				{m['network.sharing.diagnostics.disclosure']()}
			</span>
			<Badge
				variant={view.diagnostics.tone}
				label={resolveMessageKey(view.diagnostics.labelKey, {
					count: view.diagnostics.findings,
				})}
				class="ms-auto shrink-0"
				size="micro"
				data-testid="sharing-diagnostics-chip"
			/>
		</summary>

		<div class="mt-2 space-y-3">
			<!-- A band the headline did not speak for is still TRUE, so it renders
			     here rather than beside a headline it would compete with. -->
			{#each view.subordinate as band (band.kind)}
				<div
					class={cn(
						'flex items-start gap-3 rounded-xl border p-3',
						TONE_SURFACE[band.tone],
					)}
					data-testid="sharing-band-{band.kind}"
					data-tone={band.tone}
					data-reason={band.reason}
					role="status"
				>
					{@render toneGlyph(band.tone)}
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

			<!-- ── streaming priority ── -->
			<div
				data-testid="sharing-priority"
				data-priority={view.priority.kind}
				data-reason={view.priority.reason}
			>
				<h4 class="text-muted-foreground mb-1.5 text-[10px] font-medium tracking-wide uppercase">
					{m['network.sharing.priorityHeading']()}
				</h4>
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
							class="text-muted-foreground font-mono text-[10px] tracking-wide uppercase"
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
						'flex items-start gap-3 rounded-xl border p-3',
						TONE_SURFACE[view.diag.tone],
					)}
					data-testid="sharing-diag"
					data-tone={view.diag.tone}
					role="status"
				>
					{@render toneGlyph(view.diag.tone)}
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

			<p class="text-muted-foreground text-xs" data-testid="sharing-dns-note">
				{m['network.sharing.dnsNote']()}
			</p>
		</div>
	</details>
</section>
