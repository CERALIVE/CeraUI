<!--
  EventsTab.svelte: the Events panel of System Logs: what happened, newest
  first, under one sticky heading per boot carrying its start, system image,
  slot and how it ended. Family chips and Problems only filter it, folded behind
  Filter on a narrow or short screen; the boot comes from the boot picker. Each
  mount builds its own view and reads the first page, listens for pushed events
  while mounted, and re-reads from the start when stored history is deleted.
  The list region owns the scroll below the fixed filter bar and is one tab
  stop, a row's first action: arrow keys, Home and End move it between rows,
  and Tab reaches that row's other actions. Korean breaks
  between words, Japanese between phrases and Chinese lines are balanced, so no
  sentence ending is stranded; long recorded values still wrap inside their row.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { DeviceEvent } from '@ceraui/rpc/schemas';
import { WifiOff } from '@lucide/svelte';
import { onDestroy, tick, untrack } from 'svelte';

import { Button } from '$lib/components/ui/button';
import { Skeleton } from '$lib/components/ui/skeleton';
import { BootList } from '$lib/device-logs/boot-list.svelte';
import { bootRows } from '$lib/device-logs/boot-rows';
import { bootSelection } from '$lib/device-logs/boot-selection.svelte';
import { type AroundPage, EventsView } from '$lib/device-logs/events-view.svelte';
import { EVENT_ROW_CAP } from '$lib/device-logs/events-window';
import { onHistoryChanged } from '$lib/device-logs/history-bus';
import { modemNames, timelineGroups } from '$lib/device-logs/timeline-groups';
import { rpc } from '$lib/rpc/client';
import { getSessionReady, setEventFeedListener } from '$lib/rpc/subscriptions.svelte';

import EventRow from './EventRow.svelte';
import EventsBootHeading from './EventsBootHeading.svelte';
import EventsFilters from './EventsFilters.svelte';
import EventsLoadFailure from './EventsLoadFailure.svelte';

let { onviewraw }: { onviewraw: (around: AroundPage) => void } = $props();

const NAVIGATION: Record<string, (index: number, last: number) => number> = {
	ArrowDown: (index) => index + 1,
	ArrowUp: (index) => index - 1,
	Home: () => 0,
	End: (_, last) => last,
};

const uid = $props.id();
let scroller = $state<HTMLDivElement>();
let stopId = $state<string>();
let focusedRow = $state.raw<DeviceEvent>();
let returningToNewest = $state(false);
let focusAfterReset = $state.raw<Element>();
let previousHistoryRevision = 0;

const view = new EventsView(
	{
		list: (input) => rpc.events.list(input),
		around: (input) => rpc.logs.around(input),
		setFeedListener: setEventFeedListener,
	},
	bootSelection.bootId,
);
void view.reload();
const boots = new BootList(() => rpc.logs.boots());
void boots.load();
onDestroy(
	onHistoryChanged(() => {
		void view.reload();
		void boots.load();
	}),
);
onDestroy(bootSelection.onChoose((bootId) => view.setBoot(bootId)));
onDestroy(() => view.dispose());

// A pick while the lookup is out is the later action: its reply does not open Raw logs.
function viewRaw(event: DeviceEvent): void {
	const still = bootSelection.since();
	void view.viewRaw(event, (page) => {
		if (still()) onviewraw(page);
	});
}

$effect(() => {
	const ready = getSessionReady();
	untrack(() => view.connectionChanged(ready ? 'connected' : 'disconnected'));
});

$effect.pre(() => {
	const { keepShownFocus } = view.rowReset;
	untrack(() => {
		const sameHistory = previousHistoryRevision === view.historyRevision;
		previousHistoryRevision = view.historyRevision;
		if (sameHistory && keepShownFocus && view.events.some((event) => event.id === focusedRow?.id)) return;
		const active = document.activeElement;
		if (active && scroller?.contains(active)) focusAfterReset = active;
		focusedRow = stopId = undefined;
	});
});

$effect(() => {
	const previous = focusAfterReset;
	if (previous === undefined || view.loading !== null) return;
	untrack(() => {
		if (!previous.isConnected && document.activeElement === document.body)
			(eventAction(0) ?? firstFilter())?.focus();
		focusAfterReset = undefined;
	});
});

