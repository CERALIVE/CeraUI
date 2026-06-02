<script lang="ts">
import { MediaQuery } from 'svelte/reactivity';

import LocaleSelector from '$lib/components/custom/locale-selector.svelte';
import ModeToggle from '$lib/components/custom/mode-toggle.svelte';
import { PullToRefresh } from '$lib/components/custom/pwa';
import Logo from '$lib/components/icons/Logo.svelte';
import { navElements, siteName } from '$lib/config';
import { navigateTo } from '$lib/stores/navigation.svelte';

import HudRegion from './HudRegion.svelte';
import MainNav from './navigation/MainNav.svelte';
import MobileNav from './navigation/MobileNav.svelte';
import NavigationRenderer from './navigation/NavigationRenderer.svelte';

async function handleRefresh() {
	window.location.reload();
}

const goHome = () => navigateTo({ live: navElements.live });

// Desktop (lg+) hosts the language + theme controls in the header toolbar.
// On mobile they move into the Settings destination's Appearance group, so the
// header stays uncluttered. Conditionally rendered (not just hidden) to avoid
// mounting the dropdowns twice. Mirrors AppDialog's `(min-width: 1024px)` query.
const isDesktop = new MediaQuery('(min-width: 1024px)');
</script>

<PullToRefresh onRefresh={handleRefresh}>
	<div class="flex min-h-dvh flex-col">
		<header class="bg-background sticky top-0 z-40 w-full border-b">
			<div class="container flex h-14 max-w-7xl items-center gap-4">
				<button
					class="hover:bg-accent focus-visible:ring-ring/50 flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
					aria-label={siteName}
					onclick={goHome}
				>
					<Logo class="h-6 w-6" />
					<span class="hidden text-sm font-semibold tracking-tight sm:inline-block">
						{siteName}
					</span>
				</button>

				<MainNav />

				{#if isDesktop.current}
					<div class="flex flex-1 items-center justify-end">
						<div role="toolbar" aria-label="Settings" class="flex items-center gap-1">
							<span class="contents" data-testid="header-locale-selector">
								<LocaleSelector />
							</span>
							<span class="contents" data-testid="header-theme-toggle">
								<ModeToggle />
							</span>
						</div>
					</div>
				{/if}
			</div>
		</header>

		<!-- Persistent HUD region (desktop): above the tab content, persists across destinations -->
		<HudRegion class="hidden lg:flex" />

		<main class="flex-1 pb-28 lg:pb-0">
			<NavigationRenderer></NavigationRenderer>
		</main>

		<!-- Mobile dock: 3-destination tab bar sitting ABOVE the persistent HUD region -->
		<div
			class="bg-background fixed inset-x-0 bottom-0 z-40 lg:hidden"
			style="padding-bottom: env(safe-area-inset-bottom);"
		>
			<MobileNav />
			<HudRegion />
		</div>
	</div>
</PullToRefresh>
