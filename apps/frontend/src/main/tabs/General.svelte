<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import {
	Activity,
	AlertTriangle,
	CheckCircle,
	RadioTower,
	Server,
	ServerOff,
	SquareChartGantt,
	Thermometer,
} from '@lucide/svelte';
import { RefreshCw } from '@lucide/svelte';

import * as Card from '$lib/components/ui/card';
import SimpleAlertDialog from '$lib/components/ui/simple-alert-dialog.svelte';
import { getUsedNetworks } from '$lib/helpers/NetworkHelper';
import { installSoftwareUpdates } from '$lib/helpers/SystemHelper';
import {
	getConfig,
	getNetif,
	getSensorsStatus,
	getStatus,
} from '$lib/stores/websocket-store.svelte';
import { cn } from '$lib/utils';

import Networking from '../shared/Networking.svelte';

// Svelte 5: Use $derived with reactive getters
const currentStatus = $derived(getStatus());
const currentNetworks = $derived(getNetif());
const currentConfig = $derived(getConfig());
const sensors = $derived(
	getSensorsStatus() ? Object.entries(getSensorsStatus()!) : ([] as [string, string][]),
);

function formatConfigValue(
	value: string | number | undefined,
	fallback: string = $LL.general.notConfigured(),
) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	return value;
}

// Status color helpers
const streamingStatusColors = $derived.by(() => {
	if (currentStatus?.is_streaming) {
		return {
			bg: 'from-emerald-500 to-teal-600',
			text: 'text-emerald-600 dark:text-emerald-400',
			icon: 'text-emerald-500',
		};
	}
	return {
		bg: 'from-amber-500 to-orange-600',
		text: 'text-amber-600 dark:text-amber-400',
		icon: 'text-muted-foreground',
	};
});

const serverStatusColors = $derived.by(() => {
	if (currentConfig?.srtla_addr) {
		return {
			bg: 'from-emerald-500 to-teal-600',
			icon: 'text-emerald-500',
		};
	}
	return {
		bg: 'from-slate-400 to-slate-500',
		icon: 'text-muted-foreground',
	};
});

const updatesStatusColors = $derived.by(() => {
	const hasUpdates = (currentStatus?.available_updates?.package_count ?? 0) > 0;
	if (hasUpdates) {
		return {
			bg: 'from-amber-500 to-orange-600',
		};
	}
	return {
		bg: 'from-emerald-500 to-teal-600',
	};
});
</script>

