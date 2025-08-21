<script lang="ts">
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
import { _ } from 'svelte-i18n';

import * as Card from '$lib/components/ui/card';
import SimpleAlertDialog from '$lib/components/ui/simple-alert-dialog.svelte';
import { getUsedNetworks } from '$lib/helpers/NetworkHelper';
import { installSoftwareUpdates } from '$lib/helpers/SystemHelper';
import {
	ConfigMessages,
	NetifMessages,
	SensorsStatusMessages,
	StatusMessages,
} from '$lib/stores/websocket-store';
import type { ConfigMessage, NetifMessage, StatusMessage } from '$lib/types/socket-messages';
import { cn } from '$lib/utils';

import Networking from '../shared/Networking.svelte';

let sensors: Array<[string, string]> = $state([]);
let currentStatus: StatusMessage | undefined = $state(undefined);
let currentNetworks: NetifMessage | undefined = $state();
let currentConfig: ConfigMessage | undefined = $state();

NetifMessages.subscribe((networks: NetifMessage) => {
	currentNetworks = networks;
});

ConfigMessages.subscribe((config) => {
	currentConfig = config;
});

SensorsStatusMessages.subscribe((sensorData) => {
	if (sensorData) {
		sensors = Object.entries(sensorData);
	}
});

StatusMessages.subscribe((status) => {
	currentStatus = status;
});

function formatConfigValue(
	value: string | number | undefined,
	fallback: string = $_('general.notConfigured'),
) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	return value;
}

function getStatusColor(isStreaming: boolean) {
	return isStreaming ? 'text-green-500' : 'text-amber-500';
}

function getStatusIcon(isStreaming: boolean) {
	return isStreaming ? CheckCircle : AlertTriangle;
}
</script>

