<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Modem } from '@ceraui/rpc/schemas';
import { ChevronRight, Radio, Signal, WifiOff } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { convertBytesToKbids } from '$lib/helpers/network-speed';
import { signalTextClass } from '$lib/helpers/signal';
import { cn } from '$lib/utils';

interface Props {
	modemEntries: [string, Modem][];
	onConfigure: (id: string) => void;
}

const { modemEntries, onConfigure }: Props = $props();

function modemSignal(modem: Modem): number | null {
	if (modem.no_sim) return null;
	const signal = modem.status?.signal;
	if (signal == null || !Number.isFinite(signal) || signal < 0) return null;
	return signal;
}
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
				{@const connected = modem.status?.connection === 'connected'}
				{@const operator = modem.status?.network || modem.sim_network || modem.name}
				{@const model = modelLabel(modem)}
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
				<div class="px-4 py-3">
					<!-- Identity row: status dot · name/model · signal · configure -->
					<div class="flex items-center gap-3">
						<span
							class={cn('size-2 shrink-0 rounded-full', connected ? 'bg-primary' : 'bg-muted-foreground/40')}
							aria-hidden="true"
						></span>
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-medium">{modem.name}</p>
							{#if model}
								<p class="text-muted-foreground truncate text-xs">{model}</p>
							{/if}
						</div>
					{#if sig != null}
							<div class={cn('flex items-center gap-1.5 transition-opacity', sigStale && 'opacity-50')}>
								<Signal class={cn('size-3.5', signalTextClass(sig))} aria-hidden="true" />
								<span class={cn('font-mono text-xs tabular-nums', signalTextClass(sig))}>
									{sig}%
								</span>
							</div>
						{:else if noSim}
							<div class="text-muted-foreground flex items-center gap-1.5">
								<CardSim class="size-3.5" aria-hidden="true" />
								<span class="text-xs">{$LL.network.view.noSimLink()}</span>
							</div>
						{:else if scanning}
							<div class="text-muted-foreground flex items-center gap-1.5">
								<Radar class="size-3.5 motion-safe:animate-pulse" aria-hidden="true" />
								<span class="text-xs">{$LL.network.modem.scanning()}</span>
							</div>
						{:else if connected}
							<LoaderCircle class="text-muted-foreground size-4 motion-safe:animate-spin" aria-hidden="true" />
						{:else}
							<WifiOff class="text-muted-foreground size-4" aria-hidden="true" />
						{/if}
						<Button
							class="h-8 gap-1 px-2.5"
							data-testid="open-modem-config-dialog"
							size="sm"
							variant="ghost"
							onclick={() => onConfigure(id)}
						>
							{$LL.network.view.configure()}
							<ChevronRight class="size-3.5 rtl:rotate-180" />
						</Button>
					</div>

					<!-- Telemetry row: connection status · speed · bond membership -->
					<div class="mt-2.5 flex items-center justify-between gap-3 ps-5">
						<p
							class={cn(
								'text-muted-foreground min-w-0 flex-1 truncate text-xs transition-opacity',
								rawStale && 'opacity-50',
							)}
						>
							{#if noSim}
								{$LL.network.view.noModems()}
							{:else}
								{operator}{#if modem.status?.network_type}
									· {modem.status.network_type}{/if} ·
								{connected ? $LL.network.view.connected() : $LL.network.view.disconnected()}
							{/if}
						</p>
					</div>
					{#if sig != null}
						<div class="flex items-center gap-1.5">
							<Signal class={cn('size-3.5', signalTextClass(sig))} aria-hidden="true" />
							<span class={cn('font-mono text-xs tabular-nums', signalTextClass(sig))}>
								{sig}%
							</span>
						</div>
					{:else}
						<WifiOff class="text-muted-foreground size-4" aria-hidden="true" />
					{/if}
					<Button
						class="h-8 gap-1 px-2.5"
						size="sm"
						variant="ghost"
						onclick={() => onConfigure(id)}
					>
						{$LL.network.view.configure()}
						<ChevronRight class="size-3.5 rtl:rotate-180" />
					</Button>
				</div>
			{/each}
		{/if}
	</div>
</section>
