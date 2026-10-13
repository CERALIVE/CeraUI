<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import ArrowUpToLineIcon from '@lucide/svelte/icons/arrow-up-to-line';
import XIcon from '@lucide/svelte/icons/x';

import { getUpdating } from '$lib/rpc/subscriptions.svelte';
import { legacyInstallRunning } from '$lib/updates/legacy-install';

// Persistent update-in-progress banner: only while the device reports an
// install it has not finished. A retained failure object is a finished install.
const isUpdating = $derived(legacyInstallRunning(getUpdating()));
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
		<ArrowUpToLineIcon class="text-status-warning size-4 shrink-0 motion-safe:animate-pulse" />
		<span class="font-medium">{m["notifications.updateInProgress"]()}</span>
		<button
			aria-label={m["a11y.close"]()}
			class="text-muted-foreground hover:text-foreground hover:bg-status-warning/15 relative ms-auto inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
			data-testid="update-banner-dismiss"
			data-touch-target="hit-area"
			onclick={() => (updateBannerDismissed = true)}
			type="button"
		>
			<XIcon class="size-4" />
		</button>
	</div>
{/if}
