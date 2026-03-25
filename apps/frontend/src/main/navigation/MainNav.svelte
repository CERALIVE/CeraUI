<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

import Logo from '$lib/components/icons/Logo.svelte';
import { ScrollArea } from '$lib/components/ui/scroll-area';
import { Separator } from '$lib/components/ui/separator';
import { type NavElements, navElements, siteName } from '$lib/config';
import {
	canGoBack,
	enhancedNavigationStore,
	getCurrentNavigation,
	isNavigationTransitioning,
	navigateTo,
} from '$lib/stores/navigation.svelte';
import { cn } from '$lib/utils';

let lastNavigationTime = 0;

const NAVIGATION_THROTTLE_MS = 50;

// Svelte 5: Use $derived for current navigation
const currentNav = $derived(getCurrentNavigation() ?? { general: navElements.general });

const handleTabNavigation = (identifier: string, navigation: Record<string, unknown>) => {
	// Add additional safety checks to prevent NaN issues
	if ($isNavigationTransitioning || !navigation || !identifier) {
		return;
	}

	const now = Date.now();
	if (now - lastNavigationTime < NAVIGATION_THROTTLE_MS) {
		return;
	}

	lastNavigationTime = now;

	navigateTo({ [identifier]: navigation } as NavElements);
};

const handleLogoClick = () => {
	if ($isNavigationTransitioning) return;

	const now = Date.now();
	if (now - lastNavigationTime < NAVIGATION_THROTTLE_MS) {
		return;
	}

	lastNavigationTime = now;

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

<!-- Brand -->
<div class="mr-6 hidden md:flex">
	<button
		class={cn(
			'group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors',
			'hover:bg-accent focus-visible:bg-accent',
			$isNavigationTransitioning && 'pointer-events-none opacity-60',
		)}
		aria-label={$canGoBack
			? ($LL?.navigation?.goBackOrHome?.() || 'Go back or home')
			: ($LL?.navigation?.goHome?.() || 'Go to home')}
		disabled={$isNavigationTransitioning}
		onclick={handleLogoClick}
	>
		<Logo class="h-6 w-6" />
		<span class="hidden text-sm font-semibold tracking-tight xl:inline-block">
			{siteName}
		</span>
	</button>
</div>

<!-- Navigation Tabs -->
<nav aria-label="Main navigation" class="hidden flex-1 md:flex">
	<ScrollArea orientation="horizontal" scrollbarXClasses="invisible">
		<div class="flex items-center gap-1 px-2">
			{#each Object.entries(navElements) as [identifier, navigation], index}
				{@const isActive =
					currentNav &&
					typeof currentNav === 'object' &&
					Object.keys(currentNav).length > 0 &&
					Object.keys(currentNav)[0] === identifier}

				{#if navigation.isDev && index > 0}
					<Separator class="mx-1.5 h-5" orientation="vertical" />
				{/if}

				<button
					id={`nav-tab-${identifier}`}
					class={cn(
						'relative flex h-11 cursor-pointer items-center justify-center rounded-lg px-3.5 text-sm font-medium transition-colors',
						isActive
							? 'bg-accent text-foreground'
							: 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
						$isNavigationTransitioning && 'pointer-events-none opacity-60',
						'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
					)}
					aria-current={isActive ? 'page' : undefined}
					disabled={$isNavigationTransitioning}
					onclick={() => handleTabNavigation(identifier, navigation)}
				>
					{$LL.navigation[navigation.label as keyof typeof $LL.navigation]()}
				</button>
			{/each}
		</div>
	</ScrollArea>
</nav>
