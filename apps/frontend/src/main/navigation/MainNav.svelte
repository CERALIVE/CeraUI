<style>
/* Enhanced animations for better performance */
@media (prefers-reduced-motion: no-preference) {
	button {
		will-change: transform, opacity;
	}

	.group:hover {
		transform: translateZ(0); /* Force hardware acceleration */
	}
}

/* Ensure smooth transitions during loading states */
button:disabled {
	transition: opacity 0.2s ease-in-out;
}

/* Enhanced focus styles for accessibility */
button:focus-visible {
	box-shadow: 0 0 0 2px hsl(var(--primary) / 0.5);
}
</style>

<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { cubicInOut } from 'svelte/easing';
import { crossfade, fly, scale } from 'svelte/transition';

import Logo from '$lib/components/icons/Logo.svelte';
import { ScrollArea } from '$lib/components/ui/scroll-area';
import { type NavElements, navElements, siteName } from '$lib/config';
import {
	canGoBack,
	enhancedNavigationStore,
	getCurrentNavigation,
	isNavigationTransitioning,
	navigateTo,
} from '$lib/stores/navigation.svelte';
import { cn } from '$lib/utils';

const [send, receive] = crossfade({
	duration: 400,
	easing: cubicInOut,
	fallback(node) {
		// Validate node exists and has dimensions to prevent NaN values
		if (!node || !node.getBoundingClientRect) {
			return { duration: 0, css: () => '' };
		}

		const startValue = 0.95;
		// Ensure start value is a valid number to prevent scale(NaN, NaN)
		const safeStart = isFinite(startValue) ? startValue : 1;

		return scale(node, {
			duration: 200,
			start: safeStart,
			easing: cubicInOut,
		});
	},
});

let isLogoHovered = $state(false);
let hoveredTab: string | null = $state(null);
let lastNavigationTime = 0;

// Navigation throttling to prevent race conditions
const NAVIGATION_THROTTLE_MS = 50;

// Svelte 5: Use $derived for current navigation
const currentNav = $derived(getCurrentNavigation() ?? { general: navElements.general });

// Enhanced tab navigation with throttling to prevent race conditions
const handleTabNavigation = (identifier: string, navigation: Record<string, unknown>) => {
	// Add additional safety checks to prevent NaN issues
	if ($isNavigationTransitioning || !navigation || !identifier) {
		console.warn('[MainNav] Navigation blocked - invalid state or transitioning');
		return;
	}

	const now = Date.now();
	if (now - lastNavigationTime < NAVIGATION_THROTTLE_MS) {
		console.log(`[MainNav] Navigation throttled - too soon after last navigation`);
		return;
	}

	lastNavigationTime = now;
	console.log(`[MainNav] Navigation to ${identifier}:`, {
		timestamp: new Date().toISOString(),
		throttleMs: NAVIGATION_THROTTLE_MS,
	});

	navigateTo({ [identifier]: navigation } as NavElements);

	// Reset hover state on navigation
	hoveredTab = null;
};

