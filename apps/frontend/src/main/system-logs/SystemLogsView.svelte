<!--
  SystemLogsView.svelte: the System Logs work surface inside LogsDialog's
  fullscreen AppDialog. Shape: apps/frontend/docs/agents/system-logs-view.md.

  Tabs Events (default) and Raw logs; at >= 1024 px a 320 px side column holds
  Boots, Storage and Downloads, below it Storage is a third tab led by Downloads.
  The tabs and the Boots and Storage regions wait for this view's lazy copy and
  one logs probe; Downloads (the two shipped downloads) renders at once and never
  waits. An older backend gets one calm notice instead of the tabs, with
  Downloads below it and no side column; any other failure a recovery band with
  Retry and, once this view's copy loaded, Support bundle. Once the tabs are
  ready the logs toolbar (Support bundle, Export logs) shares the tab strip's
  row, above the tabs below 640 px, and Downloads leads with Sharing (support
  bundle, export this view). The flows and their two dialogs live here, so any
  of those actions opens them whichever tab is showing, and they are disposed
  with the view. A panel's content mounts only while its tab is active, so a
  hidden tab never reads logs.
  Each panel owns its scroll. The downloads' state lives here, so a failed
  download keeps its retry band wherever the Downloads region remounts. When the
  tabs appear the selected tab takes focus, unless focus is already in the view.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { LogStorage } from '@ceraui/rpc/schemas';
import { Info, LifeBuoy, RefreshCw, TriangleAlert } from '@lucide/svelte';
import { onDestroy } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';

import { Button } from '$lib/components/ui/button';
import { Skeleton } from '$lib/components/ui/skeleton';
import * as Tabs from '$lib/components/ui/tabs';
import { bootSelection } from '$lib/device-logs/boot-selection.svelte';
import type { RawMoment } from '$lib/device-logs/raw-anchor';
import type { AroundPage } from '$lib/device-logs/raw-view.svelte';
import { startBackendDownload } from '$lib/device-logs/sharing';
import { SharingFlow } from '$lib/device-logs/sharing-flow.svelte';
import {
	activeTab,
	downloadsPlacement,
	type ShellStatus,
	type ShellTab,
	shellTabs,
} from '$lib/device-logs/shell-layout';
import { parseStorage } from '$lib/device-logs/storage-readout';
import { checkLogViewer } from '$lib/device-logs/viewer-availability';
import { ensureDialogNamespaces } from '$lib/i18n/namespace-activation';
import { WIDE_DESKTOP_QUERY } from '$lib/layout';
import { rpc } from '$lib/rpc/client';
import type { LogsDialogContext } from '$lib/stores/dialog-request.svelte';

import BootPicker from './BootPicker.svelte';
import BundleDialog from './BundleDialog.svelte';
import EventsPanel from './EventsPanel.svelte';
import ExportDialog from './ExportDialog.svelte';
import LegacyLogDownloads from './LegacyLogDownloads.svelte';
import { LogDownloads } from './log-downloads.svelte';
import RawLogsPanel from './RawLogsPanel.svelte';
import SharingSection from './SharingSection.svelte';
import SharingToolbar from './SharingToolbar.svelte';
import StorageSection from './StorageSection.svelte';

const TAB_LABELS: Record<ShellTab, () => string> = {
	events: () => m['systemLogs.tabs.events'](),
	raw: () => m['systemLogs.tabs.raw'](),
	storage: () => m['systemLogs.tabs.storage'](),
};

interface Props {
	/** A message's tab and moment; the Raw panel resolves its boot/window before mounting. */
	context?: LogsDialogContext;
}

let { context }: Props = $props();

const wide = new MediaQuery(WIDE_DESKTOP_QUERY);
const uid = $props.id();

let status = $state<ShellStatus>('loading');
// A failed check may still have loaded this view's copy, which the failure band's Support bundle needs.
let copyLoaded = $state(false);
let storage = $state.raw<LogStorage | null>();
const legacyDownloads = new LogDownloads();
// Each new deep link selects its tab again; the operator's own choice overrides it.
let selected = $derived<string | undefined>(context?.tab);
let anchor = $derived<RawMoment | undefined>(
	context?.tab === 'raw' && (context.at !== undefined || context.event !== undefined)
		? { at: context.at, bootId: context.bootId, event: context.event }
		: undefined,
);
let momentUnknown = $derived(context?.tab === 'raw' && context.momentUnknown === true);
let around = $state.raw<AroundPage>();
let view = $state<HTMLElement>();
let tabList = $state<HTMLElement | null>(null);
let storageHeading = $state<HTMLHeadingElement>();
let checkRun = 0;
// Export follows Raw's last view or the boot picker, whichever the operator used last.
const sharing = new SharingFlow({ logs: rpc.logs, download: startBackendDownload, picker: bootSelection });
onDestroy(() => {
	checkRun++;
	sharing.dispose();
});
// Where a sharing dialog returns focus when the control that opened it has left the page.
let toolbarBundle = $state<HTMLElement | null>(null);
let toolbarExport = $state<HTMLElement | null>(null);

const tabs = $derived(shellTabs(wide.current));
const current = $derived(activeTab(selected, tabs));
const downloads = $derived(downloadsPlacement(status, wide.current));
// Both states prove this view's lazy copy loaded, so its headings can render.
const hasCopy = $derived(status === 'ready' || status === 'unavailable');

