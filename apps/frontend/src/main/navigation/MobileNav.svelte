<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { ChevronLeft, Menu, X } from '@lucide/svelte';

import Logo from '$lib/components/icons/Logo.svelte';
import { Button } from '$lib/components/ui/button';
import MobileLink from '$lib/components/ui/mobile-link.svelte';
import { ScrollArea } from '$lib/components/ui/scroll-area';
import { Separator } from '$lib/components/ui/separator';
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

	setTimeout(() => {
		if (nav && typeof nav === 'object' && Object.keys(nav).length > 0) {
			navigateTo(nav);
		} else {
			console.warn('[MobileNav] Invalid nav object, skipping navigation:', nav);
		}
		open = false;
	}, 75);
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
			class="mr-2 md:hidden"
			disabled={$isNavigationTransitioning}
			variant="ghost"
			size="icon"
		>
			{#if open}
				<X class="h-5 w-5" />
			{:else}
				<Menu class="h-5 w-5" />
			{/if}
			<span class="sr-only">
				{open ? $LL.navigation.closeMenu() : $LL.navigation.toggleMenu()}
			</span>
		</Button>
	</Sheet.Trigger>

	<Sheet.Content class="w-80 pt-4 pr-0" side="left">
		<div class="border-b px-4 pb-4">
			{#if $canGoBack}
				<div class="mb-3">
					<button
						class="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm transition-colors"
						disabled={$isNavigationTransitioning}
						onclick={handleBack}
					>
						<ChevronLeft class="h-4 w-4" />
						<span>{$LL.navigation.back()}</span>
					</button>
				</div>
			{/if}

			<button
				class="hover:bg-accent flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 transition-colors"
				disabled={$isNavigationTransitioning}
				onclick={handleLogoClick}
			>
				<Logo class="h-5 w-5" />
				<span class="text-base font-semibold">{siteName}</span>
			</button>
		</div>

		<ScrollArea class="flex-1 px-4 pt-3" orientation="both">
			<div class="flex flex-col gap-1 pb-10">
				{#each Object.entries(navElements) as [identifier, navigation], index}
					{@const isActive =
						currentNav &&
						typeof currentNav === 'object' &&
						Object.keys(currentNav).length > 0 &&
						Object.keys(currentNav)[0] === identifier}

					{#if identifier}
						{#if navigation.isDev && index > 0}
							<Separator class="my-2" />
						{/if}

						<MobileLink
							class={cn(
								'transition-colors',
								$isNavigationTransitioning && isActive && 'opacity-60',
							)}
							disabled={$isNavigationTransitioning}
							{identifier}
							{isActive}
							onclick={() => {
								if (identifier && navigation && typeof navigation === 'object') {
									handleClick({ [identifier]: navigation });
								}
							}}
						>
							{#snippet children()}
								<div class="flex w-full items-center justify-between">
									<span>{$LL.navigation[navigation?.label as keyof typeof $LL.navigation]()}</span>
									{#if isActive}
										<div class="bg-primary h-1.5 w-1.5 rounded-full"></div>
									{/if}
								</div>
							{/snippet}
						</MobileLink>
					{/if}
				{/each}
			</div>
		</ScrollArea>
	</Sheet.Content>
</Sheet.Root>
