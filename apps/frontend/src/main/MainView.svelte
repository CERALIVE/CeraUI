<script lang="ts">
import LocaleSelector from '$lib/components/ui/locale-selector.svelte';
import ModeToggle from '$lib/components/ui/mode-toggle.svelte';
import { PullToRefresh } from '$lib/components/ui/pwa';

import MainNav from './navigation/MainNav.svelte';
import MobileNav from './navigation/MobileNav.svelte';
import NavigationRenderer from './navigation/NavigationRenderer.svelte';

async function handleRefresh() {
	// Refresh the page to reconnect WebSocket and reload data
	window.location.reload();
}
</script>

<PullToRefresh onRefresh={handleRefresh}>
	<header
		class="border-border/40 bg-background/95 supports-backdrop-filter:bg-background/60 sticky top-0 z-50 w-full border-b shadow-sm backdrop-blur-md"
	>
		<div class="container flex h-16 max-w-7xl items-center">
			<MainNav />
			<MobileNav />
			<div class="flex flex-1 items-center justify-between space-x-2 md:justify-end">
				<div class="w-full flex-1 md:w-auto md:flex-none"></div>
				<nav class="flex items-center">
					<span class="mr-3"> <LocaleSelector /></span>
					<span><ModeToggle /></span>
				</nav>
			</div>
		</div>
	</header>

	<NavigationRenderer></NavigationRenderer>
</PullToRefresh>
