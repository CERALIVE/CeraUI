<!--
  HotspotSection.svelte — the Network destination's hotspot card.

  While an AP is broadcasting it also lists WHO IS JOINED, from the device's own
  `iw dev <ifname> station dump` on that AP's interface. The three roster states
  are genuinely three and must not be collapsed (see `hotspot-clients-view.ts`):
  an ABSENT block renders nothing at all (older backend, or a first read that has
  not landed), a MEASURED zero renders a calm "nobody is connected" line, and a
  populated roster renders the count plus one row per station.

  This is the ONLY surface that renders per-client telemetry — the same rule that
  makes BondedLinksSection the sole owner of per-link RTT/NAK/weight. Do not
  restate a client's signal or rate on another card.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { WifiInterface } from '@ceraui/rpc/schemas';
import { ChevronRight, Router, Users } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { signalTextClass } from '$lib/helpers/signal';

import { deriveHotspotClientsView, formatClientRatePair } from './hotspot-clients-view';

interface Props {
	hotspotInterfaces: [string, WifiInterface][];
	hotspotTarget: [string, WifiInterface] | undefined;
	onSetup: () => void;
}

const { hotspotInterfaces, hotspotTarget, onSetup }: Props = $props();

/**
 * A representative percent inside each of `getSignalCategory`'s bands.
 *
 * The colour RAMP stays single-sourced in `signalTextClass`; only the choice of
 * band happens here, because that function's scale is a 0-100 percent and a
 * station's RSSI is dBm. Handing it -47 directly would bucket a strong client as
 * `weak` and paint a healthy row red, so the dBm tier is resolved first
 * (`hotspotClientSignalCategory`) and this probes the ramp for that tier.
 */
const CATEGORY_PROBE_PERCENT = { excellent: 80, good: 60, fair: 40, weak: 10 } as const;
</script>

<!-- ───────────── Hotspot (independent of WiFi: simultaneous state) ───────────── -->
<section class="bg-card rounded-xl border">
	<div class="flex items-center gap-2 border-b px-4 py-3">
		<Router aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{m["network.view.hotspot"]()}</h2>
		<Button
			class="ms-auto h-8 gap-1 px-2.5"
			data-testid="open-hotspot-dialog"
			size="sm"
			variant="ghost"
			disabled={!hotspotTarget}
			onclick={onSetup}
		>
			{m["network.view.setup"]()}
			<ChevronRight class="size-3.5 rtl:rotate-180" />
		</Button>
	</div>
	<div class="divide-y">
		{#if hotspotInterfaces.length === 0}
			<div class="px-4 py-6 text-center">
				<p class="text-sm font-medium">{m["network.view.hotspotOff"]()}</p>
				<p class="text-muted-foreground mt-0.5 text-xs">{m["network.view.hotspotOffHint"]()}</p>
			</div>
		{:else}
			{#each hotspotInterfaces as [id, iface] (id)}
				{@const clients = deriveHotspotClientsView(iface.hotspot)}
				<div class="px-4 py-3">
					<div class="flex items-center gap-3">
						<span class="bg-status-info size-2 shrink-0 rounded-full" aria-hidden="true"></span>
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-medium">{iface.hotspot?.name || iface.ifname}</p>
							<p class="text-muted-foreground truncate text-xs">
								{m["network.view.active"]()} · {iface.ifname}
							</p>
						</div>
						<span
							class="bg-status-info/10 text-status-info rounded-md px-1.5 py-0.5 text-xs font-medium"
						>
							{iface.supports_ap_sta_concurrency
								? m["network.view.concurrentModeBadge"]()
								: m["network.view.active"]()}
						</span>
					</div>

					{#if clients}
						<div class="mt-3 border-t pt-3" data-testid="hotspot-clients-{id}">
							<div class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
								<Users aria-hidden="true" class="size-3.5 shrink-0" />
								<!-- A measured zero states itself here; a second empty-state line would say it twice. -->
								<span
									data-empty={clients.count === 0 ? 'true' : undefined}
									data-testid="hotspot-clients-count-{id}"
									role="status"
								>
									{#if clients.count === 0}
										{m["network.view.hotspotClientsNone"]()}
									{:else if clients.count === 1}
										{m["network.view.hotspotClientsOne"]({ count: clients.count })}
									{:else}
										{m["network.view.hotspotClientsMany"]({ count: clients.count })}
									{/if}
								</span>
							</div>

							{#if clients.rows.length > 0}
								<ul class="mt-1.5 space-y-1">
									{#each clients.rows as row (row.mac)}
										{@const rate = formatClientRatePair(row.txMbps, row.rxMbps)}
										<li
											class="flex items-center gap-3 text-xs"
											data-testid="hotspot-client-{row.mac}"
										>
											<!--
												A hardware tag: demoted per DESIGN.md §2 (smallest text,
												muted, never the phosphor-lime accent) and forced LTR so an
												RTL locale cannot reorder the hex pairs.
											-->
											<span class="text-muted-foreground min-w-0 flex-1 truncate font-mono" dir="ltr">
												{row.mac}
											</span>
											{#if row.signalDbm !== undefined && row.signalCategory !== undefined}
												<span
													class={`shrink-0 font-mono tabular-nums ${signalTextClass(CATEGORY_PROBE_PERCENT[row.signalCategory])}`}
													data-testid="hotspot-client-signal-{row.mac}"
												>
													{m["network.view.hotspotClientSignal"]({ dbm: row.signalDbm })}
												</span>
											{/if}
											{#if rate}
												<span
													class="text-muted-foreground shrink-0 font-mono tabular-nums"
													data-testid="hotspot-client-rate-{row.mac}"
												>
													{m["network.view.hotspotClientRate"]({ rate })}
												</span>
											{/if}
										</li>
									{/each}
								</ul>
								{#if clients.capped}
									<p
										class="text-muted-foreground mt-1.5 text-xs"
										data-testid="hotspot-clients-capped-{id}"
									>
										{m["network.view.hotspotClientsCapped"]({
											shown: clients.rows.length,
											count: clients.count,
										})}
									</p>
								{/if}
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</section>
