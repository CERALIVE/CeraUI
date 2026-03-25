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
	<header class="bg-background sticky top-0 z-50 w-full border-b">
		<div class="container flex h-14 max-w-7xl items-center">
			<MainNav />
			<MobileNav />
			<div class="flex flex-1 items-center justify-between space-x-2 md:justify-end">
				<nav class="flex items-center gap-1">
					<LocaleSelector />
					<ModeToggle />
				</nav>
			</div>
		</div>
	</header>

	<NavigationRenderer></NavigationRenderer>
</PullToRefresh>