async function check(): Promise<void> {
	const run = ++checkRun;
	let reading: unknown;
	const result = await checkLogViewer(
		async () => {
			await ensureDialogNamespaces('systemLogs');
			copyLoaded = true;
		},
		async () => {
			reading = await rpc.logs.getStorage();
		},
	);
	if (run !== checkRun) return;
	if (result === 'ready') {
		try {
			storage = parseStorage(reading);
		} catch (error) {
			// The procedure exists, so keep the tabs and let Storage offer Retry.
			console.error('System Logs storage read failed:', error);
			storage = null;
		}
	}
	status = result;
}

function retry(): void {
	status = 'loading';
	void check();
}

void check();

function selectTab(value: string): void {
	selected = value;
	anchor = undefined;
	momentUnknown = false;
	around = undefined;
}

// Keep an approximate jump on its selected tab; an exact anchor focuses its row.
$effect(() => {
	if (!tabList || view?.contains(document.activeElement)) return;
	tabList.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
});

// A Storage request focuses its heading once, in the side column or on the Storage tab;
// coming back to the tab later leaves focus on the tab.
let storageFocusedFor: LogsDialogContext | undefined;
$effect(() => {
	if (context?.tab !== 'storage' || !storageHeading || storageFocusedFor === context) return;
	storageFocusedFor = context;
	storageHeading.focus();
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
		<h3 bind:this={storageHeading} class="text-sm font-semibold outline-none focus-visible:ring-ring/50 focus-visible:ring-3" id="{uid}-storage" tabindex="-1">{m['systemLogs.storage.heading']()}</h3>
		<StorageSection bind:storage />
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
		{#if status === 'ready'}
			<SharingSection {sharing} />
		{/if}
		<div class="flex flex-col gap-3 {status === 'ready' ? 'border-t pt-3' : ''}" data-testid="downloads-files">
			{#if hasCopy}
				<h4 class="text-muted-foreground text-xs font-medium">{m['systemLogs.sharing.filesHeading']()}</h4>
			{/if}
			<LegacyLogDownloads downloads={legacyDownloads} />
		</div>
	</section>
{/snippet}

<div bind:this={view} class="flex min-h-0 flex-1" data-testid="system-logs-view">
	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		{#if status === 'ready'}
			<Tabs.Root class="min-h-0 flex-1 gap-0" onValueChange={selectTab} value={current}>
				<!-- Below 640 px each tab takes its label's width, so a long label (Spanish at 375 px) keeps to two lines,
				     and the toolbar takes its own row above the tabs so their underline stays on the rule. The toolbar comes
				     first in the DOM, so Tab still goes from the tabs straight into the panel; from 640 px it shows at the row's end. -->
				<div class="flex flex-wrap items-end gap-x-3 border-b px-4">
					<SharingToolbar
						bind:bundleButton={toolbarBundle}
						bind:exportButton={toolbarExport}
						class="ms-auto self-center py-1 max-sm:w-full max-sm:pt-3 sm:order-last"
						{sharing}
					/>
					<Tabs.List
						aria-label={m['systemLogs.tabs.label']()}
						bind:ref={tabList}
						class="w-full items-stretch gap-2 sm:w-fit"
						variant="line"
					>
						{#each tabs as tab (tab)}
							<!-- bits-ui sets data-state, not the primitive's data-active, so the selected look is set here. -->
							<Tabs.Trigger
								class="h-auto min-h-(--touch-target-min) whitespace-normal text-center max-sm:flex-auto sm:whitespace-nowrap data-[state=active]:text-foreground dark:data-[state=active]:text-foreground data-[state=active]:after:opacity-100"
								value={tab}
							>
								{TAB_LABELS[tab]()}
							</Tabs.Trigger>
						{/each}
					</Tabs.List>
				</div>
				{#each tabs as tab (tab)}
					<!-- Tab goes from the tabs straight to the panel's controls; the panel itself is no stop. -->
					<Tabs.Content class="min-h-0 overflow-y-auto" data-testid="system-logs-panel-{tab}" tabindex={-1} value={tab}>
						{#if tab === 'events' && current === 'events'}
							<EventsPanel onviewraw={(page) => { around = page; selected = 'raw'; }} />
						{/if}
						{#if tab === 'storage' && current === 'storage'}
							<div class="divide-y">
								{@render downloadsRegion()}
								{@render storageRegion()}
							</div>
						{/if}
						{#if tab === 'raw' && current === 'raw'}
							{#key anchor}
								<RawLogsPanel {anchor} {around} {momentUnknown} {sharing} />
							{/key}
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
				<!-- A phone is thumbed, so below 640 px both recovery actions take 44 px (app.css). -->
				<div class="flex shrink-0 flex-wrap gap-2" data-touch-region>
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
					{#if copyLoaded}
						<Button
							class="shrink-0 gap-1.5"
							data-testid="system-logs-check-bundle"
							data-variant="outline"
							onclick={() => void sharing.openBundle()}
							size="sm"
							variant="outline"
						>
							<LifeBuoy aria-hidden="true" class="size-4" />
							{m['systemLogs.sharing.bundle']()}
						</Button>
					{/if}
				</div>
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

<ExportDialog returnFocus={() => toolbarExport} {sharing} />
<BundleDialog returnFocus={() => toolbarBundle} {sharing} />
