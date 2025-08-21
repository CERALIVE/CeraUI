<style>
/* Demo-specific styling */
:global(.demo-highlight) {
	animation: demo-glow 2s ease-in-out infinite alternate;
}

@keyframes demo-glow {
	from {
		box-shadow: 0 0 5px rgba(251, 191, 36, 0.3);
	}
	to {
		box-shadow: 0 0 20px rgba(251, 191, 36, 0.6);
	}
}
</style>

<script lang="ts">
import { Play, Square } from '@lucide/svelte';
import { LL } from '@ceraui/i18n/svelte';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import UpdatingOverlay from '$lib/components/updating-overlay.svelte';

// Demo state management
let isDemo = $state(false);
let demoPhase = $state(0);

// Simulated update details
let demoDetails = $state({
	downloading: 0,
	unpacking: 0,
	setting_up: 0,
	total: 10,
	result: undefined as number | undefined,
});

// Demo simulation control
let demoInterval: ReturnType<typeof setInterval> | null = null;

function startDemo() {
	isDemo = true;
	demoPhase = 0;

	// Reset all values
	demoDetails = {
		downloading: 0,
		unpacking: 0,
		setting_up: 0,
		total: 10,
		result: undefined,
	};

	// Start the simulation
	demoInterval = setInterval(() => {
		const total = 10;
		if (demoPhase < total) {
			// Phase 1: Downloading (0-33%)
			if (demoPhase < Math.floor(total / 3)) {
				demoDetails.downloading = demoPhase + 1;
			}
			// Phase 2: Unpacking (33-66%)
			else if (demoPhase < Math.floor((total * 2) / 3)) {
				demoDetails.downloading = Math.floor(total / 3);
				demoDetails.unpacking = demoPhase - Math.floor(total / 3) + 1;
			}
			// Phase 3: Installing (66-100%)
			else {
				demoDetails.downloading = Math.floor(total / 3);
				demoDetails.unpacking = Math.floor(total / 3);
				demoDetails.setting_up = demoPhase - Math.floor((total * 2) / 3) + 1;
			}

			demoPhase++;
		} else {
			// Complete the demo
			demoDetails.result = 0; // Success
			setTimeout(() => {
				stopDemo();
			}, 3000); // Show success for 3 seconds
		}
	}, 800); // Update every 800ms for realistic feel
}

function stopDemo() {
	isDemo = false;
	if (demoInterval) {
		clearInterval(demoInterval);
		demoInterval = null;
	}
	demoPhase = 0;
	demoDetails = {
		downloading: 0,
		unpacking: 0,
		setting_up: 0,
		total: 10,
		result: undefined,
	};
}

// Cleanup using effect
$effect(() => {
	return () => {
		if (demoInterval) {
			clearInterval(demoInterval);
			demoInterval = null;
		}
	};
});
</script>

<!-- Demo Controls Card -->
<Card.Root
	class="border-dashed border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20"
>
	<Card.Header>
		<Card.Title class="flex items-center gap-2 text-amber-700 dark:text-amber-300">
			<Play class="h-5 w-5" />
			🎨 {$LL.devtools.overlayDemo()}
		</Card.Title>
		<Card.Description class="text-amber-600 dark:text-amber-400">
			{$LL.devtools.overlayDemoDescription()}
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-4">
		<!-- Controls -->
		<div class="flex gap-3">
			<Button
				class="bg-green-500 text-white hover:bg-green-600"
				disabled={isDemo}
				onclick={startDemo}
				variant="secondary"
			>
				<Play class="mr-2 h-4 w-4" />
				{$LL.devtools.startDemo()}
			</Button>

			<Button
				class="border-red-200 text-red-600 hover:bg-red-50"
				disabled={!isDemo}
				onclick={stopDemo}
				variant="outline"
			>
				<Square class="mr-2 h-4 w-4" />
				{$LL.devtools.stopDemo()}
			</Button>
		</div>

		<!-- Demo Status -->
		{#if isDemo}
			<div
				class="text-muted-foreground rounded-md border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-800 dark:bg-blue-950/20"
			>
				<div class="mb-1 font-medium">🔄 {$LL.devtools.demoRunning()}</div>
				<div>
					{$LL.devtools.phase()}: {demoPhase}/10 | {$LL.devtools.downloading()}: {demoDetails.downloading}
					| {$LL.devtools.unpacking()}: {demoDetails.unpacking} | {$LL.devtools.installing()}: {demoDetails.setting_up}
				</div>
			</div>
		{/if}

		<!-- Demo Info -->
		<div class="text-muted-foreground space-y-1 text-xs">
			<p>• {$LL.devtools.demoInfo1()}</p>
			<p>• {$LL.devtools.demoInfo2()}</p>
			<p>• {$LL.devtools.demoInfo3()}</p>
			<p>• {$LL.devtools.demoInfo4()}</p>
		</div>
	</Card.Content>
</Card.Root>

<!-- Demo Overlay -->
{#if isDemo}
	<UpdatingOverlay details={demoDetails} />
{/if}
