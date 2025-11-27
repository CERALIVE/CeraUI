<style>
/* Enhanced animations for mobile interactions */
@media (prefers-reduced-motion: no-preference) {
	button {
		will-change: transform, opacity;
	}
}

/* Smooth transitions for disabled states */
button:disabled {
	transition:
		opacity 0.2s ease-in-out,
		transform 0.2s ease-in-out;
}

/* Enhanced mobile-specific focus styles */
button:focus-visible {
	outline: 2px solid hsl(var(--primary) / 0.5);
	outline-offset: 2px;
}
</style>

<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { ChevronLeft, Menu, X } from '@lucide/svelte';
import { cubicInOut } from 'svelte/easing';
import { fade, fly, scale } from 'svelte/transition';

import Logo from '$lib/components/icons/Logo.svelte';
import { Button } from '$lib/components/ui/button';
import MobileLink from '$lib/components/ui/mobile-link.svelte';
import { ScrollArea } from '$lib/components/ui/scroll-area';
import * as Sheet from '$lib/components/ui/sheet';
import { type NavElements, navElements, siteName } from '$lib/config';
import {
	canGoBack,
	enhancedNavigationStore,
	getCurrentNavigation,
	isNavigationTransitioning,
	navigateTo,
} from '$lib/stores/navigation.svelte';
import { cn } from '$lib/utils';

let open = $state(false);
let isMenuHovered = $state(false);
let selectedItem: string | null = $state(null);
let lastNavigationTime = 0;

// Navigation throttling to prevent race conditions
const NAVIGATION_THROTTLE_MS = 50;

// Svelte 5: Use $derived for current navigation
const currentNav = $derived(getCurrentNavigation() ?? { general: navElements.general });

// Enhanced navigation handler with throttling to prevent race conditions
const handleClick = (nav: NavElements) => {
	if ($isNavigationTransitioning) return;

	const now = Date.now();
	if (now - lastNavigationTime < NAVIGATION_THROTTLE_MS) {
		console.log(`[MobileNav] Navigation throttled - too soon after last navigation`);
		return;
	}

	lastNavigationTime = now;
	const navKey =
		nav && typeof nav === 'object' && Object.keys(nav).length > 0 ? Object.keys(nav)[0] : 'unknown';
	console.log(`[MobileNav] Navigation to ${navKey}:`, {
		timestamp: new Date().toISOString(),
		throttleMs: NAVIGATION_THROTTLE_MS,
	});

	// Set selected item for visual feedback with safety checks
	const navKeys = nav && typeof nav === 'object' ? Object.keys(nav) : [];
	selectedItem = navKeys.length > 0 ? navKeys[0] : null;

	// Small delay for visual feedback
	setTimeout(() => {
		// Validate nav object before setting to prevent NaN scale animations
		if (nav && typeof nav === 'object' && Object.keys(nav).length > 0) {
			navigateTo(nav);
		} else {
			console.warn('[MobileNav] Invalid nav object, skipping navigation:', nav);
		}
		open = false;
		// Reset selectedItem safely to prevent animation conflicts
		setTimeout(() => {
			selectedItem = null;
		}, 50); // Small additional delay to let scale animations complete
	}, 150);
};

// Enhanced logo click handler with throttling
const handleLogoClick = () => {
	if ($isNavigationTransitioning) return;

	const now = Date.now();
	if (now - lastNavigationTime < NAVIGATION_THROTTLE_MS) {
		console.log(`[MobileNav] Logo navigation throttled`);
		return;
	}

	lastNavigationTime = now;
	console.log(`[MobileNav] Logo navigation:`, {
		timestamp: new Date().toISOString(),
		canGoBack: $canGoBack,
	});

	const currentKey =
		currentNav && typeof currentNav === 'object' && Object.keys(currentNav).length > 0
			? Object.keys(currentNav)[0]
			: '';
	const defaultKey = 'general'; // Always general as the default

	// If already on default, and can go back, go back instead
	if (currentKey === defaultKey && $canGoBack) {
		enhancedNavigationStore.goBack();
	} else {
		handleClick({ general: navElements.general });
	}
};

