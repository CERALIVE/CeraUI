<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { StatusMessage } from '@ceraui/rpc/schemas';
import { ChevronDown, Loader2, Radio, Settings2, Signal, WifiOff } from '@lucide/svelte';
import { slide } from 'svelte/transition';

import SignalIndicator from '$lib/components/icons/SignalIndicator.svelte';
import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import * as Collapsible from '$lib/components/ui/collapsible';
import { capitalizeFirstLetter, cn } from '$lib/utils.js';

import ModemConfigurator from './ModemConfigurator.svelte';

interface Props {
	modem: StatusMessage['modems'][keyof StatusMessage['modems']];
	deviceId: string;
}

const { modem, deviceId }: Props = $props();

let configOpen = $state(false);

// Derived values
const signalValue = $derived(modem.status?.signal ?? 0);
const connectionStatus = $derived(modem.status?.connection ?? 'disconnected');
const networkType = $derived(modem.status?.network_type ?? '');
const operatorName = $derived(modem.status?.network ?? '');

// Status helpers
const isConnected = $derived(connectionStatus === 'connected');
const isConnecting = $derived(connectionStatus === 'connecting');
const isScanning = $derived(connectionStatus === 'scanning');
const isDisconnected = $derived(!isConnected && !isConnecting && !isScanning);

// Color schemes based on status
const statusColors = $derived.by(() => {
	if (isConnected) {
		return {
			badge: 'bg-primary/10 text-primary',
		};
	}
	if (isConnecting) {
		return {
			badge: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
		};
	}
	if (isScanning) {
		return {
			badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
		};
	}
	return {
		badge: 'bg-muted text-muted-foreground',
	};
});

// Network type badge
function getNetworkBadge(type: string) {
	if (type.includes('5G')) return 'bg-purple-500/10 text-purple-700 dark:text-purple-400';
	if (type.includes('LTE') || type.includes('4G'))
		return 'bg-blue-500/10 text-blue-700 dark:text-blue-400';
	return 'bg-muted text-muted-foreground';
}

// Clean modem name (remove any leftover "| Unknown" for backwards compatibility)
const cleanModemName = $derived(modem.name.replace('| Unknown', '').trim());
</script>

<Card.Root class={cn('gap-0 overflow-hidden border border-border py-0')}>
	<Card.Header class="p-4 pb-3">
		<!-- Header Row -->
		<div class="flex items-center justify-between gap-3">
			<div class="flex min-w-0 items-center gap-2.5">
				<!-- Icon -->
				<div class="grid h-9 w-9 shrink-0 place-items-center rounded-lg">
					{#if isConnected}
						<Signal class="text-muted-foreground h-4 w-4" />
					{:else if isConnecting || isScanning}
						<Loader2 class="text-muted-foreground h-4 w-4 animate-spin" />
					{:else}
						<WifiOff class="text-muted-foreground h-4 w-4" />
					{/if}
				</div>

				<!-- Name & Status -->
				<div class="min-w-0 flex-1">
					<Card.Title class="text-sm leading-tight font-semibold">
						{cleanModemName}
					</Card.Title>
					{#if operatorName && isConnected}
						<p class="text-muted-foreground text-xs">{operatorName}</p>
					{/if}
					<div class="mt-1 flex flex-wrap items-center gap-1.5">
						<span class={cn('rounded-md px-1.5 py-0.5 text-xs font-medium', statusColors.badge)}>
							{#if isConnecting}
								<Loader2 class="mr-1 inline h-3 w-3 animate-spin" />
							{:else if isScanning}
								<Radio class="mr-1 inline h-3 w-3 animate-pulse" />
							{/if}
							{capitalizeFirstLetter(
								$LL.network.modem.connectionStatus[
									connectionStatus as keyof typeof $LL.network.modem.connectionStatus
								](),
							)}
						</span>
						{#if networkType && isConnected}
							<span
								class={cn(
									'rounded-md px-1.5 py-0.5 text-xs font-bold',
									getNetworkBadge(networkType),
								)}
							>
								{networkType}
							</span>
						{/if}
					</div>
				</div>
			</div>

			<!-- Signal Strength - Vertically centered -->
			{#if isConnected}
				<SignalIndicator class="h-9" signal={signalValue} type="cellular" />
			{/if}
		</div>
	</Card.Header>

	<Card.Content class="space-y-3 px-4 pt-0 pb-4">
		<!-- Status Messages -->
		{#if isScanning}
			<div
				class="flex items-center justify-center gap-2 rounded-lg bg-amber-500/10 py-3 text-amber-700 dark:text-amber-400"
			>
				<Loader2 class="h-4 w-4 animate-spin" />
				<span class="text-sm font-medium">{$LL.network.status.scanningNetworks()}</span>
			</div>
		{:else if isConnecting}
			<div
				class="flex items-center justify-center gap-2 rounded-lg bg-blue-500/10 py-3 text-blue-700 dark:text-blue-400"
			>
				<Loader2 class="h-4 w-4 animate-spin" />
				<span class="text-sm font-medium">{$LL.network.status.connecting()}</span>
			</div>
		{:else if isDisconnected}
			<div class="bg-muted flex items-center justify-center gap-2 rounded-lg py-3">
				<WifiOff class="text-muted-foreground h-4 w-4" />
				<span class="text-muted-foreground text-sm">{$LL.network.status.notConnected()}</span>
			</div>
		{/if}

		<!-- Config Toggle -->
		<Collapsible.Root bind:open={configOpen}>
			<Collapsible.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						class="h-9 w-full justify-between border-dashed"
						size="sm"
						variant="outline"
					>
						<span class="flex items-center gap-2 text-sm">
							<Settings2 class="h-4 w-4" />
							{$LL.network.modem.configuration()}
						</span>
						<ChevronDown class={cn('h-4 w-4 transition-transform', configOpen && 'rotate-180')} />
					</Button>
				{/snippet}
			</Collapsible.Trigger>

			<Collapsible.Content>
				<div
					class="bg-muted mt-3 rounded-lg border border-border p-3"
					transition:slide={{ duration: 200 }}
				>
					<ModemConfigurator {deviceId} {modem} modemIsScanning={isScanning} />
				</div>
			</Collapsible.Content>
		</Collapsible.Root>
	</Card.Content>
</Card.Root>
