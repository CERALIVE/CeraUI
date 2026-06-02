<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Modem } from '@ceraui/rpc/schemas';
import { ChevronRight, Radio, Signal, WifiOff } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { getSignalCategory } from '$lib/helpers/signal';
import { cn } from '$lib/utils';

interface Props {
	modemEntries: [string, Modem][];
	onConfigure: (id: string) => void;
}

const { modemEntries, onConfigure }: Props = $props();

/** Text colour token for a signal reading, matching SignalIndicator tiers. */
function signalTextClass(signal: number | null): string {
	if (signal == null) return 'text-muted-foreground';
	switch (getSignalCategory(signal)) {
		case 'excellent':
			return 'text-signal-excellent';
		case 'good':
			return 'text-signal-good';
		case 'fair':
			return 'text-signal-fair';
		default:
			return 'text-signal-weak';
	}
}

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
				<div class="flex items-center gap-3 px-4 py-3">
					<span
						class={cn('size-2 shrink-0 rounded-full', connected ? 'bg-primary' : 'bg-muted-foreground/40')}
						aria-hidden="true"
					></span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium">{modem.name}</p>
						<p class="text-muted-foreground truncate text-xs">
							{#if modem.no_sim}
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
