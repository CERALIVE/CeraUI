<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

import { type NavElements, navElements } from '$lib/config';
import {
	getCurrentNavigation,
	isNavigationTransitioning,
	navigateTo,
} from '$lib/stores/navigation.svelte';
import { cn } from '$lib/utils';

let lastNavigationTime = 0;
const NAVIGATION_THROTTLE_MS = 50;

const currentNav = $derived(getCurrentNavigation() ?? { live: navElements.live });
const activeKey = $derived(Object.keys(currentNav)[0] ?? 'live');

const handleTabNavigation = (identifier: string, navigation: NavElements[string]) => {
	if ($isNavigationTransitioning || !navigation || !identifier) return;

	const now = Date.now();
	if (now - lastNavigationTime < NAVIGATION_THROTTLE_MS) return;
	lastNavigationTime = now;

	navigateTo({ [identifier]: navigation } as NavElements);
};

const label = (nav: NavElements[string]) =>
	nav.title ?? $LL.navigation[nav.label as keyof typeof $LL.navigation]();
</script>

<nav aria-label="Main navigation" class="hidden flex-1 items-center justify-center lg:flex">
	<div class="flex items-center gap-1">
		{#each Object.entries(navElements) as [identifier, navigation] (identifier)}
			{@const isActive = activeKey === identifier}
			<button
				id={`nav-tab-${identifier}`}
				class={cn(
					'group relative flex h-11 cursor-pointer items-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors',
					'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
					isActive
						? 'text-foreground'
						: 'text-muted-foreground hover:text-foreground hover:bg-accent/40',
					navigation.isDev && 'text-muted-foreground/70',
					$isNavigationTransitioning && 'pointer-events-none opacity-60',
				)}
				aria-current={isActive ? 'page' : undefined}
				disabled={$isNavigationTransitioning}
				onclick={() => handleTabNavigation(identifier, navigation)}
			>
				{#if navigation.icon}
					{@const Icon = navigation.icon}
					<Icon class="h-4 w-4" aria-hidden="true" />
				{/if}
				<span>{label(navigation)}</span>
				{#if isActive}
					<span
						class="bg-primary absolute inset-x-2.5 -bottom-px h-0.5 rounded-full"
						aria-hidden="true"
					></span>
				{/if}
			</button>
		{/each}
	</div>
</nav>
