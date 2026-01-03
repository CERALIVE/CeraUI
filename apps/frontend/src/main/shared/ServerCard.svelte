<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { RelayMessage } from '@ceraui/rpc/schemas';
import { Server } from '@lucide/svelte';

import * as Card from '$lib/components/ui/card';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { cn } from '$lib/utils';

interface Props {
	relayMessage: RelayMessage | undefined;
	properties: {
		relayServer: string | undefined;
		relayAccount: string | undefined;
		srtlaServerAddress: string | undefined;
		srtlaServerPort: number | undefined;
		srtStreamId: string | undefined;
		srtLatency: number | undefined;
	};
	formErrors: Record<string, string>;
	isStreaming: boolean;
	onRelayServerChange: (value: string) => void;
	onRelayAccountChange: (value: string) => void;
	onSrtlaAddressChange: (value: string) => void;
	onSrtlaPortChange: (value: number | undefined) => void;
	onSrtStreamIdChange: (value: string) => void;
	onSrtLatencyChange: (value: number) => void;
	normalizeValue: (value: number, min: number, max: number, step?: number) => number;
}

const {
	relayMessage,
	properties,
	formErrors,
	isStreaming,
	onRelayServerChange,
	onRelayAccountChange,
	onSrtlaAddressChange,
	onSrtlaPortChange,
	onSrtStreamIdChange,
	onSrtLatencyChange,
	normalizeValue,
}: Props = $props();

// Local state for all fields to prevent binding undefined values
let localSrtlaServerAddress = $state(properties.srtlaServerAddress ?? '');
let localSrtlaServerPort = $state(properties.srtlaServerPort?.toString() ?? '');
let localSrtStreamId = $state(properties.srtStreamId ?? '');
let localSrtLatency = $state(properties.srtLatency ?? 2000);
let localRelayServer = $state(properties.relayServer ?? '');
let localRelayAccount = $state(properties.relayAccount ?? '');

// Track if user has touched each field
let addressTouched = $state(false);
let portTouched = $state(false);
let streamIdTouched = $state(false);
let relayServerTouched = $state(false);
let relayAccountTouched = $state(false);

// Sync FROM properties TO local state when parent provides new data
$effect(() => {
	if (!addressTouched) localSrtlaServerAddress = properties.srtlaServerAddress ?? '';
});

$effect(() => {
	if (!portTouched) localSrtlaServerPort = properties.srtlaServerPort?.toString() ?? '';
});

$effect(() => {
	if (!streamIdTouched) localSrtStreamId = properties.srtStreamId ?? '';
});

$effect(() => {
	if (!relayServerTouched) localRelayServer = properties.relayServer ?? '';
});

$effect(() => {
	if (!relayAccountTouched) localRelayAccount = properties.relayAccount ?? '';
});

$effect(() => {
	localSrtLatency = properties.srtLatency ?? 2000;
});

const isManualConfig = $derived(
	localRelayServer === '-1' || localRelayServer === undefined || localRelayServer === '',
);
const isManualAccount = $derived(
	localRelayAccount === '-1' || localRelayAccount === undefined || localRelayAccount === '',
);

// Status colors based on configuration state
const statusColors = $derived.by(() => {
	if (isManualConfig) {
		return {
			bg: 'from-amber-500 to-orange-600',
			border: 'border-amber-500/30',
			icon: 'bg-amber-500',
		};
	}
	return {
		bg: 'from-blue-500 to-indigo-600',
		border: 'border-blue-500/30',
		icon: 'bg-blue-500',
	};
});
</script>

<Card.Root
	class={cn('flex h-full flex-col gap-0 overflow-hidden border py-0', statusColors.border)}
