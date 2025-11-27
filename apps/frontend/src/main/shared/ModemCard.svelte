<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import {
	Activity,
	ChevronDown,
	Globe,
	Loader2,
	Radio,
	Settings2,
	Signal,
	WifiOff,
} from '@lucide/svelte';
import { slide } from 'svelte/transition';

import SignalQuality from '$lib/components/icons/SignalQuality.svelte';
import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import * as Collapsible from '$lib/components/ui/collapsible';
import type { StatusMessage } from '$lib/types/socket-messages';
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
const operatorName = $derived(modem.status?.operator ?? '');

// Signal strength categorization
const signalCategory = $derived.by(() => {
	if (signalValue >= 75) return 'excellent';
	if (signalValue >= 50) return 'good';
	if (signalValue >= 25) return 'fair';
	return 'weak';
});

// Status helpers
const isConnected = $derived(connectionStatus === 'connected');
const isConnecting = $derived(connectionStatus === 'connecting');
const isScanning = $derived(connectionStatus === 'scanning');
const isDisconnected = $derived(connectionStatus === 'disconnected');

// Color schemes based on status
const statusColors = $derived.by(() => {
	if (isConnected) {
		return {
			bg: 'from-emerald-500 to-teal-600',
			bgLight: 'from-emerald-50 to-teal-50 dark:from-emerald-950/40 dark:to-teal-950/40',
			border: 'border-emerald-200 dark:border-emerald-800',
			text: 'text-emerald-700 dark:text-emerald-400',
			badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
		};
	}
	if (isConnecting) {
		return {
			bg: 'from-blue-500 to-indigo-600',
			bgLight: 'from-blue-50 to-indigo-50 dark:from-blue-950/40 dark:to-indigo-950/40',
			border: 'border-blue-200 dark:border-blue-800',
			text: 'text-blue-700 dark:text-blue-400',
			badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
		};
	}
	if (isScanning) {
		return {
			bg: 'from-amber-500 to-orange-600',
			bgLight: 'from-amber-50 to-orange-50 dark:from-amber-950/40 dark:to-orange-950/40',
			border: 'border-amber-200 dark:border-amber-800',
			text: 'text-amber-700 dark:text-amber-400',
			badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
		};
	}
	return {
		bg: 'from-slate-400 to-slate-500',
		bgLight: 'from-slate-50 to-slate-100 dark:from-slate-900/40 dark:to-slate-800/40',
		border: 'border-slate-200 dark:border-slate-700',
		text: 'text-slate-600 dark:text-slate-400',
		badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-400',
	};
});

// Signal color based on strength
const signalColors = $derived.by(() => {
	if (signalCategory === 'excellent')
		return {
			text: 'text-emerald-600 dark:text-emerald-400',
			bg: 'bg-emerald-500',
		};
	if (signalCategory === 'good')
		return {
			text: 'text-green-600 dark:text-green-400',
			bg: 'bg-green-500',
		};
	if (signalCategory === 'fair')
		return {
			text: 'text-amber-600 dark:text-amber-400',
			bg: 'bg-amber-500',
		};
	return {
		text: 'text-red-600 dark:text-red-400',
		bg: 'bg-red-500',
	};
});

// Get network type badge color
function getNetworkTypeBadge(type: string) {
	if (type.includes('5G'))
		return 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400';
	if (type.includes('LTE') || type.includes('4G'))
		return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400';
	if (type.includes('3G'))
		return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400';
	return 'bg-slate-100 text-slate-700 dark:bg-slate-800/40 dark:text-slate-400';
}

// Clean modem name
const cleanModemName = $derived(modem.name.replace('| Unknown', '').trim());
</script>

<Card.Root
	class={cn(
		'group relative overflow-hidden rounded-2xl border-2 transition-all duration-300 hover:shadow-lg',
		statusColors.border,
		`bg-gradient-to-br ${statusColors.bgLight}`,
	)}
