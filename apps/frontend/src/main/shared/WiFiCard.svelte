<script lang="ts">
import { EyeIcon, Router, Wifi, WifiOff } from '@lucide/svelte';
import { LL } from "@ceraui/i18n/svelte";

import WifiQuality from '$lib/components/icons/WifiQuality.svelte';
import * as Card from '$lib/components/ui/card';
import SimpleAlertDialog from '$lib/components/ui/simple-alert-dialog.svelte';
import { Skeleton } from '$lib/components/ui/skeleton';
import {
	generateWifiQr,
	getConnection,
	getWifiBand,
	getWifiStatus,
	networkRename,
	turnHotspotModeOff,
	turnHotspotModeOn,
} from '$lib/helpers/NetworkHelper';
import type { StatusMessage } from '$lib/types/socket-messages';
import { capitalizeFirstLetter, cn } from '$lib/utils.js';

import HotspotConfigurator from './HotspotConfigurator.svelte';
import WifiSelector from './WifiSelector.svelte';

interface Props {
	wifi: StatusMessage['wifi'][keyof StatusMessage['wifi']];
	deviceId: number;
}

const { wifi, deviceId }: Props = $props();

const wifiStatus = $derived(getWifiStatus(wifi));
const connection = $derived(getConnection(wifi));
const isHotspot = $derived(!!wifi.hotspot);

function getStatusColor(status: string, isHotspot: boolean) {
	if (isHotspot) return 'text-blue-600 dark:text-blue-400';
	if (status === 'connected') return 'text-green-600 dark:text-green-400';
	if (status === 'disconnected') return 'text-amber-600 dark:text-amber-400';
	return 'text-muted-foreground';
}

function getCardBorderClass(status: string, isHotspot: boolean) {
	if (isHotspot)
		return 'border-blue-500/20 bg-gradient-to-br from-blue-50/50 to-card dark:from-blue-950/20';
	if (status === 'connected')
		return 'border-green-500/20 bg-gradient-to-br from-green-50/50 to-card dark:from-green-950/20';
	return 'border-border bg-gradient-to-br from-card to-card/50';
}
</script>

<Card.Root
	class={cn(
		'group relative flex h-full flex-col transition-all duration-300 hover:scale-[1.02] hover:shadow-md',
		getCardBorderClass(wifiStatus, isHotspot),
	)}
