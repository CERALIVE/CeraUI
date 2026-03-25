<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { NetifMessage } from '@ceraui/rpc/schemas';
import { AlertCircle, ArrowUpDown, Check, Network, Signal, Wifi, X } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

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
import { cn } from '$lib/utils';

// Svelte 5: Use $derived with reactive getter
const currentNetworks = $derived(getNetif() ?? ({} as NetifMessage));
const totalBandwidth = $derived(getTotalBandwidth(getNetif()));

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
	if (bandwidth < 1000) return 'text-status-warning';
	if (bandwidth < 5000) return 'text-status-info';
	return 'text-primary';
}

function getNetworkPriority(name: string, enabled: boolean, isHotspot: boolean) {
	if (name.startsWith('ww')) {
		return enabled ? 1 : 5;
	}
	if (enabled) return isHotspot ? 2 : name.startsWith('wl') ? 3 : 4;
	return isHotspot ? 6 : name.startsWith('wl') ? 7 : 8;
}
</script>

<Card.Header class="p-4">
	<Card.Title class="flex items-center gap-2">
		<ArrowUpDown class="text-muted-foreground h-5 w-5" />
		{$LL.network.summary.networkInfo()}
	</Card.Title>
	<Card.Description>
		{$LL.network.summary.networksActive({
			count: Object.keys(currentNetworks).length,
			active: getUsedNetworks(currentNetworks).length,
			total: totalBandwidth,
		})}
	</Card.Description>
</Card.Header>
<Card.Content class="space-y-4 px-4 pt-0 pb-4">
	{#if Object.keys(currentNetworks).length === 0}
		<!-- Empty State -->
		<div class="flex flex-col items-center justify-center space-y-3 py-8 text-center">
			<div class="bg-secondary grid h-14 w-14 place-items-center rounded-xl">
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
			{#each Object.entries(currentNetworks).sort(([nameA, networkA], [nameB, networkB]) => {
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
						'bg-card flex h-full flex-col overflow-hidden rounded-lg border transition-colors duration-200',
						network.enabled ? 'border-primary/30' : 'border-border',
						isHotspot && !network.enabled ? 'border-status-info/30' : '',
						hasRealError ? 'border-destructive/30' : '',
					)}
				>
					<div class="flex flex-1 flex-col p-3">
						<!-- Header: Icon + Name + Status -->
						<div class="mb-2 flex items-start justify-between">
							<div class="flex min-w-0 flex-1 items-center gap-3">
								<!-- Icon + status dot -->
								<div class="flex items-center gap-2.5">
									<div
										class={cn(
											'h-2 w-2 flex-shrink-0 rounded-full',
											network.enabled
												? 'bg-primary'
												: isHotspot
													? 'bg-status-info'
													: hasRealError
														? 'bg-destructive'
														: 'bg-muted-foreground/40',
										)}
									></div>
									<Icon class="text-muted-foreground h-4 w-4 flex-shrink-0" />
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
										? 'bg-primary/10 text-primary'
										: isHotspot
											? 'bg-status-info/10 text-status-info'
											: hasRealError
												? 'bg-destructive/10 text-destructive'
												: 'bg-secondary text-secondary-foreground',
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
												? 'data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground'
												: '',
											hasRealError ? 'cursor-not-allowed opacity-50' : '',
										)}
										disabled={hasRealError}
										onPressedChange={async (value) => {
											try {
												await setNetif(name, network.ip, value);
											} catch (error) {
												console.error(`Failed to toggle network ${name}:`, error);
												toast.error(
													$LL?.network?.errors?.toggleFailed?.() ||
														'Failed to toggle network',
												);
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
									role="alert"
									class="bg-destructive/10 text-destructive flex items-center gap-2 rounded-md p-2 text-sm"
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
						active: getUsedNetworks(currentNetworks).length,
						total: Object.keys(currentNetworks).length,
					})}</span
				>
				<span class="hidden sm:inline">•</span>
				<span>{getAvailableNetworks(currentNetworks).length} {$LL.network.summary.available()}</span>
			</div>
			<div class="flex items-center gap-2">
				<span class="text-muted-foreground text-sm">{$LL.network.summary.availableBandwidth()}</span
				>
				<span class={cn('font-mono text-lg font-bold', getBandwidthColor(totalBandwidth))}>
					{$LL.network.summary.totalBandwidth({ total: totalBandwidth })}
				</span>
			</div>
		</div>
	{/if}
</Card.Content>
