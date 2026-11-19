<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { RefreshCw, TriangleAlert } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';

let { busy = false, paging = false, retry }: {
	readonly busy?: boolean;
	readonly paging?: boolean;
	readonly retry: () => void;
} = $props();
</script>

<div
	class="border-status-warning/30 bg-status-warning/10 m-3 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center"
	role="alert"
>
	<TriangleAlert class="text-status-warning size-4 shrink-0" />
	<p class="min-w-0 flex-1 text-sm">{m['systemLogs.events.loadFailed']()}</p>
	<Button
		aria-busy={busy ? 'true' : undefined}
		aria-disabled={busy ? 'true' : undefined}
		class="shrink-0 gap-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-50"
		data-first-retry={!paging || undefined}
		data-paging={paging || undefined}
		onclick={retry}
		size="sm"
		variant="outline"
	>
		<RefreshCw class="size-4" />
		{m['systemLogs.action.retry']()}
	</Button>
</div>