>
	<!-- Status Indicator -->
	<div
		class={cn(
			'absolute top-0 left-0 h-1 w-full transition-all duration-300',
			isHotspot
				? 'bg-gradient-to-r from-blue-500 to-cyan-500'
				: wifiStatus === 'connected'
					? 'bg-gradient-to-r from-green-500 to-emerald-500'
					: 'bg-gradient-to-r from-amber-500 to-orange-500',
		)}
	></div>

	<Card.Header class="pb-3">
		<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<div class="flex items-center gap-3">
				<!-- Status Icon with Ring -->
				<div class="relative">
					<div
						class={cn(
							'rounded-full p-2 transition-colors',
							isHotspot
								? 'bg-blue-500/10'
								: wifiStatus === 'connected'
									? 'bg-green-500/10'
									: 'bg-amber-500/10',
						)}
					>
						{#if isHotspot}
							<Router class={cn('h-5 w-5', getStatusColor(wifiStatus, isHotspot))} />
						{:else}
							<Wifi class={cn('h-5 w-5', getStatusColor(wifiStatus, isHotspot))} />
						{/if}
					</div>
					<!-- Status dot -->
				</div>

				<div class="flex min-w-0 flex-1 flex-col gap-1">
					<Card.Title class="truncate text-sm font-semibold">
						{networkRename(wifi.ifname)}
					</Card.Title>
					<span
						class={cn(
							'inline-flex w-fit items-center rounded-full px-2 py-1 text-xs font-medium',
							isHotspot
								? 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
								: wifiStatus === 'connected'
									? 'bg-green-500/10 text-green-700 dark:text-green-300'
									: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
						)}
					>
						{capitalizeFirstLetter($LL.wifiStatus[wifiStatus as keyof typeof $LL.wifiStatus]())}
					</span>
				</div>
			</div>
		</div>
	</Card.Header>

	<Card.Content class="flex h-full flex-col">
		<!-- Connection Details - Flexible Content -->
		<div class="flex-1 space-y-3">
			{#if wifi.hotspot}
				<!-- Hotspot Details -->
				<div class="space-y-2">
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground font-medium">{$LL.network.hotspot.name()}</span>
						<span class="font-mono">{wifi.hotspot.name}</span>
					</div>
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground font-medium">{$LL.network.hotspot.channel()}</span>
						<span class="font-mono">{wifi.hotspot.channel}</span>
					</div>
				</div>
			{:else if connection}
				<!-- WiFi Connection Details -->
				<div class="space-y-2">
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground font-medium">{$LL.network.wifi.ssid()}</span>
						<span class="max-w-[120px] truncate font-mono">{connection.ssid}</span>
					</div>
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground font-medium">{$LL.network.wifi.strength()}</span>
						<div class="flex items-center gap-2">
							<WifiQuality signal={connection?.signal} />
							<span class="text-xs">{connection.signal}%</span>
						</div>
					</div>
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground font-medium">{$LL.network.wifi.security()}</span>
						<span class="font-mono text-xs">{connection.security}</span>
					</div>
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground font-medium">{$LL.network.wifi.band()}</span>
						<span class="font-mono text-xs">{getWifiBand(connection.freq)}</span>
					</div>
				</div>
			{:else}
				<!-- Disconnected State -->
				<div class="flex flex-col items-center justify-center space-y-2 py-4 text-center">
					<div class="bg-muted rounded-full p-3">
						<WifiOff class="text-muted-foreground h-6 w-6" />
					</div>
					<p class="text-muted-foreground text-sm">{$LL.network.status.noActiveConnection()}</p>
				</div>
			{/if}
		</div>

		<!-- All WiFi Configuration Buttons - Positioned at Bottom -->
		<div class="mt-auto flex flex-col gap-2 border-t pt-3">
			{#if wifi.hotspot}
				<!-- Hotspot Actions -->
				<HotspotConfigurator {deviceId} {wifi} />

				<div class="flex flex-col gap-2 sm:flex-row">
					<SimpleAlertDialog
						buttonText={$LL.network.status.details()}
						confirmButtonText={$LL.network.dialog.close()}
						extraButtonClasses="w-full sm:flex-1 bg-blue-600 hover:bg-blue-700 text-white"
						hideCancelButton={true}
						title={$LL.network.dialog.hotspotDetails()}
					>
						{#snippet icon()}
							<EyeIcon class="h-4 w-4" />
						{/snippet}
						{#snippet dialogTitle()}
							{$LL.network.dialog.hotspotDetails()}
						{/snippet}
						{#snippet description()}
							<div class="space-y-4 text-sm">
								{#if wifi.hotspot.name && wifi.hotspot.password}
									{#await generateWifiQr(wifi.hotspot.name, wifi.hotspot.password)}
										<div class="flex justify-center">
											<Skeleton class="h-40 w-40 rounded-md" />
										</div>
									{:then wifiQrCode}
										<div class="flex justify-center">
											<img
												class="dark:bg-background rounded-md border bg-white p-2 shadow-sm"
												alt={$LL.network.accessibility.wifiQrCode()}
												src={wifiQrCode}
											/>
										</div>
									{/await}
								{/if}
								<div class="space-y-1 text-center">
									<p>
										<span class="font-medium">{$LL.network.hotspot.name()}:</span>
										<span class="ml-1">{wifi.hotspot.name}</span>
									</p>
									<p>
										<span class="font-medium">{$LL.network.hotspot.password()}:</span>
										<span class="ml-1">{wifi.hotspot.password}</span>
									</p>
								</div>
							</div>
						{/snippet}
					</SimpleAlertDialog>

					<SimpleAlertDialog
						buttonText={$LL.network.status.turnOff()}
						confirmButtonText={$LL.network.dialog.turnOff()}
						extraButtonClasses="w-full sm:flex-1 bg-amber-600 hover:bg-amber-700 text-white"
						onconfirm={() => turnHotspotModeOff(deviceId)}
						title={$LL.network.dialog.turnHotspotOff()}
					>
						{#snippet icon()}
							<WifiOff class="h-4 w-4" />
						{/snippet}
						{#snippet dialogTitle()}
							{$LL.network.dialog.turnHotspotOff()}
						{/snippet}
						{#snippet description()}
							{$LL.network.dialog.turnHotspotOffDescription()}
						{/snippet}
					</SimpleAlertDialog>
				</div>
			{:else}
				<!-- WiFi Actions -->
				<WifiSelector {wifi} wifiId={deviceId} />

				<SimpleAlertDialog
					buttonText={$LL.network.status.enableHotspot()}
					confirmButtonText={$LL.network.dialog.turnOn()}
					extraButtonClasses="w-full bg-blue-600 hover:bg-blue-700 text-white"
					onconfirm={() => turnHotspotModeOn(deviceId)}
					title={$LL.network.dialog.turnHotspotOn()}
				>
					{#snippet icon()}
						<Router class="h-4 w-4" />
					{/snippet}
					{#snippet dialogTitle()}
						{$LL.network.dialog.turnHotspotOn()}
					{/snippet}
					{#snippet description()}
						{$LL.network.dialog.turnHotspotOnDescription()}
					{/snippet}
				</SimpleAlertDialog>
			{/if}
		</div>
	</Card.Content>
</Card.Root>
