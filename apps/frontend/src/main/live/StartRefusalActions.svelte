<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { X } from '@lucide/svelte';
import { Button } from '$lib/components/ui/button';

let { primary, logs, message, close }: {
	primary: { label: string; activate: (onBlocked?: () => void) => boolean };
	logs: () => void;
	message: string;
	close: () => void;
} = $props();

let blocked = $state(false);
</script>

<!-- A focusable scroll area keeps the cause readable even when only one line fits. -->
<section class="refusal-copy" aria-label={m["notifications.panel.title"]()}>
	<p>{message}</p>
	<p aria-live="polite" class="empty:sr-only">{blocked ? m["live.startFailure.actionUnavailable"]() : ''}</p>
</section>
<div class="refusal-actions flex shrink-0 flex-wrap gap-2" data-touch-region>
	<Button class="min-h-(--touch-target-min) max-w-full whitespace-normal text-start motion-reduce:transition-none" onclick={() => { blocked = !primary.activate(() => { blocked = true; }); }}>
		{primary.label}
	</Button>
	<Button class="min-h-(--touch-target-min) max-w-full whitespace-normal text-start motion-reduce:transition-none" onclick={logs} variant="outline">
		{m["notifications.viewLogs"]()}
	</Button>
	<Button aria-label={m["a11y.close"]()} class="min-h-(--touch-target-min) min-w-(--touch-target-min)" onclick={close} size="icon" variant="ghost"><X aria-hidden="true" /></Button>
</div>

<style>
	.refusal-copy {
		min-height: 1lh;
		overflow: auto;
		overscroll-behavior: contain;
		font-size: var(--text-sm);
		line-height: 1.25;
	}

	@media (width < 40rem) and (height <= 25rem) {
		.refusal-actions {
			display: grid;
			grid-template-columns: minmax(0, 3fr) minmax(0, 2fr) 44px;
			gap: 0.25rem;
		}

		.refusal-actions :global(button) {
			padding-inline: 0.25rem;
			line-height: 1;
			overflow-wrap: anywhere;
		}
	}
</style>
