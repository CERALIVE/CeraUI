<!--
  RawLogsPanel.svelte — the Raw logs tab panel. The tab (its virtual list and
  live follow) is its own chunk, loaded through the house lazy registry when the
  panel first mounts, so opening System Logs on Events never fetches it. A slow
  chunk shows loading rows; a failed one states it with Retry.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { RefreshCw, TriangleAlert } from '@lucide/svelte';

import { lazyDialog } from '$lib/components/dialogs/lazy-dialog.svelte';
import { Button } from '$lib/components/ui/button';
import { Skeleton } from '$lib/components/ui/skeleton';

const chunk = lazyDialog(() => import('./RawLogsTab.svelte'));
chunk.request();

const RawLogsTab = $derived(chunk.current);
</script>

{#if RawLogsTab}
	<RawLogsTab />
{:else if chunk.failed}
	<div
		class="border-status-warning/30 bg-status-warning/10 m-4 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center"
		data-testid="raw-logs-chunk-failed"
		role="alert"
	>
		<TriangleAlert class="text-status-warning size-4 shrink-0" />
		<div class="min-w-0 flex-1 space-y-1">
			<p class="text-sm font-semibold">{m['errorBoundary.title']()}</p>
			<p class="text-sm">{m['errorBoundary.description']()}</p>
		</div>
		<Button class="shrink-0 gap-1.5" onclick={chunk.retry} size="sm" variant="outline">
			<RefreshCw class="size-4" />
			{m['errorBoundary.retry']()}
		</Button>
	</div>
{:else if chunk.pending}
	<div aria-busy="true" class="flex flex-col gap-3 p-4" data-testid="raw-logs-chunk-loading" role="status">
		<span class="sr-only">{m['systemLogs.loading.entries']()}</span>
		<Skeleton class="h-8 w-full" />
		<Skeleton class="h-12 w-full" />
		<Skeleton class="h-12 w-full" />
	</div>
{/if}