>
	<!-- Status Bar -->
	<div class={cn('h-1 bg-gradient-to-r', statusColors.bg)}></div>

	<Card.Header class="p-4 pb-3">
		<div class="flex items-center gap-2.5">
			<div class={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', statusColors.icon)}>
				<Server class="h-4 w-4 text-white" />
			</div>
			<Card.Title class="text-sm font-semibold">{$LL.settings.receiverServer()}</Card.Title>
		</div>
	</Card.Header>

	<Card.Content class="flex-1 space-y-4 px-4 pt-0 pb-4">
		<!-- Relay Server Selection -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="relayServer">{$LL.settings.relayServer()}</Label>
			<Select.Root
				disabled={relayMessage === undefined || isStreaming}
				onValueChange={(value) => {
					localRelayServer = value;
					relayServerTouched = true;
					onRelayServerChange(value);
				}}
				type="single"
				value={localRelayServer}
			>
				<Select.Trigger id="relayServer" class="w-full">
					{localRelayServer !== undefined && localRelayServer !== '-1' && relayMessage?.servers
						? (Object.entries(relayMessage.servers).find(
								(server) => server[0] === localRelayServer,
							)?.[1]?.name ?? $LL.settings.manualConfiguration())
						: $LL.settings.manualConfiguration()}
				</Select.Trigger>
				<Select.Content>
					<Select.Group>
						<Select.Item value="-1">
							<div class="flex items-center gap-2">
								<div class="h-2 w-2 rounded-full bg-amber-500"></div>
								{$LL.settings.manualConfiguration()}
							</div>
						</Select.Item>
						{#if relayMessage?.servers}
							{#each Object.entries(relayMessage?.servers) as [server, serverInfo]}
								<Select.Item value={server}>
									<div class="flex items-center gap-2">
										<div class="h-2 w-2 rounded-full bg-emerald-500"></div>
										{serverInfo.name}
									</div>
								</Select.Item>
							{/each}
						{/if}
					</Select.Group>
				</Select.Content>
			</Select.Root>
			{#if formErrors.relayServer}
				<p class="text-destructive text-sm">{formErrors.relayServer}</p>
			{/if}
		</div>

		{#if isManualConfig}
			<!-- Manual Server Configuration -->
			<div class="space-y-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
				<div class="mb-3 flex items-center space-x-2">
					<div class="h-2 w-2 rounded-full bg-amber-500"></div>
					<h4 class="text-sm font-medium text-amber-700 dark:text-amber-400">
						{$LL.settings.manualServerConfiguration()}
					</h4>
				</div>

				<div class="space-y-2">
					<Label class="text-sm font-medium" for="srtlaServerAddress">
						{$LL.settings.srtlaServerAddress()}
					</Label>
					<Input
						id="srtlaServerAddress"
						class="font-mono"
						disabled={isStreaming}
						oninput={() => {
							addressTouched = true;
							onSrtlaAddressChange(localSrtlaServerAddress);
						}}
						placeholder={$LL.settings.placeholders.srtlaServerAddress()}
						bind:value={localSrtlaServerAddress}
					/>
					{#if formErrors.srtlaServerAddress}
						<p class="text-destructive text-sm">{formErrors.srtlaServerAddress}</p>
					{/if}
				</div>

				<div class="space-y-2">
					<Label class="text-sm font-medium" for="srtlaServerPort">
						{$LL.settings.srtlaServerPort()}
					</Label>
					<Input
						id="srtlaServerPort"
						class="font-mono"
						disabled={isStreaming}
						oninput={() => {
							portTouched = true;
							const value = (localSrtlaServerPort || '').toString().trim();
							if (value === '') {
								onSrtlaPortChange(undefined);
							} else {
								const parsedValue = parseInt(value, 10);
								if (Number.isInteger(parsedValue) && parsedValue > 0 && parsedValue <= 65535) {
									onSrtlaPortChange(parsedValue);
								} else {
									onSrtlaPortChange(undefined);
								}
							}
						}}
						placeholder={$LL.settings.placeholders.srtlaServerPort()}
						type="number"
						bind:value={localSrtlaServerPort}
					/>
					{#if formErrors.srtlaServerPort}
						<p class="text-destructive text-sm">{formErrors.srtlaServerPort}</p>
					{/if}
				</div>
			</div>
		{:else}
			<!-- Relay Account Selection -->
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="relayServerAccount">
					{$LL.settings.relayServerAccount()}
				</Label>
				<Select.Root
					disabled={relayMessage === undefined || isStreaming}
					onValueChange={(value) => {
						localRelayAccount = value;
						relayAccountTouched = true;
						onRelayAccountChange(value);
					}}
					type="single"
					value={localRelayAccount}
				>
					<Select.Trigger id="relayServerAccount" class="w-full">
						{localRelayAccount === undefined ||
						localRelayAccount === '-1' ||
						relayMessage?.accounts === undefined
							? $LL.settings.manualConfiguration()
							: relayMessage.accounts[localRelayAccount].name}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							<Select.Item value="-1">
								<div class="flex items-center gap-2">
									<div class="h-2 w-2 rounded-full bg-amber-500"></div>
									{$LL.settings.manualConfiguration()}
								</div>
							</Select.Item>
							{#if relayMessage?.accounts}
								{#each Object.entries(relayMessage?.accounts) as [account, accountInfo]}
									<Select.Item value={account}>
										<div class="flex items-center gap-2">
											<div class="h-2 w-2 rounded-full bg-emerald-500"></div>
											{accountInfo.name}
										</div>
									</Select.Item>
								{/each}
							{/if}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</div>
		{/if}

		<!-- SRT Stream ID (for manual account configuration) -->
		{#if isManualAccount}
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="srtStreamId">
					{$LL.settings.srtStreamId()}
					<span class="text-muted-foreground ml-1 text-xs">({$LL.settings.optional()})</span>
				</Label>
				<Input
					id="srtStreamId"
					class="font-mono"
					disabled={isStreaming}
					oninput={() => {
						streamIdTouched = true;
						onSrtStreamIdChange(localSrtStreamId);
					}}
					placeholder={$LL.settings.placeholders.srtStreamId()}
					bind:value={localSrtStreamId}
				/>
			</div>
		{/if}

		<!-- SRT Latency Control -->
		<div class="space-y-3 rounded-lg border bg-slate-50 p-4 dark:bg-slate-900/50">
			<Label class="flex items-center gap-2 text-sm font-medium" for="srtLatency">
				{$LL.settings.srtLatency()}
				<span class="rounded-md bg-blue-500/10 px-2 py-1 text-xs text-blue-700 dark:text-blue-400">
					{localSrtLatency || 2000}ms
				</span>
			</Label>
			<!-- Custom slider with visual progress -->
			<div class="relative h-6 w-full">
				<!-- Track Background -->
				<div
					class="absolute inset-y-0 top-1/2 right-0 left-0 h-2 -translate-y-1/2 rounded-full bg-slate-200 dark:bg-slate-700"
				></div>
				<!-- Progress Fill -->
				<div
					style={`width: ${(() => {
						const safeLatency = isFinite(localSrtLatency) ? localSrtLatency : 2000;
						const percentage = ((safeLatency - 2000) / (12000 - 2000)) * 100;
						return isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0;
					})()}%;`}
					class="absolute top-1/2 left-0 h-2 -translate-y-1/2 rounded-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all duration-200"
				></div>
				<!-- Thumb -->
				<div
					style={`left: ${(() => {
						const safeLatency = isFinite(localSrtLatency) ? localSrtLatency : 2000;
						const percentage = ((safeLatency - 2000) / (12000 - 2000)) * 100;
						return isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0;
					})()}%;`}
					class="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border-2 border-white bg-blue-500 shadow-md transition-all duration-200 hover:scale-110 dark:border-slate-800"
				></div>
				<!-- Invisible Input -->
				<input
					id="srtLatency"
					class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
					disabled={isStreaming}
					max={12000}
					min={2000}
					oninput={(e) => {
						const inputValue = parseInt(e.currentTarget.value);
						if (!isNaN(inputValue)) {
							localSrtLatency = inputValue;
							onSrtLatencyChange(inputValue);
						}
					}}
					step={50}
					type="range"
					bind:value={localSrtLatency}
				/>
			</div>
			<Input
				id="srtLatencyInput"
				class="text-center font-mono"
				disabled={isStreaming}
				onblur={() => {
					const value = normalizeValue(localSrtLatency, 2000, 12000, 50);
					if (value !== localSrtLatency) {
						localSrtLatency = value;
						onSrtLatencyChange(value);
					}
				}}
				oninput={(e) => {
					const inputValue = parseInt(e.currentTarget.value);
					if (!isNaN(inputValue)) {
						localSrtLatency = inputValue;
						onSrtLatencyChange(inputValue);
					}
				}}
				step="1"
				type="number"
				value={localSrtLatency || 2000}
			/>
			<div class="text-muted-foreground flex justify-between text-xs">
				<span>{$LL.settings.lowerLatency()}</span>
				<span>{$LL.settings.higherLatency()}</span>
			</div>
		</div>
	</Card.Content>
</Card.Root>
