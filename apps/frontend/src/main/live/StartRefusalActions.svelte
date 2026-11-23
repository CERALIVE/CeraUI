<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Button } from '$lib/components/ui/button';

let { primary, logs }: {
	primary: { label: string; activate: (onBlocked?: () => void) => boolean };
	logs: () => void;
} = $props();

let blocked = $state(false);
</script>

<div class="mt-2 flex flex-wrap gap-2" data-touch-region>
	<Button class="min-h-(--touch-target-min) max-w-full whitespace-normal text-start motion-reduce:transition-none" onclick={() => { blocked = !primary.activate(() => { blocked = true; }); }}>
		{primary.label}
	</Button>
	<Button class="min-h-(--touch-target-min) max-w-full whitespace-normal text-start motion-reduce:transition-none" onclick={logs} variant="outline">
		{m["notifications.viewLogs"]()}
	</Button>
</div>
<p aria-live="polite" class="empty:sr-only">{blocked ? m["live.startFailure.actionUnavailable"]() : ''}</p>
