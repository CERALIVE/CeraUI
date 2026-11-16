<!--
  SystemLogsView.svelte — the System Logs work surface inside LogsDialog's
  fullscreen AppDialog. Shape: apps/frontend/docs/agents/system-logs-view.md.

  Tabs Events (default) and Raw logs; at >= 1024 px a 320 px side column holds
  Boots, Storage and Downloads, below it Storage is a third tab. The tabs and the
  Boots and Storage regions wait for this view's lazy copy and one logs probe;
  Downloads (the two shipped downloads) renders at once and never waits. An older
  backend gets one calm notice instead of the tabs, with Downloads below it and
  no side column; any other failure a recovery band with Retry. Once the tabs
  are ready Downloads adds Sharing (export this view, support bundle), whose
  flows live here and are disposed with the view. A panel's
  content mounts only while its tab is active, so a hidden tab never reads logs.
  Each panel owns its scroll. The downloads' state lives here, so a failed
  download keeps its retry band wherever the Downloads region remounts. When the
  tabs appear the selected tab takes focus, unless focus is already in the view.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Info, RefreshCw, TriangleAlert } from '@lucide/svelte';
import { onDestroy } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';

import { Button } from '$lib/components/ui/button';
import { Skeleton } from '$lib/components/ui/skeleton';
import * as Tabs from '$lib/components/ui/tabs';
import { startBackendDownload } from '$lib/device-logs/sharing';
import { SharingFlow } from '$lib/device-logs/sharing-flow.svelte';
import {
	activeTab,
	downloadsPlacement,
	type ShellStatus,
	type ShellTab,
	shellTabs,
} from '$lib/device-logs/shell-layout';
import { checkLogViewer } from '$lib/device-logs/viewer-availability';
import { ensureDialogNamespaces } from '$lib/i18n/namespace-activation';
import { WIDE_DESKTOP_QUERY } from '$lib/layout';
import { rpc } from '$lib/rpc/client';

import BootPicker from './BootPicker.svelte';
import EventsPanel from './EventsPanel.svelte';
import LegacyLogDownloads from './LegacyLogDownloads.svelte';
import { LogDownloads } from './log-downloads.svelte';
import RawLogsPanel from './RawLogsPanel.svelte';
import SharingSection from './SharingSection.svelte';
import StorageSection from './StorageSection.svelte';

const TAB_LABELS: Record<ShellTab, () => string> = {
	events: () => m['systemLogs.tabs.events'](),
	raw: () => m['systemLogs.tabs.raw'](),
	storage: () => m['systemLogs.tabs.storage'](),
};

const wide = new MediaQuery(WIDE_DESKTOP_QUERY);
const uid = $props.id();

let status = $state<ShellStatus>('loading');
let selected = $state<string>();
let view = $state<HTMLElement>();
let tabList = $state<HTMLElement | null>(null);
const legacyDownloads = new LogDownloads();
const sharing = new SharingFlow({ logs: rpc.logs, download: startBackendDownload });
onDestroy(() => sharing.dispose());

const tabs = $derived(shellTabs(wide.current));
const current = $derived(activeTab(selected, tabs));
const downloads = $derived(downloadsPlacement(status, wide.current));
// Both states prove this view's lazy copy loaded, so its headings can render.
const hasCopy = $derived(status === 'ready' || status === 'unavailable');

async function check(): Promise<void> {
	status = await checkLogViewer(
		() => ensureDialogNamespaces('systemLogs'),
		() => rpc.logs.getStorage(),
	);
}

function retry(): void {
	status = 'loading';
	void check();
}

void check();

// Initial focus on the selected tab so arrow keys work at once (bits-ui put it on
// Close); never taken from where the operator already is in the view.
$effect(() => {
	if (!tabList || view?.contains(document.activeElement)) return;
	tabList.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
});
</script>

