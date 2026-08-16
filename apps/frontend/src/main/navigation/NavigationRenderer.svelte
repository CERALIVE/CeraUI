<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { Component } from 'svelte';
import { cubicInOut } from 'svelte/easing';

import { einkGatedFade as fade, einkGatedFly as fly } from '$lib/transitions';

import { setupHashNavigation } from '$lib/helpers/NavigationHelper';
import {
	areDestinationNamespacesLoaded,
	ensureDestinationNamespaces,
} from '$lib/i18n/namespace-activation';
import {
	enhancedNavigationStore,
	getCurrentNavigation,
	isNavigationTransitioning,
	navigationError,
	navigationStore,
	transitionDirection,
} from '$lib/stores/navigation.svelte';

const _previousComponent: Component | undefined = $state(undefined);
let showContent = $state(true);

// Navigation transition configuration
const TRANSITION_DURATION = 300;
const _LOADING_DELAY = 150;

// Svelte 5: Use $derived for current component (no side effects)
const CurrentComponent = $derived.by(() => {
	const tab = getCurrentNavigation();
	if (tab) {
		return Object.values(tab)[0]?.component;
	}
	return undefined;
});

// Handle showContent as a side effect when component changes
$effect(() => {
	if (CurrentComponent) {
		showContent = true;
	}
});

// The destination's i18n namespaces are lazy chunks, so the view must not render
// until they are in the registry — an unresolved namespace renders every string
// as its own dotted key. This is the destination-level twin of the lazy config
// dialogs' fetch-on-first-open, and the existing transition spinner covers the
// wait. Already-loaded namespaces resolve SYNCHRONOUSLY: deferring a render by a
// promise tick when nothing needs fetching would break "the nav is active" ⇒
// "the view is on screen", which both the operator and the e2e helpers rely on.
const destinationKey = $derived(Object.keys(getCurrentNavigation())[0]);
let fetchedDestination = $state<string | undefined>(undefined);

const namespacesReady = $derived(
	destinationKey !== undefined &&
		(areDestinationNamespacesLoaded(destinationKey) ||
			fetchedDestination === destinationKey),
);

$effect(() => {
	const key = destinationKey;
	if (key === undefined || areDestinationNamespacesLoaded(key)) return;
	let active = true;
	void ensureDestinationNamespaces(key).then(() => {
		if (active) fetchedDestination = key;
	});
	return () => {
		active = false;
	};
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
		x: Number.isFinite(xValue) ? xValue : 0,
		duration: Number.isFinite(TRANSITION_DURATION) ? TRANSITION_DURATION : 300,
		easing: cubicInOut,
	};
});
</script>

<div class="relative container pt-4 pb-16 sm:pt-6 sm:pb-24">
	<!-- Loading Indicator -->
	{#if $isNavigationTransitioning}
		<div
			class="absolute inset-0 z-10 mt-20 flex items-center justify-center"
			role="status"
			aria-live="polite"
			in:fade={{ duration: 150 }}
			out:fade={{ duration: 150 }}
		>
			<span class="sr-only">{m["navigation.loading"]()}</span>
			<div class="border-primary/30 border-t-primary h-6 w-6 animate-spin rounded-full border-2"></div>
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
						aria-hidden="true"
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
					<h3 class="text-destructive mb-2 font-semibold">
						{m["navigation.navigationError"]?.() || 'Navigation Error'}
					</h3>
					<p class="text-muted-foreground text-sm">{$navigationError}</p>
				</div>
				<button
					class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg px-4 py-2 transition-colors focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none"
					onclick={() => enhancedNavigationStore.setError(null)}
				>
					{m["navigation.tryAgain"]()}
				</button>
			</div>
		</div>
	{:else}
		<!-- Content with smooth transitions -->
		<div class="relative min-h-[400px]">
			{#if CurrentComponent && showContent && namespacesReady}
				<div
					data-testid="destination-content"
					data-destination={destinationKey}
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
</div>