// Keep the exact keyed row and its active control until focus leaves it.
const visibleEvents = $derived(
	focusedRow && !view.events.some((event) => event.id === focusedRow?.id)
		? [...(view.browsingHistory ? view.events.slice(1 - EVENT_ROW_CAP) : view.events.slice(0, EVENT_ROW_CAP - 1)), focusedRow].sort((a, b) => b.seq - a.seq)
		: view.events,
);
const groups = $derived(timelineGroups(visibleEvents));
const names = $derived(modemNames(view.events));
const bootInfo = $derived(new Map(bootRows(boots.boots ?? []).map((row) => [row.boot.bootId, row])));
const rowIds = $derived(
	groups.flatMap((group) => group.items.flatMap((item) => (item.kind === 'event' ? [item.event.id] : []))),
);
const tabStop = $derived(rowIds.find((id) => id === stopId) ?? rowIds[0]);
const newestLabel = $derived(
	view.newWhileBrowsing > 0
		? view.newCountIncomplete
			? m['systemLogs.events.startFromNewestAtLeast']({ count: view.newWhileBrowsing })
			: m['systemLogs.events.startFromNewestCount']({ count: view.newWhileBrowsing })
		: view.newCountIncomplete
			? m['systemLogs.events.startFromNewestUnknown']()
			: m['systemLogs.error.startFromNewest'](),
);

function firstFilter(): HTMLButtonElement | null | undefined {
	return scroller?.parentElement?.querySelector<HTMLButtonElement>('[data-testid="events-filters"] button');
}

function eventAction(index: number): HTMLButtonElement | null | undefined {
	return scroller?.querySelectorAll('[data-testid="event-row"]')[index]?.querySelector('button');
}

async function returnToNewest(event: MouseEvent): Promise<void> {
	if (returningToNewest) return;
	const button = event.currentTarget;
	// Keep the focused control mounted until its replacement is ready.
	returningToNewest = true;
	await view.reload();
	await tick();
	if (document.activeElement === button) {
		const retry = scroller?.parentElement?.querySelector<HTMLButtonElement>('[data-first-retry]');
		(eventAction(0) ?? retry ?? firstFilter())?.focus();
	}
	returningToNewest = false;
}

// A successful check removes its Retry; focus left on it moves to the filter bar.
async function checkLiveEdge(): Promise<void> {
	const retry = document.activeElement;
	await view.checkLiveEdge();
	await tick();
	if (retry !== null && !retry.isConnected && document.activeElement === document.body) firstFilter()?.focus();
}

// The stop follows focus (focusin on the row), so a row whose action cannot take focus keeps none.
function navigate(event: KeyboardEvent, id: string): void {
	const move = NAVIGATION[event.key];
	if (move === undefined) return;
	event.preventDefault();
	eventAction(move(rowIds.indexOf(id), rowIds.length - 1))?.focus();
}

// Set, a new object per landing, when an older-page control held focus as its page landed: focus
// moves to Load older events or Retry after the page, or to the list's row stop when neither is shown.
let pressed = $state.raw<object>();

$effect.pre(() => {
	if (view.loading !== null) return;
	untrack(() => {
		const paging = focusAfterReset === undefined && document.activeElement?.hasAttribute('data-paging');
		pressed = paging ? {} : undefined;
	});
});

$effect(() => {
	if (pressed === undefined) return;
	untrack(() => {
		const next = scroller?.querySelector<HTMLElement>('[data-paging]');
		if (next) next.focus();
		else if (view.browsingHistory) eventAction(rowIds.length - 1)?.focus();
		else if (tabStop !== undefined) eventAction(rowIds.indexOf(tabStop))?.focus();
	});
});

</script>

