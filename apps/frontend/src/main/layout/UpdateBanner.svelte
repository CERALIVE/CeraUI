<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import ArrowUpToLineIcon from '@lucide/svelte/icons/arrow-up-to-line';
import XIcon from '@lucide/svelte/icons/x';

import { getUpdating } from '$lib/rpc/subscriptions.svelte';

// Persistent update-in-progress banner: true while an apt update runs
const isUpdating = $derived.by(() => {
	const updating = getUpdating();
	if (updating === true) return true;
	return typeof updating === 'object' && updating !== null && updating.result !== 0;
});
let updateBannerDismissed = $state(false);

$effect(() => {
	if (!isUpdating) updateBannerDismissed = false;
});
</script>

{#if isUpdating && !updateBannerDismissed}
	<div
		aria-live="polite"
		class="bg-status-warning/10 border-status-warning/30 text-foreground sticky top-0 z-40 flex items-center gap-2.5 border-b px-4 py-2.5 text-sm backdrop-blur-sm"
		role="status"
	>
		<ArrowUpToLineIcon class="text-status-warning size-4 shrink-0 animate-pulse" />
		<span class="font-medium">{$LL.notifications.updateInProgress()}</span>
		<button
			aria-label={$LL.a11y.close()}
			class="text-muted-foreground hover:text-foreground hover:bg-status-warning/15 ms-auto inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
			onclick={() => (updateBannerDismissed = true)}
			type="button"
		>
			<XIcon class="size-4" />
		</button>
	</div>
{/if}
