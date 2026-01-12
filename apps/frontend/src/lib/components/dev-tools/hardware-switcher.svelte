<script lang="ts">
import { Cpu, Loader2, RefreshCw } from '@lucide/svelte';
import { toast } from 'svelte-sonner';
import {
	type HardwareType,
	HARDWARE_LABELS,
	HARDWARE_DESCRIPTIONS,
	HARDWARE_COLORS,
	hardwareTypeSchema,
} from '@ceraui/rpc/schemas';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { rpc, getIsConnected } from '$lib/rpc';

// All available hardware types from schema
const ALL_HARDWARE_TYPES = hardwareTypeSchema.options as HardwareType[];

// State
let selectedHardware = $state<HardwareType | null>(null);
let effectiveHardware = $state<string>('loading...');
let availableHardware = $state<HardwareType[]>(ALL_HARDWARE_TYPES);
let isLoading = $state(false);
let isInitialized = $state(false);
let loadError = $state<string | null>(null);

// Load current hardware state on mount
async function loadHardwareState() {
	isLoading = true;
	loadError = null;
	try {
		// Wait for connection if not connected
		const isConnected = getIsConnected();
		if (!isConnected) {
			effectiveHardware = 'connecting...';
			// Retry after a short delay
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		
		const state = await rpc.streaming.getMockHardware();
		selectedHardware = state.hardware;
		effectiveHardware = state.effectiveHardware;
		availableHardware = state.availableHardware;
		isInitialized = true;
	} catch (error) {
		loadError = error instanceof Error ? error.message : 'Failed to load';
		effectiveHardware = 'error';
		console.error('Failed to load hardware state:', error);
	} finally {
		isLoading = false;
	}
}

// Switch hardware and reload pipelines
async function switchHardware(hardware: HardwareType) {
	if (isLoading) return;

	isLoading = true;
	try {
		const result = await rpc.streaming.setMockHardware({ hardware });
		if (result.success) {
			selectedHardware = result.hardware ?? null;
			effectiveHardware = hardware;
			toast.success(`Switched to ${HARDWARE_LABELS[hardware]}`, {
				description: 'Pipelines reloaded and broadcast to all clients',
			});
		} else {
			toast.error('Failed to switch hardware', {
				description: result.error,
			});
		}
	} catch (error) {
		toast.error('Failed to switch hardware', {
			description: error instanceof Error ? error.message : 'Unknown error',
		});
	} finally {
		isLoading = false;
	}
}

// Initialize on mount
$effect(() => {
	if (!isInitialized) {
		loadHardwareState();
	}
});
</script>

<Card.Root class="gap-0 overflow-hidden border-cyan-500/30 py-0">
	<!-- Status bar -->
	<div class="h-1 bg-gradient-to-r from-cyan-500 to-teal-600"></div>

	<Card.Header class="pt-6">
		<Card.Title class="flex items-center gap-2">
			<div class="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-500">
				<Cpu class="h-4 w-4 text-white" />
			</div>
			🔧 Mock Hardware Switcher
		</Card.Title>
		<Card.Description>
			Switch between hardware profiles to test different pipeline configurations
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-4 pb-6">
		<!-- Current State -->
		<div class="bg-muted/50 rounded-lg border p-4">
			<div class="mb-3 text-sm font-medium">Current State</div>
			<div class="grid grid-cols-2 gap-4 text-sm">
				<div>
					<span class="text-muted-foreground">Effective Hardware:</span>
					<span class="ml-2 font-mono font-medium" class:text-yellow-500={effectiveHardware === 'loading...' || effectiveHardware === 'connecting...'} class:text-red-500={effectiveHardware === 'error'}>
						{#if isLoading && !isInitialized}
							<Loader2 class="inline h-3 w-3 animate-spin mr-1" />
						{/if}
						{effectiveHardware}
					</span>
				</div>
				<div>
					<span class="text-muted-foreground">Mock Override:</span>
					<span class="ml-2 font-mono font-medium">{selectedHardware ?? 'None'}</span>
				</div>
			</div>
			{#if loadError}
				<div class="mt-2 text-xs text-red-500">{loadError}</div>
			{/if}
		</div>

		<!-- Hardware Selector -->
		<div class="space-y-2">
			<Label class="text-sm font-medium">Select Hardware Profile</Label>
			<Select.Root
				disabled={isLoading}
				onValueChange={(value) => switchHardware(value as HardwareType)}
				type="single"
				value={selectedHardware ?? ''}
			>
				<Select.Trigger class="w-full">
					{#if isLoading}
						<Loader2 class="mr-2 h-4 w-4 animate-spin" />
						Switching...
					{:else if selectedHardware}
						<div class="flex items-center gap-2">
							<div class={`h-2 w-2 rounded-full ${HARDWARE_COLORS[selectedHardware].bg}`}></div>
							{HARDWARE_LABELS[selectedHardware]}
						</div>
					{:else}
						Select hardware...
					{/if}
				</Select.Trigger>
				<Select.Content>
					<Select.Group>
						{#each availableHardware as hw}
							<Select.Item value={hw}>
								<div class="flex items-center gap-2">
									<div class={`h-2 w-2 rounded-full ${HARDWARE_COLORS[hw].bg}`}></div>
									<div>
										<div class="font-medium">{HARDWARE_LABELS[hw]}</div>
										<div class="text-muted-foreground text-xs">{HARDWARE_DESCRIPTIONS[hw]}</div>
									</div>
								</div>
							</Select.Item>
						{/each}
					</Select.Group>
				</Select.Content>
			</Select.Root>
		</div>

		<!-- Quick Switch Buttons -->
		<div class="space-y-2">
			<Label class="text-sm font-medium">Quick Switch</Label>
			<div class="grid grid-cols-2 gap-2">
				{#each availableHardware as hw}
					<Button
						class={selectedHardware === hw ? HARDWARE_COLORS[hw].border : ''}
						disabled={isLoading}
						onclick={() => switchHardware(hw)}
						size="sm"
						variant="outline"
					>
						{#if isLoading && selectedHardware === hw}
							<Loader2 class="mr-1 h-3 w-3 animate-spin" />
						{/if}
						<span class={HARDWARE_COLORS[hw].text}>{HARDWARE_LABELS[hw].split(' ')[0]}</span>
					</Button>
				{/each}
			</div>
		</div>

		<!-- Refresh Button -->
		<Button
			class="w-full"
			disabled={isLoading}
			onclick={loadHardwareState}
			size="sm"
			variant="outline"
		>
			<RefreshCw class={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
			Refresh State
		</Button>

		<!-- Info -->
		<div class="text-muted-foreground bg-muted/50 space-y-1 rounded-lg p-3 text-xs">
			<div class="font-medium">ℹ️ Notes:</div>
			<div>• Switching hardware reloads pipelines immediately</div>
			<div>• All connected clients receive the updated pipeline list</div>
			<div>• This feature is only available in development mode</div>
		</div>
	</Card.Content>
</Card.Root>
