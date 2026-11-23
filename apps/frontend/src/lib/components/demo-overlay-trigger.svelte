<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { UpdateProgress } from '@ceraui/rpc/schemas';
import { Play, Square } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import UpdatingOverlay from '$lib/components/updating-overlay.svelte';

// Demo state management
let isDemo = $state(false);
let demoPhase = $state(0);

// Simulated update details: phase markers plus the percentage APT reports.
const idle: UpdateProgress = { downloading: 0, unpacking: 0, setting_up: 0, total: 0 };
const DEMO_STEPS = 10;
let demoDetails = $state<UpdateProgress>(idle);

// Demo simulation control
let demoInterval: ReturnType<typeof setInterval> | null = null;

function startDemo() {
	isDemo = true;
	demoPhase = 0;
	demoDetails = idle;

	demoInterval = setInterval(() => {
		if (demoPhase < DEMO_STEPS) {
			const downloading = demoPhase < DEMO_STEPS / 2;
			demoDetails = {
				total: 1,
				downloading: downloading ? 1 : 0,
				unpacking: 0,
				setting_up: downloading ? 0 : 1,
				percent: Math.min(99, ((demoPhase % (DEMO_STEPS / 2)) + 1) * 20),
			};
			demoPhase++;
		} else {
			// Complete the demo
			demoDetails = { ...demoDetails, result: 0 }; // Success
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
	demoDetails = idle;
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
<Card.Root>
	<Card.Header>
		<Card.Title class="flex items-center gap-2">
			<Play class="h-5 w-5 text-primary" />
			{m["devtools.overlayDemo"]()}
		</Card.Title>
		<Card.Description>
			{m["devtools.overlayDemoDescription"]()}
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-4">
		<!-- Controls -->
		<div class="flex gap-3">
			<Button
				disabled={isDemo}
				onclick={startDemo}
			>
				<Play class="mr-2 h-4 w-4" />
				{m["devtools.startDemo"]()}
			</Button>

			<Button
				disabled={!isDemo}
				onclick={stopDemo}
				variant="outline"
			>
				<Square class="mr-2 h-4 w-4" />
				{m["devtools.stopDemo"]()}
			</Button>
		</div>

		<!-- Demo Status -->
		{#if isDemo}
			<div
				class="rounded-md border border-primary/30 bg-primary/10 p-3 text-sm"
			>
				<div class="mb-1 font-medium text-primary">{m["devtools.demoRunning"]()}</div>
				<div>
					{m["devtools.phase"]()}: {demoPhase}/10 | {m["devtools.downloading"]()}: {demoDetails.downloading}
					| {m["devtools.unpacking"]()}: {demoDetails.unpacking} | {m["devtools.installing"]()}: {demoDetails.setting_up}
				</div>
			</div>
		{/if}

		<!-- Demo Info -->
		<div class="text-muted-foreground space-y-1 text-xs">
			<p>• {m["devtools.demoInfo1"]()}</p>
			<p>• {m["devtools.demoInfo2"]()}</p>
			<p>• {m["devtools.demoInfo3"]()}</p>
			<p>• {m["devtools.demoInfo4"]()}</p>
		</div>
	</Card.Content>
</Card.Root>

<!-- Demo Overlay -->
{#if isDemo}
	<UpdatingOverlay details={demoDetails} />
{/if}