{#snippet skeletonRows(count: number)}
	{#each Array.from({ length: count }, (_, index) => index) as index (index)}
		<div class="flex gap-3 px-4 py-3">
			<Skeleton class="size-4 shrink-0 rounded-full" />
			<div class="flex-1 space-y-2">
				<Skeleton class="h-4 w-1/2" />
				<Skeleton class="h-3 w-3/4" />
			</div>
		</div>
	{/each}
{/snippet}

<div
	class="flex h-full min-h-0 flex-col [&:lang(ja)]:[word-break:auto-phrase] [&:lang(ko)]:break-keep [&:lang(zh)]:text-balance"
>
	<EventsFilters {view} />
	{#if view.stale}
		<div class="text-muted-foreground flex items-start gap-2 border-b px-4 py-2 text-sm" data-testid="events-disconnected">
			<WifiOff class="mt-0.5 size-4 shrink-0" />
			<p>{m['systemLogs.follow.disconnectedBody']()}</p>
		</div>
	{/if}
	{#if view.failed === 'first'}
		<EventsLoadFailure retry={() => void view.reload()} />
	{:else if view.liveEdgeFailed}
		<EventsLoadFailure busy={view.loading === 'first'} retry={() => void checkLiveEdge()} />
	{/if}
	{#if view.browsingHistory || returningToNewest}
		<div class="flex justify-center border-b px-4 py-2">
			<Button
				aria-busy={returningToNewest || undefined}
				aria-disabled={returningToNewest || undefined}
				class="h-auto min-h-7 max-w-full py-1 text-center text-balance whitespace-normal aria-disabled:pointer-events-none aria-disabled:opacity-50"
				onclick={returnToNewest}
				size="sm"
				variant="outline"
				>{newestLabel}</Button
			>
		</div>
	{/if}
	<div bind:this={scroller} class="min-h-0 flex-1 scroll-pt-16 overflow-y-auto overscroll-contain" data-testid="events-scroller"
		onfocusout={(event) => {
			const row = event.target instanceof Element && event.target.closest('[data-testid="event-row"]');
			if (row && !(event.relatedTarget instanceof Node && row.contains(event.relatedTarget))) focusedRow = undefined;
		}}
	>
		<!-- A re-read for a skipped seq keeps its rows until the page arrives, with no loading rows above them. -->
		{#if view.loading === 'first' && view.events.length === 0}
			<div aria-busy="true" data-testid="events-loading" role="status">
				<span class="sr-only">{m['systemLogs.loading.events']()}</span>
				{@render skeletonRows(4)}
			</div>
		{:else if view.events.length === 0 && view.failed === null}
			<div class="flex flex-col items-center gap-2 px-6 py-10 text-center" data-testid="events-empty">
				{#if view.filtered}
					<p class="text-sm font-semibold">{m['systemLogs.events.emptyFiltered']()}</p>
					<Button class="mt-2" onclick={() => { view.showAll(); bootSelection.choose(null); }} size="sm" variant="outline">{m['systemLogs.events.showAll']()}</Button>
				{:else}
					<p class="text-sm font-semibold">{m['systemLogs.events.emptyTitle']()}</p>
					<p class="text-muted-foreground max-w-prose text-sm">{m['systemLogs.events.emptyBody']()}</p>
				{/if}
			</div>
		{/if}
		{#each groups as group (group.key)}
			{const info = $derived(bootInfo.get(group.bootId))}
			<section aria-labelledby="{uid}-{group.key}" data-boot-id={group.bootId} data-testid="events-boot">
				<EventsBootHeading id="{uid}-{group.key}" {info} {boots} />
				<ul class="divide-y">
					{#each group.items as item (`${view.historyRevision}:${item.key}`)}
						{#if item.kind === 'clock'}
							<li
								class="text-muted-foreground before:bg-border after:bg-border flex items-center gap-3 px-4 py-2 text-xs before:h-px before:flex-1 after:h-px after:flex-1"
								data-testid="events-clock"
							>
								{m['systemLogs.marker.clockChanged']()}
							</li>
						{:else}
							<EventRow
								event={item.event}
								{names}
								onfocusin={() => { stopId = item.event.id; focusedRow = item.event; }}
								onkeydown={(keyEvent) => navigate(keyEvent, item.event.id)}
								onviewraw={() => viewRaw(item.event)}
								rawLink={view.rawLink?.id === item.event.id ? view.rawLink.state : null}
								stale={view.stale}
								stop={item.event.id === tabStop}
							/>
						{/if}
					{/each}
				</ul>
			</section>
		{/each}
		{#if view.loading === 'older'}
			<div data-testid="events-loading-older">{@render skeletonRows(2)}</div>
		{/if}
		{#if view.failed === 'older'}
			<EventsLoadFailure busy={view.loading === 'older'} paging retry={() => void view.loadOlder()} />
		{:else if view.nextBeforeSeq !== null}
			<div class="flex justify-center px-4 py-3">
				<!-- aria-disabled, not disabled, while its page loads: the pressed button keeps keyboard focus. -->
				<Button
					aria-busy={view.loading === 'older' ? 'true' : undefined}
					aria-disabled={view.loading === 'older' ? 'true' : undefined}
					class="aria-disabled:pointer-events-none aria-disabled:opacity-50"
					data-paging
					onclick={() => void view.loadOlder()}
					size="sm"
					variant="outline">{m['systemLogs.events.loadOlder']()}</Button
				>
			</div>
		{:else if view.events.length > 0}
			<p
				class="text-muted-foreground before:bg-border after:bg-border flex items-center gap-3 px-4 py-3 text-xs before:h-px before:flex-1 after:h-px after:flex-1"
				data-testid="events-end"
			>
				{m['systemLogs.events.noOlder']()}
			</p>
		{/if}
	</div>
</div>