// Logo click handler with enhanced feedback and throttling
const handleLogoClick = () => {
	if ($isNavigationTransitioning) return;

	const now = Date.now();
	if (now - lastNavigationTime < NAVIGATION_THROTTLE_MS) {
		console.log(`[MainNav] Logo navigation throttled`);
		return;
	}

	lastNavigationTime = now;
	console.log(`[MainNav] Logo navigation:`, {
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
		navigateTo({ general: navElements.general });
	}
};
</script>

<!-- Brand/Logo Section with Enhanced Reactive Design -->
<div class="mr-6 hidden md:flex">
	<button
		class={cn(
			'group relative flex cursor-pointer items-center space-x-3 rounded-xl px-3 py-2 transition-all duration-300',
			'hover:bg-accent/50 focus-visible:bg-accent/50',
			$isNavigationTransitioning && 'pointer-events-none opacity-60',
		)}
		aria-label={$canGoBack ? 'Go back or home' : 'Go to home'}
		disabled={$isNavigationTransitioning}
		onclick={handleLogoClick}
		onmouseenter={() => (isLogoHovered = true)}
		onmouseleave={() => (isLogoHovered = false)}
	>
		<!-- Enhanced Logo with reactive effects -->
		<div class="relative">
			<Logo
				class={cn(
					'h-7 w-7 transition-all duration-300',
					isLogoHovered && 'scale-110 rotate-12',
					$isNavigationTransitioning && 'animate-pulse',
				)}
			/>

			<!-- Enhanced glow effect with reactive states -->
			<div
				class={cn(
					'absolute -inset-1 rounded-full blur-sm transition-all duration-300',
					isLogoHovered ? 'bg-primary/30 opacity-100' : 'bg-primary/10 opacity-0',
					$canGoBack && 'bg-primary/20', // Subtle indicator when back is available
				)}
			></div>

			<!-- Back indicator -->
			{#if $canGoBack && isLogoHovered}
				<div
					class="bg-primary absolute -top-1 -right-1 h-3 w-3 rounded-full"
					in:scale={{ duration: 200, start: 0.8 }}
					out:scale={{ duration: 150, start: 1 }}
				>
					<div class="bg-primary/60 h-full w-full animate-ping rounded-full"></div>
				</div>
			{/if}
		</div>

		<!-- Brand name with enhanced typography and states -->
		<span
			class={cn(
				'hidden font-bold tracking-tight transition-all duration-200 xl:inline-block',
				'text-foreground',
				isLogoHovered && 'text-primary',
				$isNavigationTransitioning && 'opacity-60',
			)}
		>
			{siteName}
		</span>

		<!-- Subtle loading indicator -->
		{#if $isNavigationTransitioning}
			<div class="bg-primary h-2 w-2 animate-pulse rounded-full"></div>
		{/if}
	</button>
</div>

<!-- Enhanced Navigation Tabs with Reactive Design -->
<div class="hidden flex-1 md:flex">
	<ScrollArea orientation="both" scrollbarXClasses="invisible">
		<div class="flex items-center space-x-1 px-4 py-2">
			{#each Object.entries(navElements) as [identifier, navigation], index}
				{@const isActive =
					currentNav &&
					typeof currentNav === 'object' &&
					Object.keys(currentNav).length > 0 &&
					Object.keys(currentNav)[0] === identifier}
				{@const isHovered = hoveredTab === identifier}

				<button
					id={identifier}
					class={cn(
						'group relative flex h-10 min-w-28 cursor-pointer items-center justify-center rounded-xl px-4 text-center text-sm font-medium transition-all duration-300',
						isActive
							? 'text-primary shadow-sm'
							: cn(
									'text-muted-foreground hover:text-foreground',
									isHovered && 'bg-accent/50 scale-105',
								),
						$isNavigationTransitioning && 'pointer-events-none opacity-60',
						// Enhanced focus states
						'focus-visible:ring-primary/50 focus-visible:ring-2 focus-visible:outline-none',
					)}
					aria-current={isActive ? 'page' : undefined}
					disabled={$isNavigationTransitioning}
					onclick={() => handleTabNavigation(identifier, navigation)}
					onmouseenter={() => (hoveredTab = identifier)}
					onmouseleave={() => (hoveredTab = null)}
					in:fly={{
						y: 20,
						duration: 300,
						delay: index * 50,
						easing: cubicInOut,
					}}
				>
					{#if isActive}
						<!-- Enhanced active indicator with improved animations -->
						<div
							class={cn(
								'absolute inset-0 rounded-xl border shadow-lg transition-all duration-300',
								'from-background to-accent border-border/50 bg-gradient-to-b',
								'shadow-primary/10',
							)}
							in:receive={{ key: 'activetab' }}
							out:send={{ key: 'activetab' }}
						></div>

						<!-- Enhanced glow effect for active tab -->
						<div class="bg-primary/5 absolute inset-0 rounded-xl opacity-60"></div>

						<!-- Active state pulse effect -->
						<div class="bg-primary/10 absolute inset-0 animate-pulse rounded-xl opacity-30"></div>
					{/if}

					<!-- Tab content with enhanced interactive effects -->
					<span
						class={cn(
							'relative z-10 transition-all duration-200',
							isActive && 'font-semibold',
							(isHovered || isActive) && 'scale-105',
						)}
					>
						{$LL.navigation[navigation.label]()}
					</span>

					<!-- Enhanced hover indicator with smooth animations -->
					{#if !isActive}
						<div
							class={cn(
								'absolute bottom-0 left-1/2 h-0.5 transition-all duration-300',
								'from-primary/60 via-primary to-primary/60 bg-gradient-to-r',
								isHovered ? 'w-8 -translate-x-1/2 opacity-100' : 'w-0 -translate-x-1/2 opacity-0',
							)}
						></div>
					{/if}

					<!-- Loading indicator for individual tabs -->
					{#if $isNavigationTransitioning && isActive}
						<div class="bg-primary absolute top-1 right-1 h-2 w-2 animate-ping rounded-full"></div>
					{/if}
				</button>
			{/each}
		</div>
	</ScrollArea>
</div>