<div class=" flex-col md:flex">
	<div class="flex-1 space-y-4 p-8 pt-6">
		<!-- Status Overview Cards -->
		<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
			<!-- System Status -->
			<Card.Root class="relative overflow-hidden">
				<Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
					<Card.Title class="text-sm font-medium">{$_('general.status')}</Card.Title>
					{#if currentStatus?.is_streaming}
						{@const StatusIcon = getStatusIcon(currentStatus.is_streaming)}
						<StatusIcon class="h-4 w-4 text-green-500" />
					{:else}
						<RadioTower class="text-muted-foreground h-4 w-4" />
					{/if}
				</Card.Header>
				<Card.Content>
					<div
						class={cn(`${getStatusColor(currentStatus?.is_streaming ?? false)} text-2xl font-bold`)}
					>
						{currentStatus?.is_streaming ? $_('general.streaming') : $_('general.offline')}
					</div>
					{#if currentNetworks && currentStatus?.is_streaming}
						<p class="text-muted-foreground mt-1 text-xs">
							{$_('general.streamingMessage', {
								values: {
									usingNetworksCount: getUsedNetworks(currentNetworks).length,
									srtLatency: currentConfig?.srt_latency,
								},
							})}
						</p>
					{:else if !currentStatus?.is_streaming && !currentConfig?.srtla_addr}
						<p class="text-muted-foreground mt-1 text-xs">
							{$_('general.pleaseConfigureServer')}
						</p>
					{/if}
				</Card.Content>
				<!-- Status indicator line -->
				<div
					class={cn(
						'absolute bottom-0 left-0 h-1 w-full',
						currentStatus?.is_streaming ? 'bg-green-500' : 'bg-amber-500',
					)}
				></div>
			</Card.Root>

			<!-- Server Configuration Status -->
			<Card.Root class="relative overflow-hidden">
				<Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
					<Card.Title class="text-sm font-medium">{$_('general.relayServer')}</Card.Title>
					{#if currentConfig?.srtla_addr}
						<Server class="h-4 w-4 text-green-500" />
					{:else}
						<ServerOff class="text-muted-foreground h-4 w-4" />
					{/if}
				</Card.Header>
				<Card.Content>
					<div class="truncate text-2xl font-bold">
						{currentConfig?.srtla_addr ?? $_('general.notConfigured')}
					</div>
					<p class="text-muted-foreground mt-1 text-xs">
						{currentConfig?.srtla_addr
							? `${$_('general.port')}: ${currentConfig?.srtla_port}`
							: $_('general.youHaventConfigured')}
					</p>
				</Card.Content>
				<div
					class={cn(
						'absolute bottom-0 left-0 h-1 w-full',
						currentConfig?.srtla_addr ? 'bg-green-500' : 'bg-gray-300',
					)}
				></div>
			</Card.Root>

			<!-- System Updates -->
			<Card.Root class="relative overflow-hidden">
				<Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
					<Card.Title class="text-sm font-medium">{$_('general.updates')}</Card.Title>
					<RefreshCw class="text-muted-foreground h-4 w-4" />
				</Card.Header>
				<Card.Content class="flex items-center">
					<div class="flex-1">
						<div class="text-2xl font-bold">
							{#if currentStatus?.available_updates?.package_count === 0}
								{$_('general.noUpdatesAvailable')}
							{:else}
								{currentStatus?.available_updates?.package_count}
								{currentStatus?.available_updates?.package_count === 1
									? $_('general.package')
									: $_('general.packages')}
							{/if}
						</div>
						<p class="text-muted-foreground mt-1 text-xs">
							{currentStatus?.available_updates?.download_size ?? '0 MB'}
						</p>
					</div>
					{#if currentStatus?.available_updates?.package_count && currentStatus?.available_updates?.package_count > 0}
						<SimpleAlertDialog
							buttonText={$_('general.updateButton')}
							confirmButtonText={$_('general.updateButton')}
							extraButtonClasses="ml-4 shrink-0"
							onconfirm={installSoftwareUpdates}
						>
							{#snippet dialogTitle()}
								{$_('general.areYouSure')}
							{/snippet}
							{#snippet description()}
								{$_('general.updateConfirmation')}
							{/snippet}
						</SimpleAlertDialog>
					{/if}
				</Card.Content>
				<div
					class={cn(
						'absolute bottom-0 left-0 h-1 w-full',
						(currentStatus?.available_updates?.package_count ?? 0) > 0
							? 'bg-amber-500'
							: 'bg-green-500',
					)}
				></div>
			</Card.Root>
		</div>
		<!-- Main Dashboard Content -->
		<div class="grid gap-6 xl:grid-cols-5">
			<!-- Configuration Section -->
			<div class="xl:col-span-3">
				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2">
							<SquareChartGantt class="h-5 w-5" />
							{$_('general.configuration')}
						</Card.Title>
						<Card.Description>{$_('general.serverAndAudio')}</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-8">
						{#if currentConfig}
							<!-- Server Settings Grid -->
							<div class="grid gap-6 sm:grid-cols-2">
								<div class="space-y-4">
									<div class="flex items-center gap-2">
										<Server class="text-muted-foreground h-4 w-4" />
										<span class="text-sm font-medium">{$_('general.serverSettings')}</span>
									</div>
									<div class="space-y-3 pl-6">
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-sm">{$_('general.relayServer')}</span>
											<span class="font-mono text-sm"
												>{formatConfigValue(currentConfig.srtla_addr, '—')}</span
											>
										</div>
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-sm">{$_('general.port')}</span>
											<span class="font-mono text-sm"
												>{formatConfigValue(currentConfig.srtla_port, '—')}</span
											>
										</div>
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-sm">{$_('general.latency')}</span>
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
										<span class="text-sm font-medium">{$_('general.audioSettings')}</span>
									</div>
									<div class="space-y-3 pl-6">
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-sm">{$_('general.maxBitrate')}</span>
											<span class="font-mono text-sm">
												{formatConfigValue(
													currentConfig.max_br ? `${currentConfig.max_br} Kbps` : undefined,
													'—',
												)}
											</span>
										</div>
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-sm">{$_('general.audioDevice')}</span>
											<span class="font-mono text-sm"
												>{formatConfigValue(currentConfig.asrc, '—')}</span
											>
										</div>
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-sm">{$_('general.audioCodec')}</span>
											<span class="font-mono text-sm uppercase"
												>{formatConfigValue(currentConfig.acodec, '—')}</span
											>
										</div>
									</div>
								</div>
							</div>
						{:else}
							<div class="flex flex-col items-center justify-center space-y-4 py-16 text-center">
								<div class="bg-muted rounded-full p-4">
									<AlertTriangle class="text-muted-foreground h-8 w-8" />
								</div>
								<div class="space-y-2">
									<h3 class="font-medium">{$_('general.configurationNotComplete')}</h3>
									<p class="text-muted-foreground max-w-sm text-sm">
										{$_('general.pleaseConfigureServer')}
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
					<Card.Root>
						<Card.Header>
							<Card.Title class="flex items-center gap-2">
								<Thermometer class="h-5 w-5" />
								{$_('general.hardwareSensors')}
							</Card.Title>
						</Card.Header>
						<Card.Content>
							<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-3">
								{#each sensors.filter(([name]) => name.toLowerCase().includes('soc') || name
											.toLowerCase()
											.includes('temp') || name.toLowerCase().includes('current') || name
											.toLowerCase()
											.includes('voltage')) as [sensorName, sensorValue]}
									<div class="bg-card space-y-2 rounded-lg border p-3">
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
					<Card.Root>
						<Card.Header>
							<Card.Title class="flex items-center gap-2">
								<RadioTower class="h-5 w-5" />
								{$_('general.streamPerformance')}
							</Card.Title>
						</Card.Header>
						<Card.Content>
							<div class="space-y-3">
								{#each sensors.filter(([name]) => name.toLowerCase().includes('srt') || name
											.toLowerCase()
											.includes('rtmp')) as [sensorName, sensorValue]}
									<div
										class="border-border/50 flex items-center justify-between border-b py-2 last:border-0"
									>
										<div class="space-y-1">
											<span class="text-sm font-medium">{sensorName}</span>
											<div class="text-muted-foreground text-xs">{$_('general.liveMetrics')}</div>
										</div>
										<div class="text-right">
											<div class="font-mono text-sm font-medium">
												{sensorValue || $_('general.notAvailable')}
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
					<Card.Root>
						<Card.Header>
							<Card.Title class="flex items-center gap-2">
								<Activity class="h-5 w-5" />
								{$_('general.systemHealth')}
							</Card.Title>
						</Card.Header>
						<Card.Content>
							<div class="flex flex-col items-center justify-center space-y-4 py-12 text-center">
								<div class="bg-muted rounded-full p-4">
									<Activity class="text-muted-foreground h-8 w-8" />
								</div>
								<div class="space-y-2">
									<h3 class="font-medium">{$_('general.noSensorData')}</h3>
									<p class="text-muted-foreground text-sm">{$_('general.sensorsUnavailable')}</p>
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