<div class="flex-col md:flex">
	<div class="flex-1 space-y-4 p-4 pt-6 sm:p-8">
		<!-- Status Overview Cards -->
		<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
			<!-- System Status -->
			<Card.Root class="overflow-hidden border">
				<div class={cn('h-1 bg-gradient-to-r', streamingStatusColors.bg)}></div>
				<Card.Header class="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
					<Card.Title class="text-sm font-medium">{$LL.general.status()}</Card.Title>
					{#if currentStatus?.is_streaming}
						<CheckCircle class={cn('h-4 w-4', streamingStatusColors.icon)} />
					{:else}
						<RadioTower class={cn('h-4 w-4', streamingStatusColors.icon)} />
					{/if}
				</Card.Header>
				<Card.Content class="p-4 pt-0">
					<div class={cn('text-2xl font-bold', streamingStatusColors.text)}>
						{currentStatus?.is_streaming ? $LL.general.streaming() : $LL.general.offline()}
					</div>
					{#if currentNetworks && currentStatus?.is_streaming}
						<p class="text-muted-foreground mt-1 text-xs">
							{$LL.general.streamingMessage({
								usingNetworksCount: getUsedNetworks(currentNetworks).length,
								srtLatency: currentConfig?.srt_latency ?? 0,
							})}
						</p>
					{:else if !currentStatus?.is_streaming && !currentConfig?.srtla_addr}
						<p class="text-muted-foreground mt-1 text-xs">
							{$LL.general.pleaseConfigureServer()}
						</p>
					{/if}
				</Card.Content>
			</Card.Root>

			<!-- Server Configuration Status -->
			<Card.Root class="overflow-hidden border">
				<div class={cn('h-1 bg-gradient-to-r', serverStatusColors.bg)}></div>
				<Card.Header class="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
					<Card.Title class="text-sm font-medium">{$LL.general.relayServer()}</Card.Title>
					{#if currentConfig?.srtla_addr}
						<Server class={cn('h-4 w-4', serverStatusColors.icon)} />
					{:else}
						<ServerOff class={cn('h-4 w-4', serverStatusColors.icon)} />
					{/if}
				</Card.Header>
				<Card.Content class="p-4 pt-0">
					<div class="truncate text-2xl font-bold">
						{currentConfig?.srtla_addr ?? $LL.general.notConfigured()}
					</div>
					<p class="text-muted-foreground mt-1 text-xs">
						{currentConfig?.srtla_addr
							? `${$LL.general.port()}: ${currentConfig?.srtla_port}`
							: $LL.general.youHaventConfigured()}
					</p>
				</Card.Content>
			</Card.Root>

			<!-- System Updates -->
			<Card.Root class="overflow-hidden border">
				<div class={cn('h-1 bg-gradient-to-r', updatesStatusColors.bg)}></div>
				<Card.Header class="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
					<Card.Title class="text-sm font-medium">{$LL.general.updates()}</Card.Title>
					<RefreshCw class="text-muted-foreground h-4 w-4" />
				</Card.Header>
				<Card.Content class="flex items-center p-4 pt-0">
					<div class="flex-1">
						<div class="text-2xl font-bold">
							{#if currentStatus?.available_updates?.package_count === 0}
								{$LL.general.noUpdatesAvailable()}
							{:else}
								{currentStatus?.available_updates?.package_count}
								{currentStatus?.available_updates?.package_count === 1
									? $LL.general.package()
									: $LL.general.packages()}
							{/if}
						</div>
						<p class="text-muted-foreground mt-1 text-xs">
							{currentStatus?.available_updates?.download_size ?? '0 MB'}
						</p>
					</div>
					{#if currentStatus?.available_updates?.package_count && currentStatus?.available_updates?.package_count > 0}
						<SimpleAlertDialog
							buttonText={$LL.general.updateButton()}
							confirmButtonText={$LL.general.updateButton()}
							extraButtonClasses="ml-4 shrink-0 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white"
							onconfirm={installSoftwareUpdates}
						>
							{#snippet dialogTitle()}
								{$LL.general.areYouSure()}
							{/snippet}
							{#snippet description()}
								{$LL.general.updateConfirmation()}
							{/snippet}
						</SimpleAlertDialog>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>

		<!-- Main Dashboard Content -->
		<div class="grid gap-6 xl:grid-cols-5">
			<!-- Configuration Section -->
			<div class="xl:col-span-3">
				<Card.Root class="overflow-hidden border border-blue-500/30">
					<div class="h-1 bg-gradient-to-r from-blue-500 to-indigo-600"></div>
					<Card.Header class="p-4">
						<Card.Title class="flex items-center gap-2.5">
							<div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500">
								<SquareChartGantt class="h-4 w-4 text-white" />
							</div>
							<div>
								<span class="text-sm font-semibold">{$LL.general.configuration()}</span>
								<p class="text-muted-foreground text-xs font-normal">
									{$LL.general.serverAndAudio()}
								</p>
							</div>
						</Card.Title>
					</Card.Header>
					<Card.Content class="space-y-8 px-4 pt-0 pb-4">
						{#if currentConfig}
							<!-- Server Settings Grid -->
							<div class="grid gap-6 sm:grid-cols-2">
								<div class="space-y-4">
									<div class="flex items-center gap-2">
										<Server class="text-muted-foreground h-4 w-4" />
										<span class="text-sm font-medium">{$LL.general.serverSettings()}</span>
									</div>
									<div class="space-y-3 pl-6">
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-sm">{$LL.general.relayServer()}</span>
											<span class="font-mono text-sm"
												>{formatConfigValue(currentConfig.srtla_addr, '—')}</span
											>
										</div>
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-sm">{$LL.general.port()}</span>
											<span class="font-mono text-sm"
												>{formatConfigValue(currentConfig.srtla_port, '—')}</span
											>
										</div>
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-sm">{$LL.general.latency()}</span>
											<span class="font-mono text-sm">
												{formatConfigValue(
													currentConfig.srt_latency ? `${currentConfig.srt_latency}ms` : undefined,
													'—',
												)}
											</span>
										</div>
									</div>
								</div>

								<div class="space-y-4">
									<div class="flex items-center gap-2">
										<Activity class="text-muted-foreground h-4 w-4" />
										<span class="text-sm font-medium">{$LL.general.audioSettings()}</span>
									</div>
									<div class="space-y-3 pl-6">
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-sm">{$LL.general.maxBitrate()}</span>
											<span class="font-mono text-sm">
												{formatConfigValue(
													currentConfig.max_br ? `${currentConfig.max_br} Kbps` : undefined,
													'—',
												)}
											</span>
										</div>
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-sm">{$LL.general.audioDevice()}</span>
											<span class="font-mono text-sm"
												>{formatConfigValue(currentConfig.asrc, '—')}</span
											>
										</div>
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-sm">{$LL.general.audioCodec()}</span>
											<span class="font-mono text-sm uppercase"
												>{formatConfigValue(currentConfig.acodec, '—')}</span
											>
										</div>
									</div>
								</div>
							</div>
						{:else}
							<div class="flex flex-col items-center justify-center space-y-4 py-16 text-center">
								<div class="flex h-16 w-16 items-center justify-center rounded-lg bg-slate-500/10">
									<AlertTriangle class="text-muted-foreground h-8 w-8" />
								</div>
								<div class="space-y-2">
									<h3 class="font-medium">{$LL.general.configurationNotComplete()}</h3>
									<p class="text-muted-foreground max-w-sm text-sm">
										{$LL.general.pleaseConfigureServer()}
									</p>
								</div>
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
			</div>

			<!-- System Health Sidebar -->
			<div class="space-y-6 xl:col-span-2">
				<!-- Hardware Sensors -->
				{#if sensors.some(([name]) => name.toLowerCase().includes('soc') || name
							.toLowerCase()
							.includes('temp') || name.toLowerCase().includes('current') || name
							.toLowerCase()
							.includes('voltage'))}
					<Card.Root class="overflow-hidden border border-emerald-500/30">
						<div class="h-1 bg-gradient-to-r from-emerald-500 to-teal-600"></div>
						<Card.Header class="p-4">
							<Card.Title class="flex items-center gap-2.5">
								<div
									class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500"
								>
									<Thermometer class="h-4 w-4 text-white" />
								</div>
								<span class="text-sm font-semibold">{$LL.general.hardwareSensors()}</span>
							</Card.Title>
						</Card.Header>
						<Card.Content class="px-4 pt-0 pb-4">
							<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-3">
								{#each sensors.filter(([name]) => name.toLowerCase().includes('soc') || name
											.toLowerCase()
											.includes('temp') || name.toLowerCase().includes('current') || name
											.toLowerCase()
											.includes('voltage')) as [sensorName, sensorValue]}
									<div class="space-y-2 rounded-lg border bg-slate-50 p-3 dark:bg-slate-900/50">
										<div class="flex items-center justify-between">
											<span
												class="text-muted-foreground text-xs font-medium tracking-wide uppercase"
											>
												{sensorName}
											</span>
											<Activity class="text-muted-foreground h-3 w-3" />
										</div>
										<div class="font-mono text-lg font-bold">{sensorValue}</div>
									</div>
								{/each}
							</div>
						</Card.Content>
					</Card.Root>
				{/if}

				<!-- Stream Performance -->
				{#if sensors.some(([name]) => name.toLowerCase().includes('srt') || name
							.toLowerCase()
							.includes('rtmp'))}
					<Card.Root class="overflow-hidden border border-blue-500/30">
						<div class="h-1 bg-gradient-to-r from-blue-500 to-indigo-600"></div>
						<Card.Header class="p-4">
							<Card.Title class="flex items-center gap-2.5">
								<div
									class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500"
								>
									<RadioTower class="h-4 w-4 text-white" />
								</div>
								<span class="text-sm font-semibold">{$LL.general.streamPerformance()}</span>
							</Card.Title>
						</Card.Header>
						<Card.Content class="px-4 pt-0 pb-4">
							<div class="space-y-3">
								{#each sensors.filter(([name]) => name.toLowerCase().includes('srt') || name
											.toLowerCase()
											.includes('rtmp')) as [sensorName, sensorValue]}
									<div
										class="flex items-center justify-between rounded-lg border bg-slate-50 p-3 dark:bg-slate-900/50"
									>
										<div class="space-y-1">
											<span class="text-sm font-medium">{sensorName}</span>
											<div class="text-muted-foreground text-xs">{$LL.general.liveMetrics()}</div>
										</div>
										<div class="text-right">
											<div class="font-mono text-sm font-medium">
												{sensorValue || $LL.general.notAvailable()}
											</div>
										</div>
									</div>
								{/each}
							</div>
						</Card.Content>
					</Card.Root>
				{/if}

				<!-- Empty State for System Health -->
				{#if sensors.length === 0}
					<Card.Root class="overflow-hidden border">
						<div class="h-1 bg-gradient-to-r from-slate-400 to-slate-500"></div>
						<Card.Header class="p-4">
							<Card.Title class="flex items-center gap-2.5">
								<div
									class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-400"
								>
									<Activity class="h-4 w-4 text-white" />
								</div>
								<span class="text-sm font-semibold">{$LL.general.systemHealth()}</span>
							</Card.Title>
						</Card.Header>
						<Card.Content class="px-4 pt-0 pb-4">
							<div class="flex flex-col items-center justify-center space-y-4 py-12 text-center">
								<div class="flex h-16 w-16 items-center justify-center rounded-lg bg-slate-500/10">
									<Activity class="text-muted-foreground h-8 w-8" />
								</div>
								<div class="space-y-2">
									<h3 class="font-medium">{$LL.general.noSensorData()}</h3>
									<p class="text-muted-foreground text-sm">{$LL.general.sensorsUnavailable()}</p>
								</div>
							</div>
						</Card.Content>
					</Card.Root>
				{/if}
			</div>
		</div>

		<!-- Network Information - Full Width -->
		<Card.Root>
			<Networking />
		</Card.Root>
	</div>
</div>
