<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Bug, Wrench } from '@lucide/svelte';

import DemoOverlayTrigger from '$lib/components/demo-overlay-trigger.svelte';
import HardwareSwitcher from '$lib/components/dev-tools/hardware-switcher.svelte';
import ScreenshotUtility from '$lib/components/dev-tools/screenshot-utility.svelte';
import SystemInfo from '$lib/components/dev-tools/system-info.svelte';
import ToastTester from '$lib/components/dev-tools/toast-tester.svelte';
import * as Card from '$lib/components/ui/card';
import { BUILD_INFO } from '$lib/env';

</script>

<!-- Dev Tools Page - Mobile First Design -->
<div class="bg-background min-h-screen">
	<div class="container mx-auto max-w-7xl px-3 py-4 sm:px-4 sm:py-6">
		<!-- Mobile-First Header Section -->
		<div class="mb-6 sm:mb-8">
			<div class="mb-3 flex items-start gap-3 sm:mb-4 sm:items-center">
				<Wrench class="h-6 w-6 shrink-0 text-primary sm:h-7 sm:w-7" />
				<div class="min-w-0 flex-1">
					<h1 class="text-xl font-bold tracking-tight break-words sm:text-3xl">
						{$LL.devtools.title()}
					</h1>
					<p class="text-muted-foreground mt-1 text-sm sm:text-base">
						{$LL.devtools.description()}
					</p>
				</div>
			</div>

			<!-- Mobile-Optimized Dev Mode Badge -->
			<div
				class="inline-flex items-center gap-2 rounded-full bg-amber-500/10 px-2 py-1 text-xs sm:px-3 sm:text-sm"
			>
				<div
					class="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-amber-500 sm:h-2 sm:w-2"
				></div>
				<span class="truncate font-medium text-amber-700 dark:text-amber-400">
					<span class="hidden sm:inline"
						>{$LL.devtools.developmentMode()}: {BUILD_INFO.MODE} | {$LL.devtools.status()}: {$LL.devtools.active()}</span
					>
					<span class="sm:hidden">{$LL.devtools.status()}: {$LL.devtools.active()}</span>
				</span>
			</div>
		</div>

		<!-- Mobile-First Grid Layout -->
		<div class="grid gap-4 sm:gap-6 md:grid-cols-2">
			<!-- Component Testing Section -->
			<div class="space-y-4 sm:space-y-6">
				<!-- Screenshot Capture Utility -->
				<ScreenshotUtility />

				<!-- Overlay Demo Card -->
				<DemoOverlayTrigger />

				<!-- Toast Notification Tester -->
				<ToastTester />
			</div>

			<!-- Debug Information Section -->
			<div class="space-y-4 sm:space-y-6">
				<!-- Mock Hardware Switcher -->
				<HardwareSwitcher />

				<!-- Real System Information -->
				<SystemInfo />

				<!-- Debug Tools Card -->
			<Card.Root class="overflow-hidden">
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<Bug class="h-5 w-5 text-primary" />
						{$LL.devtools.consoleTesting()}
						</Card.Title>
						<Card.Description>
							{$LL.devtools.consoleTestingDesc()}
						</Card.Description>
					</Card.Header>

					<Card.Content class="space-y-3 pb-6">
						<div class="bg-muted/50 rounded-lg p-3">
							<div class="text-muted-foreground mb-2 text-xs font-medium">
								{$LL.devtools.consoleOutputTests()}
							</div>
							<div class="flex flex-wrap gap-2">
								<button
									class="bg-card rounded-lg border px-3 py-1.5 text-xs font-medium transition-all hover:border-emerald-500/30 hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-400"
									onclick={() =>
										console.log('✅ Console log test:', { timestamp: new Date(), level: 'info' })}
								>
									{$LL.devtools.log()}
								</button>
								<button
									class="bg-card rounded-lg border px-3 py-1.5 text-xs font-medium transition-all hover:border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-400"
									onclick={() =>
										console.warn('⚠️ Console warning test:', {
											timestamp: new Date(),
											level: 'warn',
										})}
								>
									{$LL.devtools.warn()}
								</button>
								<button
									class="bg-card rounded-lg border px-3 py-1.5 text-xs font-medium transition-all hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-400"
									onclick={() =>
										console.error('❌ Console error test:', {
											timestamp: new Date(),
											level: 'error',
										})}
								>
									{$LL.devtools.error()}
								</button>
								<button
									class="bg-card rounded-lg border px-3 py-1.5 text-xs font-medium transition-all hover:border-blue-500/30 hover:bg-blue-500/10 hover:text-blue-700 dark:hover:text-blue-400"
									onclick={() =>
										console.table({
											browser: navigator.userAgent.split(' ')[0],
											language: navigator.language,
											online: navigator.onLine,
										})}
								>
									{$LL.devtools.table()}
								</button>
							</div>
						</div>
					</Card.Content>
				</Card.Root>
			</div>
		</div>

		<!-- Mobile-Friendly Warning Footer -->
		<div class="text-muted-foreground bg-muted/30 mt-8 rounded-lg border p-3 sm:mt-12 sm:p-4">
			<div class="text-sm font-semibold">
				{$LL.devtools.developmentOnly()}
			</div>
			<div class="mt-1 text-xs">
				{$LL.devtools.developmentOnlyDesc()}
			</div>
		</div>
	</div>
</div>
