<!--
  RawLogsPanel.svelte: the Raw logs tab panel. The tab (its virtual list and
  live follow) is its own chunk, loaded through the house lazy registry when the
  panel first mounts, so opening System Logs on Events never fetches it. A slow
  chunk shows loading rows; a failed one states it with Retry. A message's
  moment (its event, else its own time) resolves to a validated around page
  before the tab mounts, and to the newest entries when neither is known, which
  the tab then says; closing or replacing the request discards its late reply.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { LogAroundOutput } from '@ceraui/rpc/schemas';
import { RefreshCw, TriangleAlert } from '@lucide/svelte';
import { onDestroy, untrack } from 'svelte';

import { lazyDialog } from '$lib/components/dialogs/lazy-dialog.svelte';
import { Button } from '$lib/components/ui/button';
import { Skeleton } from '$lib/components/ui/skeleton';
import { locateMoment, type RawMoment } from '$lib/device-logs/raw-anchor';
import type { SharingFlow } from '$lib/device-logs/sharing-flow.svelte';
import { rpc } from '$lib/rpc/client';

// `linkStill`: false once a boot was picked after the link (the anchor or `around`) was issued.
let { anchor, around, linkStill = () => true, momentUnknown = false, sharing }: { anchor?: RawMoment; around?: Extract<LogAroundOutput, { ok: true }>; linkStill?: () => boolean; momentUnknown?: boolean; sharing?: SharingFlow } = $props();
const publisher = untrack(() => sharing?.bindView());
let result = $state.raw<LogAroundOutput | null>(untrack(() => around ?? null));
let pending = $state(false);
// The lookup found neither the message's event nor its own time.
let missed = $state(false);
let request: AbortController | undefined;

async function locate(): Promise<void> {
	if (anchor === undefined || !linkStill()) return;
	request?.abort();
	const current = new AbortController();
	request = current;
	result = null;
	pending = true;
	const reply = await locateMoment(rpc, anchor, current.signal);
	if (current.signal.aborted || !linkStill()) return;
	result = reply;
	missed = reply === null;
	pending = false;
}

function latest(): void {
	request?.abort();
	result = null;
	pending = false;
}

void untrack(locate);
onDestroy(() => {
	request?.abort();
	publisher?.dispose();
});

const chunk = lazyDialog(() => import('./RawLogsTab.svelte'));
chunk.request();

const RawLogsTab = $derived(chunk.current);

// A pick after the link was issued outranks it, also one made before this panel mounted (the view
// still loading): the tab opens on the pick. Once the tab shows the link, Raw follows later picks itself.
const superseded = $derived(!linkStill());
$effect(() => {
	if (superseded) request?.abort();
});
</script>

{#if result?.ok === false && !superseded}
	<div
		class="border-status-warning/30 bg-status-warning/10 m-3 flex flex-col gap-3 rounded-lg border p-3"
		data-testid="raw-anchor-failure"
		role="alert"
	>
		<div class="flex items-start gap-3">
			<TriangleAlert aria-hidden="true" class="text-status-warning size-4 shrink-0" />
			<p class="text-sm">{result.error === 'BOOT_UNAVAILABLE'
					? m['systemLogs.error.bootRemoved']()
					: result.error === 'BUSY'
						? m['systemLogs.error.busy']()
						: m['systemLogs.error.readFailed']()}</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button onclick={() => void locate()} size="sm" variant="outline">{m['systemLogs.action.retry']()}</Button>
			<Button onclick={latest} size="sm" variant="ghost">{m['systemLogs.anchor.leave']()}</Button>
		</div>
	</div>
{:else if RawLogsTab && (!pending || superseded)}
	<RawLogsTab around={!superseded && result?.ok ? result : undefined} momentUnknown={!superseded && (momentUnknown || missed)} onquery={publisher?.publish} />
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
{:else if chunk.pending || pending}
	<div aria-busy="true" class="flex flex-col gap-3 p-4" data-testid="raw-logs-chunk-loading" role="status">
		<span class="sr-only">{m['systemLogs.loading.entries']()}</span>
		<Skeleton class="h-8 w-full" />
		<Skeleton class="h-12 w-full" />
		<Skeleton class="h-12 w-full" />
	</div>
{/if}
