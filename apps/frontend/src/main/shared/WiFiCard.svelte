<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { StatusMessage } from '@ceraui/rpc/schemas';
import { EyeIcon, Router, Wifi, WifiOff } from '@lucide/svelte';

import SignalIndicator from '$lib/components/icons/SignalIndicator.svelte';
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
const isConnected = $derived(wifiStatus === 'connected');

// Status color scheme matching design system
const statusColors = $derived.by(() => {
	if (isHotspot) {
		return {
			bg: 'from-blue-500 to-indigo-600',
			border: 'border-blue-500/30',
			badge: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
			icon: 'bg-blue-500',
			text: 'text-blue-600 dark:text-blue-400',
		};
	}
	if (isConnected) {
		return {
			bg: 'from-emerald-500 to-teal-600',
			border: 'border-emerald-500/30',
			badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
			icon: 'bg-emerald-500',
			text: 'text-emerald-600 dark:text-emerald-400',
		};
	}
	// Disconnected
	return {
		bg: 'from-slate-400 to-slate-500',
		border: 'border-slate-300 dark:border-slate-700',
		badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
		icon: 'bg-slate-400',
		text: 'text-slate-600 dark:text-slate-400',
	};
});

// Band badge color
function getBandBadge(freq: number) {
	const band = getWifiBand(freq);
	if (band.includes('5')) return 'bg-purple-500/10 text-purple-700 dark:text-purple-400';
	if (band.includes('6')) return 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400';
	return 'bg-slate-500/10 text-slate-600 dark:text-slate-400';
}
</script>

<Card.Root class={cn('gap-0 overflow-hidden border py-0', statusColors.border)}>
	<!-- Status Bar -->
	<div class={cn('h-1 bg-gradient-to-r', statusColors.bg)}></div>

	<Card.Header class="p-4 pb-3">
		<!-- Header Row -->
		<div class="flex items-center justify-between gap-2">
			<div class="flex min-w-0 items-center gap-2.5">
				<!-- Icon Container -->
				<div class={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', statusColors.icon)}>
					{#if isHotspot}
						<Router class="h-4 w-4 text-white" />
					{:else}
						<Wifi class="h-4 w-4 text-white" />
					{/if}
				</div>

				<!-- Name & Status -->
				<div class="min-w-0 flex-1">
					<Card.Title class="truncate text-sm font-semibold">
						{networkRename(wifi.ifname)}
					</Card.Title>
					<div class="mt-0.5 flex flex-wrap items-center gap-1.5">
						<span class={cn('rounded-md px-1.5 py-0.5 text-xs font-medium', statusColors.badge)}>
							{capitalizeFirstLetter($LL.wifiStatus[wifiStatus as keyof typeof $LL.wifiStatus]())}
						</span>
						{#if connection && isConnected}
							<span
								class={cn(
									'rounded-md px-1.5 py-0.5 text-xs font-bold',
									getBandBadge(connection.freq),
								)}
							>
								{getWifiBand(connection.freq)}
							</span>
						{/if}
					</div>
				</div>
			</div>

			<!-- Signal Strength - Vertically centered -->
			{#if connection && isConnected}
				<SignalIndicator class="h-9" signal={connection.signal} type="wifi" />
			{/if}
		</div>
	</Card.Header>

	<Card.Content class="space-y-3 px-4 pt-0 pb-4">
		<!-- Connection Details -->
		{#if wifi.hotspot}
			<!-- Hotspot Details -->
			<div class="space-y-2">
				<div class="flex items-center justify-between text-sm">
					<span class="text-muted-foreground font-medium">{$LL.network.hotspot.name()}</span>
					<span class="max-w-[140px] truncate font-mono">{wifi.hotspot.name}</span>
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
					<span class="max-w-[140px] truncate font-mono">{connection.ssid}</span>
				</div>
				<div class="flex items-center justify-between text-sm">
					<span class="text-muted-foreground font-medium">{$LL.network.wifi.security()}</span>
					<span class="font-mono text-xs">{connection.security}</span>
				</div>
			</div>
		{:else}
			<!-- Disconnected State -->
			<div class="flex items-center justify-center gap-2 rounded-lg bg-slate-500/10 py-3">
				<WifiOff class="text-muted-foreground h-4 w-4" />
				<span class="text-muted-foreground text-sm">{$LL.network.status.noActiveConnection()}</span>
			</div>
		{/if}

		<!-- Actions -->
		<div class="flex flex-col gap-2 border-t pt-3">
			{#if wifi.hotspot}
				<!-- Hotspot Actions -->
				<HotspotConfigurator {deviceId} {wifi} />

				<div class="flex flex-col gap-2 sm:flex-row">
					<SimpleAlertDialog
						buttonText={$LL.network.status.details()}
						confirmButtonText={$LL.network.dialog.close()}
						extraButtonClasses="w-full sm:flex-1 bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white"
						hiddeCancelButton={true}
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
								{#if wifi.hotspot?.name && wifi.hotspot?.password}
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
										<span class="ml-1">{wifi.hotspot?.name}</span>
									</p>
									<p>
										<span class="font-medium">{$LL.network.hotspot.password()}:</span>
										<span class="ml-1">{wifi.hotspot?.password}</span>
									</p>
								</div>
							</div>
						{/snippet}
					</SimpleAlertDialog>

					<SimpleAlertDialog
						buttonText={$LL.network.status.turnOff()}
						confirmButtonText={$LL.network.dialog.turnOff()}
						extraButtonClasses="w-full sm:flex-1 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white"
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
					extraButtonClasses="w-full bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white"
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
