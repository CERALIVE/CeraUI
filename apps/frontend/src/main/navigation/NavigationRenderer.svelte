<style>
/* Enhanced loading animation keyframes */
@keyframes gentle-pulse {
	0%,
	100% {
		opacity: 0.4;
	}
	50% {
		opacity: 1;
	}
}

/* Ensure smooth transitions */
.container {
	overflow: hidden;
}
</style>

<script lang="ts">
import type { Component } from 'svelte';
import { cubicInOut } from 'svelte/easing';
import { fade, fly } from 'svelte/transition';

import { setupHashNavigation } from '$lib/helpers/NavigationHelper';
import {
	enhancedNavigationStore,
	isNavigationTransitioning,
	navigationError,
	navigationStore,
	transitionDirection,
} from '$lib/stores/navigation.svelte';

let CurrentComponent: Component | undefined = $state(undefined);
const _previousComponent: Component | undefined = $state(undefined);
let showContent = $state(true);

// Navigation transition configuration
const TRANSITION_DURATION = 300;
const _LOADING_DELAY = 150;

// Simple navigation subscription without race condition complexity
$effect(() => {
	const unsubscribe = navigationStore.subscribe((tab) => {
		if (tab) {
			const newComponent = Object.values(tab)[0].component;
			// Simple component update without complex race condition handling
			CurrentComponent = newComponent;
			showContent = true;
		}
	});

	return unsubscribe;
});

// Setup hash navigation
$effect(() => {
	const cleanup = setupHashNavigation(navigationStore, true);
	return cleanup;
});

// Get transition parameters based on direction with NaN safety
const transitionParams = $derived.by(() => {
	const direction = $transitionDirection;
	const isForward = direction === 'forward';

	// Ensure we always have valid numeric values to prevent NaN in animations
	const xValue = isForward ? 300 : -300;

	return {
		x: isFinite(xValue) ? xValue : 0,
		duration: isFinite(TRANSITION_DURATION) ? TRANSITION_DURATION : 300,
		easing: cubicInOut,
	};
});
</script>

<div class="relative container pt-4 pb-16 sm:pt-6 sm:pb-24">
	<!-- Loading Indicator -->
	{#if $isNavigationTransitioning}
		<div
			class="absolute inset-0 z-10 mt-20 flex items-center justify-center"
			in:fade={{ duration: 200 }}
			out:fade={{ duration: 200 }}
		>
			<div class="flex flex-col items-center space-y-4">
				<!-- Animated loading spinner -->
				<div class="relative">
					<div
						class="border-muted-foreground/20 border-t-primary h-8 w-8 animate-spin rounded-full border-4"
					></div>
					<!-- Subtle glow effect -->
					<div
						class="border-t-primary/30 absolute inset-0 h-8 w-8 animate-spin rounded-full border-4 border-transparent blur-sm"
					></div>
				</div>

				<!-- Loading text with subtle animation -->
				<div class="text-muted-foreground flex items-center space-x-1 text-sm">
					<span>Loading</span>
					<div class="flex space-x-1">
						<div class="bg-primary h-1 w-1 animate-pulse rounded-full [animation-delay:0ms]"></div>
						<div
							class="bg-primary h-1 w-1 animate-pulse rounded-full [animation-delay:150ms]"
						></div>
						<div
							class="bg-primary h-1 w-1 animate-pulse rounded-full [animation-delay:300ms]"
						></div>
					</div>
				</div>
			</div>
		</div>
	{/if}

	<!-- Error State -->
	{#if $navigationError}
		<div class="flex min-h-[200px] items-center justify-center" in:fade={{ duration: 300 }}>
			<div class="max-w-md space-y-4 text-center">
				<div
					class="bg-destructive/10 mx-auto flex h-16 w-16 items-center justify-center rounded-full"
				>
					<svg
						class="text-destructive h-8 w-8"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.232 16.5c-.77.833.192 2.5 1.732 2.5z"
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
						/>
					</svg>
				</div>
				<div>
					<h3 class="text-destructive mb-2 font-semibold">Navigation Error</h3>
					<p class="text-muted-foreground text-sm">{$navigationError}</p>
				</div>
				<button
					class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg px-4 py-2 transition-colors"
					onclick={() => enhancedNavigationStore.setError(null)}
				>
					Try Again
				</button>
			</div>
		</div>
	{:else}
		<!-- Content with smooth transitions -->
		<div class="relative min-h-[400px]">
			{#if CurrentComponent && showContent}
				<div
					in:fly={{
						...transitionParams,
						delay: TRANSITION_DURATION / 2,
					}}
					out:fly={{
						x: -transitionParams.x,
						duration: TRANSITION_DURATION / 2,
						easing: cubicInOut,
					}}
				>
					<CurrentComponent />
				</div>
			{/if}
		</div>
	{/if}

	<!-- Subtle transition overlay for smoother visual experience -->
	{#if $isNavigationTransitioning}
		<div
			class="bg-background/50 pointer-events-none absolute inset-0 backdrop-blur-[2px]"
			in:fade={{ duration: TRANSITION_DURATION / 2 }}
			out:fade={{ duration: TRANSITION_DURATION / 2 }}
		></div>
	{/if}
</div>