{#snippet bootsRegion()}
	<section aria-labelledby="{uid}-boots" class="flex flex-col gap-3 p-4" data-testid="system-logs-boots">
		<h3 class="text-sm font-semibold" id="{uid}-boots">{m['systemLogs.boots.heading']()}</h3>
		<BootPicker />
	</section>
{/snippet}

{#snippet storageRegion()}
	<section aria-labelledby="{uid}-storage" class="flex flex-col gap-3 p-4" data-testid="system-logs-storage">
		<h3 class="text-sm font-semibold" id="{uid}-storage">{m['systemLogs.storage.heading']()}</h3>
		<StorageSection />
	</section>
{/snippet}

{#snippet downloadsRegion()}
	<section
		aria-labelledby={hasCopy ? `${uid}-downloads` : undefined}
		class="flex flex-col gap-3 p-4"
		data-testid="system-logs-downloads"
	>
		{#if hasCopy}
			<h3 class="text-sm font-semibold" id="{uid}-downloads">{m['systemLogs.sharing.heading']()}</h3>
		{/if}
		<LegacyLogDownloads downloads={legacyDownloads} />
		{#if status === 'ready'}
			<SharingSection {sharing} />
		{/if}
	</section>
{/snippet}

<div bind:this={view} class="flex min-h-0 flex-1" data-testid="system-logs-view">
	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		{#if status === 'ready'}
			<Tabs.Root class="min-h-0 flex-1 gap-0" onValueChange={(value) => (selected = value)} value={current}>
				<div class="border-b px-4">
					<Tabs.List
						aria-label={m['systemLogs.tabs.label']()}
						bind:ref={tabList}
						class="w-full items-stretch gap-2 sm:w-fit"
						variant="line"
					>
						{#each tabs as tab (tab)}
							<!-- bits-ui sets data-state, not the primitive's data-active, so the selected look is set here. -->
							<Tabs.Trigger
								class="h-auto min-h-(--touch-target-min) whitespace-normal text-center sm:whitespace-nowrap data-[state=active]:text-foreground dark:data-[state=active]:text-foreground data-[state=active]:after:opacity-100"
								value={tab}
							>
								{TAB_LABELS[tab]()}
							</Tabs.Trigger>
						{/each}
					</Tabs.List>
				</div>
				{#each tabs as tab (tab)}
					<Tabs.Content class="min-h-0 overflow-y-auto" data-testid="system-logs-panel-{tab}" value={tab}>
						{#if tab === 'events' && current === 'events'}
							<EventsPanel onviewraw={() => (selected = 'raw')} />
						{/if}
						{#if tab === 'storage' && current === 'storage'}
							<div class="divide-y">
								{@render storageRegion()}
								{@render downloadsRegion()}
							</div>
						{/if}
						{#if tab === 'raw' && current === 'raw'}
							<RawLogsPanel />
						{/if}
					</Tabs.Content>
				{/each}
			</Tabs.Root>
		{:else if status === 'loading'}
			<div aria-busy="true" class="flex flex-col gap-3 p-4" data-testid="system-logs-loading" role="status">
				<span class="sr-only">{m['common.loading']()}</span>
				<Skeleton class="h-8 w-48" />
				{#each [0, 1, 2] as row (row)}
					<Skeleton class="h-12 w-full" />
				{/each}
			</div>
		{:else if status === 'unavailable'}
			<div class="m-4 flex items-start gap-3 rounded-lg border p-4" data-testid="system-logs-unavailable">
				<Info aria-hidden="true" class="text-muted-foreground mt-0.5 size-4 shrink-0" />
				<div class="min-w-0 space-y-1">
					<p class="text-sm font-semibold">{m['systemLogs.unavailable.title']()}</p>
					<p class="text-muted-foreground text-sm">{m['systemLogs.unavailable.body']()}</p>
				</div>
			</div>
		{:else}
			<div
				class="border-status-warning/30 bg-status-warning/10 m-4 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center"
				data-testid="system-logs-check-failed"
				role="alert"
			>
				<TriangleAlert aria-hidden="true" class="text-status-warning size-4 shrink-0" />
				<div class="min-w-0 flex-1 space-y-1">
					<p class="text-sm font-semibold">{m['errorBoundary.title']()}</p>
					<p class="text-sm">{m['errorBoundary.description']()}</p>
				</div>
				<Button
					class="shrink-0 gap-1.5"
					data-testid="system-logs-check-retry"
					onclick={retry}
					size="sm"
					variant="outline"
				>
					<RefreshCw class="size-4" />
					{m['errorBoundary.retry']()}
				</Button>
			</div>
		{/if}

		{#if downloads === 'main'}
			{@render downloadsRegion()}
		{/if}
	</div>

	{#if downloads === 'side'}
		<div class="w-80 shrink-0 divide-y overflow-y-auto border-s" data-testid="system-logs-side">
			{#if status === 'ready'}
				{@render bootsRegion()}
				{@render storageRegion()}
			{/if}
			{@render downloadsRegion()}
		</div>
	{/if}
</div>
