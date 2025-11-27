<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { AlertCircle, ArrowUpDown, Check, Network, Signal, Wifi, X } from '@lucide/svelte';

import * as Card from '$lib/components/ui/card';
import { Toggle } from '$lib/components/ui/toggle';
import {
	convertBytesToKbids,
	getAvailableNetworks,
	getModemNetworkName,
	getTotalBandwidth,
	getUsedNetworks,
	networkRename,
	networkRenameWithError,
	setNetif,
} from '$lib/helpers/NetworkHelper.js';
import { getNetif } from '$lib/stores/websocket-store.svelte';
import type { NetifMessage } from '$lib/types/socket-messages';
import { cn } from '$lib/utils';

// Svelte 5: Use $derived with reactive getter
const currentNetwoks = $derived(getNetif() ?? ({} as NetifMessage));
const totalBandwith = $derived(getTotalBandwidth(getNetif()));

// Helper functions for better network categorization and display
function getNetworkIcon(
	name: string,
	enabled: boolean,
	hasError: boolean,
	isHotspot: boolean = false,
) {
	if (hasError && !isHotspot) return AlertCircle;
	if (name.startsWith('ww')) return Signal; // Modem/cellular
	if (name.startsWith('wl')) return Wifi; // WiFi
	return Network; // Ethernet/other
}

function getNetworkType(name: string, isHotspot: boolean = false) {
	if (isHotspot) return $LL.networking.types.hotspot();
	if (name.startsWith('ww')) return $LL.networking.types.cellular();
	if (name.startsWith('wl')) return $LL.networking.types.wifi();
	return $LL.networking.types.ethernet();
}

function isHotspotNetwork(name: string) {
	return name.includes('hotspot') || name.toLowerCase().includes('wlan1');
}

function getBandwidthColor(bandwidth: number) {
	if (bandwidth === 0) return 'text-muted-foreground';
	if (bandwidth < 1000) return 'text-amber-600 dark:text-amber-400';
	if (bandwidth < 5000) return 'text-blue-600 dark:text-blue-400';
	return 'text-emerald-600 dark:text-emerald-400';
}

function getNetworkPriority(name: string, enabled: boolean, isHotspot: boolean) {
	if (name.startsWith('ww')) {
		return enabled ? 1 : 5;
	}
	if (enabled) return isHotspot ? 2 : name.startsWith('wl') ? 3 : 4;
	return isHotspot ? 6 : name.startsWith('wl') ? 7 : 8;
}
</script>

<Card.Header>
	<Card.Title class="flex items-center gap-2">
		<ArrowUpDown class="h-5 w-5" />
		{$LL.network.summary.networkInfo()}
	</Card.Title>
	<Card.Description>
		{$LL.network.summary.networksActive({
			count: Object.keys(currentNetwoks).length,
			active: getUsedNetworks(currentNetwoks).length,
			total: totalBandwith,
		})}
	</Card.Description>
