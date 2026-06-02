<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Modem, NetifMessage } from '@ceraui/rpc/schemas';
import { ChevronRight, Radio, Signal, WifiOff } from '@lucide/svelte';

import BondToggle from '$lib/components/custom/BondToggle.svelte';
import SpeedBadge from '$lib/components/custom/SpeedBadge.svelte';
import { Button } from '$lib/components/ui/button';
import { getSignalCategory } from '$lib/helpers/signal';
import { convertBytesToKbids } from '$lib/helpers/network-speed';
import { cn } from '$lib/utils';

interface Props {
	modemEntries: [string, Modem][];
	/** Live per-interface telemetry; supplies bond state (`enabled`/`ip`) and throughput (`tp`). */
	netif: NetifMessage | undefined;
	onConfigure: (id: string) => void;
}

const { modemEntries, netif, onConfigure }: Props = $props();

function modemSignal(modem: Modem): number | null {
	if (modem.no_sim) return null;
	const signal = modem.status?.signal;
	if (signal == null || !Number.isFinite(signal) || signal < 0) return null;
	return signal;
}

/**
 * Hardware identity line: manufacturer + model, rendered RAW (never matched or
 * transformed). Empty when neither field is present, so the row degrades to the
 * interface/name only without a placeholder artifact.
 */
function modelLabel(modem: Modem): string {
	return [modem.manufacturer, modem.model].filter(Boolean).join(' ');
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
				{@const noSim = modem.no_sim === true}
				{@const connected = modem.status?.connection === 'connected'}
				{@const operator = modem.status?.network || modem.sim_network || modem.name}
				{@const model = modelLabel(modem)}
				{@const entry = netif?.[modem.ifname]}
				{@const kbps = noSim || !entry ? null : convertBytesToKbids(entry.tp)}
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

					<!-- Telemetry row: connection status · speed · bond membership -->
					<div class="mt-2.5 flex items-center justify-between gap-3 ps-5">
						<p class="text-muted-foreground min-w-0 flex-1 truncate text-xs">
							{#if noSim}
								{$LL.network.view.noModems()}
							{:else}
								{operator}{#if modem.status?.network_type}
									· {modem.status.network_type}{/if} ·
								{connected ? $LL.network.view.connected() : $LL.network.view.disconnected()}
							{/if}
						</p>
						<div class="flex shrink-0 items-center gap-3">
							<SpeedBadge {kbps} />
							{#if noSim}
								<BondToggle
									name={modem.ifname}
									enabled={false}
									disabledReason={$LL.network.view.noSimBond()}
								/>
							{:else if entry?.ip}
								<BondToggle name={modem.ifname} enabled={entry.enabled} ip={entry.ip} />
							{/if}
						</div>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</section>
