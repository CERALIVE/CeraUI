<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';

import { getDisplayProfile, prefersEinkTheme } from '$lib/stores/display-profile.svelte';
import { requestDisplayRefresh } from '$lib/stores/display-refresh.svelte';
import { cn } from '$lib/utils';

// Visible ONLY under the e-ink / mono profiles. The lcd profile renders nothing
// (no DOM node, no tab stop) — its HUD updates live, so a manual refresh would
// be noise. `data-display` on <html> is derived from this same store, so the
// gate stays in lock-step with the [data-display='eink'|'mono'] CSS contract.
const showRefresh = $derived(prefersEinkTheme(getDisplayProfile()));
</script>

{#if showRefresh}
	<button
		type="button"
		data-testid="display-refresh"
		aria-label={$LL.hud.refresh()}
		title={$LL.hud.refresh()}
		onclick={requestDisplayRefresh}
		class={cn(
			'fixed end-4 top-1/2 z-50 -translate-y-1/2',
			'flex size-14 items-center justify-center rounded-full',
			'border-border bg-background text-foreground border shadow-md',
			'hover:bg-accent focus-visible:ring-ring/50 transition-colors focus-visible:ring-2 focus-visible:outline-none',
		)}
	>
		<RefreshCwIcon class="size-6" aria-hidden="true" />
	</button>
{/if}
