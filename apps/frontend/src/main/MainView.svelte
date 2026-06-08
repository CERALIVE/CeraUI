<script lang="ts">
import { MediaQuery } from 'svelte/reactivity';

import LocaleSelector from '$lib/components/custom/locale-selector.svelte';
import ModeToggle from '$lib/components/custom/mode-toggle.svelte';
import { PullToRefresh } from '$lib/components/custom/pwa';
import Logo from '$lib/components/icons/Logo.svelte';
import { liveNavElement, siteName } from '$lib/config';
import { DESKTOP_CHROME_QUERY, WIDE_DESKTOP_QUERY } from '$lib/layout';
import { navigateTo } from '$lib/stores/navigation.svelte';

import HudRegion from './HudRegion.svelte';
import MainNav from './navigation/MainNav.svelte';
import MobileNav from './navigation/MobileNav.svelte';
import NavigationRenderer from './navigation/NavigationRenderer.svelte';
import NotificationsPanel from './notifications/NotificationsPanel.svelte';

async function handleRefresh() {
	window.location.reload();
}

const goHome = () => navigateTo({ live: liveNavElement });

// "Desktop chrome" (rail nav + top HUD + header toolbar) vs the mobile layout
// (bottom-dock nav + bottom HUD). Desktop chrome = `lg` (≥1024px) OR a short
// landscape kiosk panel (≥768px wide ∧ ≤600px tall, e.g. 800×480) — see
// $lib/layout. A single reactive boolean drives the WHOLE shell pivot (nav, HUD
// dock, content padding, header toolbar) so the dialog (AppDialog, same query)
// and the chrome flip together. The toolbar dropdowns are conditionally rendered
// (not just hidden) to avoid mounting them twice; on mobile they live in the
// Settings destination's Appearance group instead. Mirrors AppDialog's query.
const isDesktop = new MediaQuery(DESKTOP_CHROME_QUERY);

// The header toolbar (locale + theme) needs the FULL desktop width, not just
// desktop chrome: a short landscape panel (e.g. 800x480) can't fit the rail nav
// AND the toolbar without horizontal overflow. Below 1024px the toolbar is
// hidden and those controls live in the Settings Appearance group (SettingsView
// already renders it below 1024px, so the two stay in agreement). See $lib/layout.
const isWideDesktop = new MediaQuery(WIDE_DESKTOP_QUERY);
</script>

<PullToRefresh onRefresh={handleRefresh}>
	<div class="flex min-h-dvh flex-col">
		<HudRegion affordance />
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

				<div class="flex flex-1 items-center justify-end gap-1">
					<NotificationsPanel />
					{#if isWideDesktop.current}
						<div role="toolbar" aria-label="Settings" class="flex items-center gap-1">
							<span class="contents" data-testid="header-locale-selector">
								<LocaleSelector />
							</span>
							<span class="contents" data-testid="header-theme-toggle">
								<ModeToggle />
							</span>
						</div>
					{/if}
				</div>
			</div>
		</header>

		<!-- Persistent HUD region (desktop chrome): above the tab content, persists across destinations -->
		{#if isDesktop.current}
			<HudRegion class="flex" />
		{/if}

		<main class="flex-1" class:pb-28={!isDesktop.current}>
			<NavigationRenderer></NavigationRenderer>
		</main>

		<!-- Mobile dock: 3-destination tab bar sitting ABOVE the persistent HUD region -->
		{#if !isDesktop.current}
			<div
				class="bg-background fixed inset-x-0 bottom-0 z-40"
				style="padding-bottom: env(safe-area-inset-bottom);"
			>
				<MobileNav />
				<HudRegion />
			</div>
		{/if}
	</div>
</PullToRefresh>
