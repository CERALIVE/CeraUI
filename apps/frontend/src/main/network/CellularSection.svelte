<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Modem, NetifMessage } from '@ceraui/rpc/schemas';
import { ChevronRight, Radio } from '@lucide/svelte';

import BondToggle from '$lib/components/custom/BondToggle.svelte';
import LinkIndicator from '$lib/components/custom/LinkIndicator.svelte';
import SpeedBadge from '$lib/components/custom/SpeedBadge.svelte';
import { Button } from '$lib/components/ui/button';
import { convertBytesToKbids } from '$lib/helpers/network-speed';
import { modemSignal } from '$lib/helpers/signal';
import { getStalenessState } from '$lib/helpers/staleness';
import type { LinkSignal } from '$lib/types/hud';
import { cn } from '$lib/utils';

interface Props {
	modemEntries: [string, Modem][];
	/** Live per-interface telemetry; supplies bond state (`enabled`/`ip`) and throughput (`tp`). */
	netif: NetifMessage | undefined;
	/** HUD bonded-link signals — single source for per-link throughput + staleness. */
	links: LinkSignal[];
	/** Whole-app staleness latch: the WS has been down past the global threshold. */
	isFullyStale: boolean;
	onConfigure: (id: string) => void;
}

const { modemEntries, netif, links, isFullyStale, onConfigure }: Props = $props();
</script>

<!-- ───────────── Cellular ───────────── -->
<section class="bg-card rounded-xl border">
	<div class="flex items-center gap-2 border-b px-4 py-3">
		<Radio aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{$LL.network.view.cellular()}</h2>
	</div>
	<div class="divide-y">
		{#if modemEntries.length === 0}
			<p class="text-muted-foreground px-4 py-6 text-center text-sm">
				{$LL.network.view.noModems()}
			</p>
		{:else}
			{#each modemEntries as [id, modem], _i (modem.ifname || id + '-' + _i)}
			{@const sig = modemSignal(modem)}
				{@const noSim = modem.no_sim === true}
				{@const connected = modem.status?.connection === 'connected'}
				{@const scanning = modem.status?.connection === 'scanning'}
				{@const connectionState = noSim
					? 'no_sim'
					: scanning
						? 'scanning'
						: connected
							? 'connected'
							: 'disconnected'}
				{@const operator = modem.status?.network || modem.sim_network || modem.name}
				{@const entry = netif?.[modem.ifname]}
				{@const link = links.find((l) => l.id === (modem.ifname || id))}
				{@const kbps = link
					? link.throughputKbps
					: noSim || !entry
						? null
						: convertBytesToKbids(entry.tp)}
				{@const rawStale = link?.isStale ?? isFullyStale}
				{@const tpStale = getStalenessState(kbps, null, rawStale) === 'stale'}
				{@const sigStale = getStalenessState(sig, null, rawStale) === 'stale'}
				{@const sigColor = link ? `var(--link-${link.linkIndex + 1})` : 'var(--muted-foreground)'}
				<div class="px-4 py-4">
					<!-- Identity row: status dot · name/status · signal · speed -->
					<div class="flex items-center gap-3">
						<span
							class={cn('size-2 shrink-0 rounded-full', connected ? 'bg-primary' : 'bg-muted-foreground/40')}
							aria-hidden="true"
						></span>
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-medium">{modem.name}</p>
							<p
								class={cn(
									'text-muted-foreground truncate text-xs transition-opacity',
									rawStale && 'opacity-50',
								)}
							>
								{#if noSim}
									{$LL.network.view.noModems()}
								{:else}
									{operator}{#if modem.status?.network_type}
										· {modem.status.network_type}{/if} ·
									{#if scanning}
										{$LL.network.modem.scanning()}
									{:else}
										{connected ? $LL.network.view.connected() : $LL.network.view.disconnected()}
									{/if}
								{/if}
							</p>
						</div>
						<div class="flex shrink-0 items-center gap-2.5">
							<div class={cn('flex items-center gap-1.5 transition-opacity', sigStale && 'opacity-50')}>
								<LinkIndicator
									shape="bars"
									size="md"
									type="modem"
									signal={sig}
									{connectionState}
									linkIndex={link?.linkIndex}
								/>
								{#if sig !== null}
									<span data-live-value class="font-mono text-xs tabular-nums" style:color={sigColor}>
										{sig}%
									</span>
								{/if}
							</div>
							<SpeedBadge {kbps} stale={tpStale} />
						</div>
					</div>

					<!-- Control row: bond membership · configure -->
					<div class="mt-2.5 flex flex-wrap items-center gap-2 ps-5">
						{#if noSim}
							<BondToggle
								name={modem.ifname}
								enabled={false}
								disabledReason={$LL.network.view.noSimBond()}
							/>
						{:else if entry?.ip}
							<BondToggle name={modem.ifname} enabled={entry.enabled} ip={entry.ip} />
						{/if}
						<Button
							class="ms-auto h-8 gap-1 px-2.5"
							data-testid="open-modem-config-dialog"
							size="sm"
							variant="ghost"
							onclick={() => onConfigure(id)}
						>
							{$LL.network.view.configure()}
							<ChevronRight class="size-3.5 rtl:rotate-180" />
						</Button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</section>