</Card.Header>
<Card.Content class="space-y-4">
	{#if Object.keys(currentNetwoks).length === 0}
		<!-- Empty State -->
		<div class="flex flex-col items-center justify-center space-y-3 py-8 text-center">
			<div class="bg-muted grid h-14 w-14 place-items-center rounded-xl">
				<Network class="text-muted-foreground h-7 w-7" />
			</div>
			<div class="space-y-1">
				<h3 class="font-medium">{$LL.network.emptyStates.noNetworksDetected()}</h3>
				<p class="text-muted-foreground text-sm">{$LL.network.emptyStates.noNetworkInterfaces()}</p>
			</div>
		</div>
	{:else}
		<!-- Network List - Responsive Grid -->
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
			{#each Object.entries(currentNetwoks).sort(([nameA, networkA], [nameB, networkB]) => {
				const isHotspotA = isHotspotNetwork(nameA);
				const isHotspotB = isHotspotNetwork(nameB);
				return getNetworkPriority(nameA, networkA.enabled, isHotspotA) - getNetworkPriority(nameB, networkB.enabled, isHotspotB);
			}) as [name, network]}
				{@const isHotspot = isHotspotNetwork(name)}
				{@const Icon = getNetworkIcon(name, network.enabled, !!network.error, isHotspot)}
				{@const bandwidth = convertBytesToKbids(network.tp)}
				{@const hasRealError = !!network.error && !isHotspot}

				<!-- Responsive Network Card -->
				<div
					class={cn(
						'bg-card flex h-full flex-col rounded-lg border transition-colors duration-200',
						network.enabled ? 'border-emerald-500/30' : 'border-border',
						isHotspot && !network.enabled ? 'border-blue-500/30' : '',
						hasRealError ? 'border-red-500/30' : '',
					)}
				>
					<!-- Status Bar at Top -->
					<div
						class={cn(
							'h-1 w-full bg-gradient-to-r',
							network.enabled
								? 'from-emerald-500 to-teal-600'
								: isHotspot
									? 'from-blue-500 to-indigo-600'
									: hasRealError
										? 'from-red-500 to-rose-600'
										: 'from-slate-400 to-slate-500',
						)}
					></div>

					<div class="flex flex-1 flex-col p-3">
						<!-- Header: Icon + Name + Status -->
						<div class="mb-2 flex items-start justify-between">
							<div class="flex min-w-0 flex-1 items-center gap-3">
								<!-- Icon Container -->
								<div
									class={cn(
										'grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg',
										network.enabled
											? 'bg-emerald-500'
											: isHotspot
												? 'bg-blue-500'
												: hasRealError
													? 'bg-red-500'
													: 'bg-slate-400',
									)}
								>
									<Icon class="h-4 w-4 text-white" />
								</div>

								<!-- Network Name and Type -->
								<div class="min-w-0 flex-1">
									<h3 class="truncate text-sm font-medium">
										{isHotspot ? networkRename(name) : networkRenameWithError(name, network.error)}
									</h3>
									<p class="text-muted-foreground text-xs">{getNetworkType(name, isHotspot)}</p>
								</div>
							</div>

							<!-- Status Badge -->
							<div
								class={cn(
									'inline-flex flex-shrink-0 items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
									network.enabled
										? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
										: isHotspot
											? 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
											: hasRealError
												? 'bg-red-500/10 text-red-700 dark:text-red-400'
												: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
								)}
							>
								{network.enabled
									? $LL.network.status.active()
									: isHotspot
										? $LL.network.status.ready()
										: $LL.network.status.inactive()}
							</div>
						</div>

						<!-- Details Grid -->
						<div class="mb-3 flex-1 space-y-1.5 text-sm">
							{#if name.startsWith('ww')}
								<div class="flex items-center justify-between">
									<span class="text-muted-foreground">{$LL.networking.labels.network()}</span>
									<span class="text-xs font-medium">{getModemNetworkName(name)}</span>
								</div>
							{/if}
							<div class="flex items-center justify-between">
								<span class="text-muted-foreground">{$LL.networking.labels.interface()}</span>
								<code class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{name}</code>
							</div>
							<div class="flex items-center justify-between">
								<span class="text-muted-foreground">{$LL.networking.labels.ipAddress()}</span>
								<code class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{network.ip}</code>
							</div>
							<div class="flex items-center justify-between">
								<span class="text-muted-foreground">{$LL.networking.labels.bandwidth()}</span>
								<span class={cn('font-mono text-xs font-bold', getBandwidthColor(bandwidth))}>
									{$LL.network.summary.totalBandwidth({ total: bandwidth })}
								</span>
							</div>
						</div>

						<!-- Bottom Controls and Error Messages -->
						<div class="space-y-3">
							<!-- Toggle Control (only for non-hotspot networks) -->
							{#if !isHotspot}
								<div class="flex justify-end">
									<Toggle
										class={cn(
											'h-auto px-3 py-1.5 transition-colors',
											network.enabled
												? 'data-[state=on]:border-emerald-600 data-[state=on]:bg-emerald-600 data-[state=on]:text-white'
												: '',
											hasRealError ? 'cursor-not-allowed opacity-50' : '',
										)}
										disabled={hasRealError}
										onPressedChange={async (value) => {
											try {
												await setNetif(name, network.ip, value);
											} catch (error) {
												console.error(`Failed to toggle network ${name}:`, error);
												network.enabled = !value;
											}
										}}
										size="sm"
										variant="outline"
										bind:pressed={network.enabled}
									>
										{#if network.enabled}
											<Check class="mr-1 h-3 w-3" />
											{$LL.network.status.active()}
										{:else}
											<X class="mr-1 h-3 w-3" />
											{$LL.network.status.inactive()}
										{/if}
									</Toggle>
								</div>
							{/if}

							<!-- Error Message -->
							{#if hasRealError}
								<div
									class="flex items-center gap-2 rounded-md bg-red-500/10 p-2 text-sm text-red-700 dark:text-red-400"
								>
									<AlertCircle class="h-4 w-4 flex-shrink-0" />
									<span>{$LL.network.errors.networkConnectionError()}</span>
								</div>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		</div>

		<!-- Summary Footer -->
		<div class="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
			<div
				class="text-muted-foreground flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:gap-4"
			>
				<span
					>{$LL.network.summary.activeNetworks({
						active: getUsedNetworks(currentNetwoks).length,
						total: Object.keys(currentNetwoks).length,
					})}</span
				>
				<span class="hidden sm:inline">•</span>
				<span>{getAvailableNetworks(currentNetwoks).length} {$LL.network.summary.available()}</span>
			</div>
			<div class="flex items-center gap-2">
				<span class="text-muted-foreground text-sm">{$LL.network.summary.availableBandwidth()}</span
				>
				<span class={cn('font-mono text-lg font-bold', getBandwidthColor(totalBandwith))}>
					{$LL.network.summary.totalBandwidth({ total: totalBandwith })}
				</span>
			</div>
		</div>
	{/if}
</Card.Content>
