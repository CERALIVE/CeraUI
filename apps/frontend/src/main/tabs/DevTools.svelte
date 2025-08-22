<style>
/* Dev tools specific styling */
:global(.dev-highlight) {
	position: relative;
	overflow: hidden;
}

:global(.dev-highlight::before) {
	content: '';
	position: absolute;
	top: 0;
	left: -100%;
	width: 100%;
	height: 100%;
	background: linear-gradient(90deg, transparent, rgba(59, 130, 246, 0.1), transparent);
	animation: dev-sweep 3s infinite;
}

@keyframes dev-sweep {
	0% {
		left: -100%;
	}
	50% {
		left: 100%;
	}
	100% {
		left: 100%;
	}
}
</style>

<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Bug, Wrench } from '@lucide/svelte';

import DemoOverlayTrigger from '$lib/components/demo-overlay-trigger.svelte';
import ScreenshotUtility from '$lib/components/dev-tools/screenshot-utility.svelte';
import SystemInfo from '$lib/components/dev-tools/system-info.svelte';
import ToastTester from '$lib/components/dev-tools/toast-tester.svelte';
import * as Card from '$lib/components/ui/card';
import { BUILD_INFO } from '$lib/env';

// Development environment info
const _isDev = BUILD_INFO.IS_DEV;
</script>

<!-- Dev Tools Page - Mobile First Design -->
<div class="from-background via-background to-accent/5 min-h-screen bg-gradient-to-br">
	<div class="container mx-auto max-w-7xl px-3 py-4 sm:px-4 sm:py-6">
		<!-- Mobile-First Header Section -->
		<div class="mb-6 sm:mb-8">
			<div class="mb-3 flex items-start gap-3 sm:mb-4 sm:items-center">
				<div
					class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 sm:h-10 sm:w-10"
				>
					<Wrench class="h-4 w-4 text-white sm:h-6 sm:w-6" />
				</div>
				<div class="min-w-0 flex-1">
					<h1 class="text-xl font-bold tracking-tight break-words sm:text-3xl">
						🛠️ {$LL.devtools.title()}
					</h1>
					<p class="text-muted-foreground mt-1 text-sm sm:text-base">
						{$LL.devtools.description()}
					</p>
				</div>
			</div>

			<!-- Mobile-Optimized Dev Mode Badge -->
			<div
				class="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-100 px-2 py-1 text-xs sm:px-3 sm:text-sm dark:border-amber-800 dark:bg-amber-900/20"
			>
				<div
					class="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-amber-500 sm:h-2 sm:w-2"
				></div>
				<span class="truncate font-medium text-amber-700 dark:text-amber-300">
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
				<!-- Real System Information -->
				<SystemInfo />

				<!-- Debug Tools Card -->
				<Card.Root
					class="border-dashed border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20"
				>
					<Card.Header>
						<Card.Title class="flex items-center gap-2 text-red-700 dark:text-red-300">
							<Bug class="h-5 w-5" />
							🐛 {$LL.devtools.consoleTesting()}
						</Card.Title>
						<Card.Description class="text-red-600 dark:text-red-400">
							{$LL.devtools.consoleTestingDesc()}
						</Card.Description>
					</Card.Header>

					<Card.Content class="space-y-3">
						<div class="bg-muted/30 rounded-md p-3">
							<div class="mb-2 text-xs font-medium">{$LL.devtools.consoleOutputTests()}</div>
							<div class="flex flex-wrap gap-2">
								<button
									class="bg-background hover:bg-accent rounded border px-2 py-1 text-xs transition-colors"
									onclick={() =>
										console.log('✅ Console log test:', { timestamp: new Date(), level: 'info' })}
								>
									{$LL.devtools.log()}
								</button>
								<button
									class="bg-background hover:bg-accent rounded border px-2 py-1 text-xs transition-colors"
									onclick={() =>
										console.warn('⚠️ Console warning test:', {
											timestamp: new Date(),
											level: 'warn',
										})}
								>
									{$LL.devtools.warn()}
								</button>
								<button
									class="bg-background hover:bg-accent rounded border px-2 py-1 text-xs transition-colors"
									onclick={() =>
										console.error('❌ Console error test:', {
											timestamp: new Date(),
											level: 'error',
										})}
								>
									{$LL.devtools.error()}
								</button>
								<button
									class="bg-background hover:bg-accent rounded border px-2 py-1 text-xs transition-colors"
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
		<div
			class="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-3 sm:mt-12 sm:p-4 dark:border-amber-800 dark:bg-amber-950/20"
		>
			<div class="flex items-start gap-2 sm:gap-3">
				<div class="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 sm:h-5 sm:w-5 dark:text-amber-400">
					⚠️
				</div>
				<div class="min-w-0 flex-1">
					<div class="text-xs font-medium text-amber-800 sm:text-sm dark:text-amber-200">
						{$LL.devtools.developmentOnly()}
					</div>
					<div class="mt-1 text-xs break-words text-amber-700 dark:text-amber-300">
						{$LL.devtools.developmentOnlyDesc()}
					</div>
				</div>
			</div>
		</div>
	</div>
</div>