>
	<!-- Top Status Bar -->
	<div class={cn('h-1.5 w-full bg-gradient-to-r', statusColors.bg)}></div>

	<Card.Header class="pt-4 pb-2">
		<div class="flex items-start justify-between gap-3">
			<!-- Left: Icon + Info -->
			<div class="flex items-center gap-3">
				<!-- Modem Icon -->
				<div class="relative">
					<div
						class={cn(
							'flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br shadow-lg',
							statusColors.bg,
						)}
					>
						{#if isConnected}
							<Signal class="h-6 w-6 text-white" />
						{:else if isConnecting || isScanning}
							<Loader2 class="h-6 w-6 animate-spin text-white" />
						{:else}
							<WifiOff class="h-6 w-6 text-white" />
						{/if}
					</div>

					<!-- Signal indicator dot -->
					{#if isConnected}
						<div
							class={cn(
								'absolute -right-1 -bottom-1 h-4 w-4 rounded-full border-2 border-white dark:border-slate-900',
								signalColors.bg,
							)}
						></div>
					{/if}
				</div>

				<!-- Name & Status -->
				<div class="min-w-0">
					<Card.Title class="truncate text-base font-bold">
						{cleanModemName}
					</Card.Title>
					<div class="mt-1 flex flex-wrap items-center gap-2">
						<!-- Status Badge -->
						<span
							class={cn(
								'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold',
								statusColors.badge,
							)}
						>
							{#if isConnecting}
								<Loader2 class="h-3 w-3 animate-spin" />
							{:else if isScanning}
								<Radio class="h-3 w-3 animate-pulse" />
							{/if}
							{capitalizeFirstLetter(
								$LL.network.modem.connectionStatus[
									connectionStatus as keyof typeof $LL.network.modem.connectionStatus
								](),
							)}
						</span>

						<!-- Network Type Badge -->
						{#if networkType && isConnected}
							<span
								class={cn(
									'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold',
									getNetworkTypeBadge(networkType),
								)}
							>
								{networkType}
							</span>
						{/if}
					</div>
				</div>
			</div>

			<!-- Right: Signal Indicator -->
			{#if isConnected}
				<div class="flex flex-col items-end gap-1">
					<div class="flex items-center gap-2">
						<SignalQuality class="h-6 w-6" signal={signalValue} />
						<span class={cn('font-mono text-xl font-bold', signalColors.text)}>
							{signalValue}%
						</span>
					</div>
					<span class="text-muted-foreground text-xs font-medium">
						{signalCategory === 'excellent'
							? 'Excellent'
							: signalCategory === 'good'
								? 'Good'
								: signalCategory === 'fair'
									? 'Fair'
									: 'Weak'}
					</span>
				</div>
			{/if}
		</div>
	</Card.Header>

	<Card.Content class="space-y-4 pt-2">
		<!-- Connection Info Grid (when connected) -->
		{#if isConnected && (operatorName || networkType)}
			<div
				class="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-white/50 p-3 dark:border-slate-700 dark:bg-slate-800/30"
			>
				{#if operatorName}
					<div class="flex items-center gap-2">
						<div class="rounded-lg bg-slate-100 p-1.5 dark:bg-slate-700">
							<Globe class="text-muted-foreground h-4 w-4" />
						</div>
						<div class="min-w-0">
							<p class="text-muted-foreground text-xs">Operator</p>
							<p class="text-foreground truncate text-sm font-semibold">{operatorName}</p>
						</div>
					</div>
				{/if}

				<div class="flex items-center gap-2">
					<div class="rounded-lg bg-slate-100 p-1.5 dark:bg-slate-700">
						<Activity class="text-muted-foreground h-4 w-4" />
					</div>
					<div class="min-w-0">
						<p class="text-muted-foreground text-xs">{$LL.network.modem.signal()}</p>
						<p class={cn('text-sm font-semibold', signalColors.text)}>{signalValue} dBm</p>
					</div>
				</div>
			</div>
		{/if}

		<!-- Status Messages for non-connected states -->
		{#if isScanning}
			<div
				class="flex items-center justify-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30"
			>
				<div class="flex gap-1">
					<div
						class="h-2 w-2 animate-bounce rounded-full bg-amber-500 [animation-delay:-0.3s]"
					></div>
					<div
						class="h-2 w-2 animate-bounce rounded-full bg-amber-500 [animation-delay:-0.15s]"
					></div>
					<div class="h-2 w-2 animate-bounce rounded-full bg-amber-500"></div>
				</div>
				<span class="text-sm font-medium text-amber-700 dark:text-amber-400">
					{$LL.network.status.scanningNetworks()}
				</span>
			</div>
		{:else if isConnecting}
			<div
				class="flex items-center justify-center gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/30"
			>
				<Loader2 class="h-5 w-5 animate-spin text-blue-600 dark:text-blue-400" />
				<span class="text-sm font-medium text-blue-700 dark:text-blue-400">
					{$LL.network.status.connecting()}
				</span>
			</div>
		{:else if isDisconnected}
			<div
				class="flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/30"
			>
				<div class="rounded-full bg-slate-200 p-3 dark:bg-slate-700">
					<WifiOff class="text-muted-foreground h-6 w-6" />
				</div>
				<p class="text-muted-foreground text-sm font-medium">
					{$LL.network.status.notConnected()}
				</p>
			</div>
		{/if}

		<!-- Collapsible Configuration -->
		<Collapsible.Root bind:open={configOpen}>
			<Collapsible.Trigger asChild>
				{#snippet child({ props })}
					<Button
						{...props}
						class={cn(
							'w-full justify-between rounded-xl border-2 transition-all',
							configOpen
								? 'border-slate-300 bg-slate-100 dark:border-slate-600 dark:bg-slate-800'
								: 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50 dark:hover:border-slate-600 dark:hover:bg-slate-800',
						)}
						variant="outline"
					>
						<span class="flex items-center gap-2">
							<Settings2 class="h-4 w-4" />
							<span class="font-medium">{$LL.network.modem.configuration()}</span>
						</span>
						<ChevronDown
							class={cn('h-4 w-4 transition-transform duration-200', configOpen && 'rotate-180')}
						/>
					</Button>
				{/snippet}
			</Collapsible.Trigger>

			<Collapsible.Content>
				<div
					class="mt-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/50"
					transition:slide={{ duration: 200 }}
				>
					<ModemConfigurator {deviceId} {modem} modemIsScanning={isScanning} />
				</div>
			</Collapsible.Content>
		</Collapsible.Root>
	</Card.Content>
</Card.Root>
