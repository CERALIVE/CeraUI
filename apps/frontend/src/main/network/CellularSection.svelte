<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Modem, NetifMessage } from '@ceraui/rpc/schemas';
import { ChevronRight, Radio } from '@lucide/svelte';

import BondToggle from '$lib/components/custom/BondToggle.svelte';
import Badge from '$lib/components/custom/Badge.svelte';
import { Button } from '$lib/components/ui/button';
import { cn } from '$lib/utils';

interface Props {
	modemEntries: [string, Modem][];
	/** Live per-interface telemetry; supplies bond state (`enabled`/`ip`). */
	netif: NetifMessage | undefined;
	/** Whole-app staleness latch: the WS has been down past the global threshold. */
	isFullyStale: boolean;
	/** ifnames whose own telemetry aged out while siblings stayed fresh (Task 22). */
	staleInterfaces: Set<string>;
	onConfigure: (id: string) => void;
}

const { modemEntries, netif, isFullyStale, staleInterfaces, onConfigure }: Props = $props();
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
				{@const noSim = modem.no_sim === true}
				{@const connected = modem.status?.connection === 'connected'}
				{@const scanning = modem.status?.connection === 'scanning'}
				{@const operator = modem.status?.network || modem.sim_network || modem.name}
				{@const entry = netif?.[modem.ifname]}
				{@const ifaceStale = staleInterfaces.has(modem.ifname) || isFullyStale}
				{@const showStale = ifaceStale && !noSim}
				{@const unavailableReason = modem.availability_reason}
				<!-- Single-line row: identity (dot · name · status) left; bond + configure right. -->
				<div
					class={cn(
						'flex flex-wrap items-center gap-3 px-4 py-2.5',
						unavailableReason && 'opacity-60',
					)}
					data-testid="cellular-modem-row"
					data-unavailable={unavailableReason ? '' : undefined}
				>
					<span
						class={cn('size-2 shrink-0 rounded-full', connected ? 'bg-primary' : 'bg-muted-foreground/40')}
						aria-hidden="true"
					></span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium">
							{modem.name}{#if modem.slot_label}
								<span class="text-muted-foreground ms-1 text-xs font-normal">· {modem.slot_label}</span>
							{/if}
						</p>
						{#if unavailableReason}
							<p
								class="text-status-warning truncate text-xs"
								role="note"
								data-testid="cellular-modem-unavailable-reason"
							>
								{$LL.network.modem.unavailable.title()} · {unavailableReason}
							</p>
						{:else}
							<p
								class={cn(
									'text-muted-foreground truncate text-xs transition-opacity',
									ifaceStale && 'opacity-50',
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
						{/if}
					</div>
					<div class="ms-auto flex shrink-0 items-center gap-2">
						{#if showStale}
							<Badge variant="stale" data-stale-interface={modem.ifname} />
						{/if}
						{#if unavailableReason}
							<BondToggle
								name={modem.ifname}
								enabled={false}
								disabledReason={unavailableReason}
							/>
						{:else if noSim}
							<BondToggle
								name={modem.ifname}
								enabled={false}
								disabledReason={$LL.network.view.noSimBond()}
							/>
						{:else if entry?.ip}
							<BondToggle name={modem.ifname} enabled={entry.enabled} ip={entry.ip} />
						{/if}
						<Button
							class="h-8 min-h-[var(--touch-target-min)] gap-1 px-2.5"
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
