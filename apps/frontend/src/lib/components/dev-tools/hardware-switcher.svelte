<script lang="ts">
import { Cpu, Loader2, RefreshCw } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { rpc } from '$lib/rpc';

type HardwareType = 'jetson' | 'n100' | 'rk3588';

// State
let selectedHardware = $state<HardwareType | null>(null);
let effectiveHardware = $state<string>('unknown');
let availableHardware = $state<HardwareType[]>(['jetson', 'n100', 'rk3588']);
let isLoading = $state(false);
let isInitialized = $state(false);

// Hardware type display info
const hardwareInfo: Record<HardwareType, { name: string; description: string; color: string }> = {
	jetson: {
		name: 'NVIDIA Jetson',
		description: 'NVIDIA nvenc hardware encoding',
		color: 'text-green-600 dark:text-green-400',
	},
	n100: {
		name: 'Intel N100',
		description: 'Intel VAAPI hardware encoding',
		color: 'text-blue-600 dark:text-blue-400',
	},
	rk3588: {
		name: 'Rockchip RK3588',
		description: 'Rockchip MPP hardware encoding (supports 4K)',
		color: 'text-orange-600 dark:text-orange-400',
	},
};

// Load current hardware state on mount
async function loadHardwareState() {
	try {
		const state = await rpc.streaming.getMockHardware();
		selectedHardware = state.hardware;
		effectiveHardware = state.effectiveHardware;
		availableHardware = state.availableHardware;
		isInitialized = true;
	} catch (_error) {
		toast.error('Failed to load hardware state');
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
			toast.success(`Switched to ${hardwareInfo[hardware].name}`, {
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
					<span class="ml-2 font-mono font-medium">{effectiveHardware}</span>
				</div>
				<div>
					<span class="text-muted-foreground">Mock Override:</span>
					<span class="ml-2 font-mono font-medium">{selectedHardware ?? 'None'}</span>
				</div>
			</div>
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
							<div
								class={`h-2 w-2 rounded-full ${
									selectedHardware === 'jetson'
										? 'bg-green-500'
										: selectedHardware === 'n100'
											? 'bg-blue-500'
											: 'bg-orange-500'
								}`}
							></div>
							{hardwareInfo[selectedHardware].name}
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
									<div
										class={`h-2 w-2 rounded-full ${
											hw === 'jetson'
												? 'bg-green-500'
												: hw === 'n100'
													? 'bg-blue-500'
													: 'bg-orange-500'
										}`}
									></div>
									<div>
										<div class="font-medium">{hardwareInfo[hw].name}</div>
										<div class="text-muted-foreground text-xs">{hardwareInfo[hw].description}</div>
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
			<div class="grid grid-cols-3 gap-2">
				{#each availableHardware as hw}
					<Button
						class={`${
							selectedHardware === hw
								? hw === 'jetson'
									? 'border-green-500 bg-green-500/20'
									: hw === 'n100'
										? 'border-blue-500 bg-blue-500/20'
										: 'border-orange-500 bg-orange-500/20'
								: ''
						}`}
						disabled={isLoading}
						onclick={() => switchHardware(hw)}
						size="sm"
						variant="outline"
					>
						{#if isLoading && selectedHardware === hw}
							<Loader2 class="mr-1 h-3 w-3 animate-spin" />
						{/if}
						<span class={hardwareInfo[hw].color}>{hardwareInfo[hw].name.split(' ')[0]}</span>
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
