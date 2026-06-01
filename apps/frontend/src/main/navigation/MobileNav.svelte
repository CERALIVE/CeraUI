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

const handleClick = (identifier: string, navigation: NavElements[string]) => {
	if ($isNavigationTransitioning || !navigation || !identifier) return;

	const now = Date.now();
	if (now - lastNavigationTime < NAVIGATION_THROTTLE_MS) return;
	lastNavigationTime = now;

	navigateTo({ [identifier]: navigation } as NavElements);
};

const label = (nav: NavElements[string]) =>
	nav.title ?? $LL.navigation[nav.label as keyof typeof $LL.navigation]();
</script>

<nav
	aria-label="Main navigation"
	class="bg-sidebar flex items-stretch justify-around border-t"
>
	{#each Object.entries(navElements) as [identifier, navigation] (identifier)}
		{@const isActive = activeKey === identifier}
		<button
			id={`mobile-nav-tab-${identifier}`}
			class={cn(
				'group relative flex min-h-[56px] flex-1 cursor-pointer flex-col items-center justify-center gap-1 px-1 py-2 text-[0.7rem] font-medium transition-colors',
				'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset',
				isActive ? 'text-primary' : 'text-muted-foreground active:text-foreground',
				navigation.isDev && !isActive && 'text-muted-foreground/60',
				$isNavigationTransitioning && 'pointer-events-none opacity-60',
			)}
			aria-current={isActive ? 'page' : undefined}
			disabled={$isNavigationTransitioning}
			onclick={() => handleClick(identifier, navigation)}
		>
			{#if isActive}
				<span
					class="bg-primary absolute inset-x-6 top-0 h-0.5 rounded-full"
					aria-hidden="true"
				></span>
			{/if}
			{#if navigation.icon}
				{@const Icon = navigation.icon}
				<Icon class="h-5 w-5" aria-hidden="true" />
			{/if}
			<span class="leading-none">{label(navigation)}</span>
		</button>
	{/each}
</nav>