// Enhanced back navigation with throttling
const handleBack = () => {
	if (!$canGoBack || $isNavigationTransitioning) return;

	const now = Date.now();
	if (now - lastNavigationTime < NAVIGATION_THROTTLE_MS) {
		console.log(`[MobileNav] Back navigation throttled`);
		return;
	}

	lastNavigationTime = now;
	console.log(`[MobileNav] Back navigation:`, {
		timestamp: new Date().toISOString(),
	});

	enhancedNavigationStore.goBack();
	open = false;
};

// Close menu when navigation starts transitioning
$effect(() => {
	if ($isNavigationTransitioning && open) {
		setTimeout(() => {
			open = false;
		}, 100);
	}
});
</script>

<Sheet.Root bind:open>
	<Sheet.Trigger>
		<Button
			class="hover:bg-accent/50 focus-visible:bg-accent/50 group relative mr-2 rounded-xl px-3 py-2 text-base transition-all duration-300 focus-visible:ring-0 focus-visible:ring-offset-0 md:hidden"
			disabled={$isNavigationTransitioning}
			onmouseenter={() => (isMenuHovered = true)}
			onmouseleave={() => (isMenuHovered = false)}
			variant="ghost"
		>
			<!-- Enhanced menu icon with reactive states -->
			<div class="relative">
				{#if open}
					<X
						class="h-5 w-5 transition-all duration-300 group-hover:scale-110 group-hover:rotate-90"
					/>
				{:else}
					<Menu
						class={cn(
							'h-5 w-5 transition-all duration-300 group-hover:scale-110',
							$isNavigationTransitioning && 'animate-pulse',
						)}
					/>
				{/if}
			</div>

			<span class="sr-only">
				{open ? $LL.navigation.closeMenu() : $LL.navigation.toggleMenu()}
			</span>

			<!-- Enhanced glow effect with reactive states -->
			<div
				class={cn(
					'absolute -inset-1 rounded-xl blur-sm transition-all duration-300',
					isMenuHovered || open ? 'bg-primary/20 opacity-100' : 'bg-primary/10 opacity-0',
					$isNavigationTransitioning && 'animate-pulse',
				)}
			></div>

			<!-- Loading indicator -->
			{#if $isNavigationTransitioning}
				<div class="bg-primary absolute top-1 right-1 h-2 w-2 animate-ping rounded-full"></div>
			{/if}
		</Button>
	</Sheet.Trigger>

	<Sheet.Content class="w-80 pt-4 pr-0" side="left">
		<!-- Enhanced Header Section with Navigation Controls -->
		<div class="border-border/50 border-b px-4 pb-4">
			<!-- Back button (if history available) -->
			{#if $canGoBack}
				<div class="mb-4" in:fly={{ x: -20, duration: 200 }}>
					<button
						class="text-muted-foreground hover:text-foreground group flex items-center space-x-2 text-sm transition-all duration-200 disabled:opacity-50"
						disabled={$isNavigationTransitioning}
						onclick={handleBack}
					>
						<ChevronLeft
							class="h-4 w-4 transition-transform duration-200 group-hover:-translate-x-1"
						/>
						<span>{$LL.navigation.back()}</span>
					</button>
				</div>
			{/if}

			<!-- Enhanced Logo Section -->
			<button
				class="hover:bg-accent/50 group flex w-full items-center space-x-3 rounded-xl px-4 py-3 transition-all duration-300"
				disabled={$isNavigationTransitioning}
				onclick={handleLogoClick}
			>
				<!-- Logo with enhanced effects -->
				<div class="relative">
					<Logo
						class={cn(
							'h-6 w-6 transition-all duration-300 group-hover:scale-105',
							$isNavigationTransitioning && 'animate-pulse',
						)}
					/>

					<!-- Logo glow effect -->
					<div
						class="bg-primary/10 absolute -inset-1 rounded-full opacity-0 blur-sm transition-opacity duration-300 group-hover:opacity-100"
					></div>
				</div>

				<!-- Enhanced brand name -->
				<div class="flex-1">
					<span
						class={cn(
							'text-lg font-semibold transition-all duration-200',
							'text-foreground group-hover:text-primary',
						)}
					>
						{siteName}
					</span>

					<!-- Subtitle with navigation state -->
					<div class="text-muted-foreground mt-0.5 text-xs">
						{#if $isNavigationTransitioning}
							<span class="animate-pulse">Loading...</span>
						{:else if $canGoBack}
							<span>Tap to go back or home</span>
						{:else}
							<span>Home</span>
						{/if}
					</div>
				</div>

				<!-- Navigation state indicator -->
				{#if $isNavigationTransitioning}
					<div class="bg-primary h-2 w-2 animate-pulse rounded-full"></div>
				{:else if $canGoBack}
					<div class="h-2 w-2 animate-ping rounded-full bg-blue-500"></div>
				{/if}
			</button>
		</div>

		<!-- Enhanced Navigation Links Section -->
		<ScrollArea class="flex-1 px-4 pt-4" orientation="both">
			<div class="flex flex-col space-y-2 pb-10">
				{#each Object.entries(navElements) as [identifier, navigation], index}
					{@const isActive =
						currentNav &&
						typeof currentNav === 'object' &&
						Object.keys(currentNav).length > 0 &&
						Object.keys(currentNav)[0] === identifier}
					{@const isSelected = selectedItem === identifier}

					{#if identifier}
						<div
							class="relative"
							in:fly={{
								x: -30,
								duration: 300,
								delay: index * 75,
								easing: cubicInOut,
							}}
						>
							<!-- Enhanced mobile link with reactive states -->
							<div class="relative">
								<MobileLink
									class={cn(
										'transition-all duration-300',
										isSelected && 'bg-primary/10 scale-[0.98]',
										$isNavigationTransitioning &&
											identifier === Object.keys(currentNav || {})[0] &&
											'opacity-60',
									)}
									disabled={$isNavigationTransitioning}
									{identifier}
									isActive={isActive || isSelected}
									onclick={() => {
										// Validate identifier and navigation before handling click
										if (identifier && navigation && typeof navigation === 'object') {
											handleClick({ [identifier]: navigation });
										} else {
											console.warn('[MobileNav] Invalid navigation data:', {
												identifier,
												navigation,
											});
										}
									}}
								>
									{#snippet children()}
										<div class="flex w-full items-center justify-between">
											<span
												>{$LL.navigation[navigation?.label as keyof typeof $LL.navigation]()}</span
											>

											<!-- Visual feedback indicators -->
											<div class="flex items-center space-x-2">
												{#if isSelected}
													<div class="bg-primary h-2 w-2 animate-ping rounded-full"></div>
												{:else if isActive}
													<div class="bg-primary h-2 w-2 rounded-full"></div>
												{/if}
											</div>
										</div>
									{/snippet}
								</MobileLink>

								<!-- Enhanced selection feedback -->
								{#if isSelected}
									<div
										class="bg-primary/5 pointer-events-none absolute inset-0 rounded-lg"
										in:scale={{ duration: 200, start: isFinite(0.95) ? 0.95 : 1 }}
										out:fade={{ duration: 150 }}
									></div>
								{/if}
							</div>
						</div>
					{/if}
				{/each}

				<!-- Navigation status indicator -->
				{#if $isNavigationTransitioning}
					<div
						class="text-muted-foreground flex items-center justify-center py-4 text-sm"
						in:fade={{ duration: 200 }}
					>
						<div class="flex items-center space-x-2">
							<div
								class="border-primary h-3 w-3 animate-spin rounded-full border-2 border-t-transparent"
							></div>
							<span>Switching sections...</span>
						</div>
					</div>
				{/if}
			</div>
		</ScrollArea>
	</Sheet.Content>
</Sheet.Root>
