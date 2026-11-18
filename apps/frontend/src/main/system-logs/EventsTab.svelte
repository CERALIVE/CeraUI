<!--
  EventsTab.svelte — the Events panel of System Logs: what happened, newest
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
import { getLocale, m } from '@ceraui/i18n/svelte';
import { EVENT_FAMILIES } from '@ceraui/rpc/schemas';
import { ListFilter, RefreshCw, TriangleAlert, WifiOff } from '@lucide/svelte';
import { onDestroy, untrack } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';

import { Button } from '$lib/components/ui/button';
import { Skeleton } from '$lib/components/ui/skeleton';
import { Toggle } from '$lib/components/ui/toggle';
import { BootList } from '$lib/device-logs/boot-list.svelte';
import { bootRows, formatBootTime } from '$lib/device-logs/boot-rows';
import { bootSelection } from '$lib/device-logs/boot-selection.svelte';
import { type AroundPage, EventsView } from '$lib/device-logs/events-view.svelte';
import { onHistoryChanged } from '$lib/device-logs/history-bus';
import { modemNames, timelineGroups } from '$lib/device-logs/timeline-groups';
import { rpc } from '$lib/rpc/client';
import { getConnectionState, setEventFeedListener } from '$lib/rpc/subscriptions.svelte';

import EventRow from './EventRow.svelte';
import ParamText from './ParamText.svelte';
import ShutdownMark from './ShutdownMark.svelte';

let { onviewraw }: { onviewraw: (around: AroundPage) => void } = $props();

// Chips sit inline only with room both ways; a 1024x600 kiosk folds them too.
const INLINE_FILTERS_QUERY = '(min-width: 768px) and (min-height: 601px)';
const TAG = 'bg-secondary text-secondary-foreground rounded-sm px-1.5 py-0.5 font-medium';
const CHIP = 'min-h-(--touch-target-min)';
const NAVIGATION: Record<string, (index: number, last: number) => number> = {
	ArrowDown: (index) => index + 1,
	ArrowUp: (index) => index - 1,
	Home: () => 0,
	End: (_, last) => last,
};

const uid = $props.id();
const inline = new MediaQuery(INLINE_FILTERS_QUERY);
let filtersOpen = $state(false);
let scroller = $state<HTMLDivElement>();
let stopId = $state<string>();

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

$effect(() => {
	const state = getConnectionState();
	untrack(() => view.connectionChanged(state));
});

const groups = $derived(timelineGroups(view.events));
const names = $derived(modemNames(view.events));
const bootInfo = $derived(new Map(bootRows(boots.boots ?? []).map((row) => [row.boot.bootId, row])));
const rowIds = $derived(
	groups.flatMap((group) => group.items.flatMap((item) => (item.kind === 'event' ? [item.event.id] : []))),
);
const tabStop = $derived(rowIds.find((id) => id === stopId) ?? rowIds[0]);

// The stop follows focus (focusin on the row), so a row whose action cannot take focus keeps none.
function navigate(event: KeyboardEvent, id: string): void {
	const move = NAVIGATION[event.key];
	if (move === undefined) return;
	event.preventDefault();
	const index = move(rowIds.indexOf(id), rowIds.length - 1);
	scroller?.querySelectorAll<HTMLElement>('[data-testid="event-row"]')[index]?.querySelector('button')?.focus();
}

function showAll(): void {
	view.showAll();
	bootSelection.choose(null);
}
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

{#snippet filters()}
	<fieldset aria-label={m['systemLogs.events.families']()} class="flex flex-wrap items-center gap-2">
		{#each EVENT_FAMILIES as family (family)}
			<Toggle
				class={CHIP}
				onPressedChange={() => view.toggleFamily(family)}
				pressed={view.filter.families.includes(family)}
				size="sm"
				variant="outline"
			>
				{m[`timeline.family.${family}`]()}
			</Toggle>
		{/each}
	</fieldset>
	<Toggle
		class={CHIP}
		onPressedChange={(pressed) => view.setProblemsOnly(pressed)}
		pressed={view.filter.problemsOnly}
		size="sm"
		variant="outline"
	>
		{m['systemLogs.events.problemsOnly']()}
	</Toggle>
{/snippet}

{#snippet failure(retry: () => void)}
	<div
		class="border-status-warning/30 bg-status-warning/10 m-3 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center"
		role="alert"
	>
		<TriangleAlert class="text-status-warning size-4 shrink-0" />
		<p class="min-w-0 flex-1 text-sm">{m['systemLogs.events.loadFailed']()}</p>
		<Button class="shrink-0 gap-1.5" onclick={retry} size="sm" variant="outline">
			<RefreshCw class="size-4" />
			{m['systemLogs.action.retry']()}
		</Button>
	</div>
{/snippet}

<div
	class="flex h-full min-h-0 flex-col [&:lang(ja)]:[word-break:auto-phrase] [&:lang(ko)]:break-keep [&:lang(zh)]:text-balance"
>
	<div class="flex flex-col gap-3 border-b px-4 py-3" data-testid="events-filters">
		{#if inline.current}
			<div class="flex flex-wrap items-center gap-x-4 gap-y-2">{@render filters()}</div>
		{:else}
			<Button
				aria-controls="{uid}-filters"
				aria-expanded={filtersOpen}
				class="data-active:bg-muted gap-1.5 self-start"
				data-active={view.filtered || undefined}
				data-testid="events-filter-toggle"
				onclick={() => (filtersOpen = !filtersOpen)}
				size="sm"
				variant="outline"
			>
				<ListFilter class="size-4" />
				{m['systemLogs.events.filter']()}
			</Button>
			<div class="flex flex-wrap items-center gap-x-4 gap-y-2" hidden={!filtersOpen} id="{uid}-filters">
				{@render filters()}
			</div>
		{/if}
	</div>
	{#if view.stale}
		<div class="text-muted-foreground flex items-start gap-2 border-b px-4 py-2 text-sm" data-testid="events-disconnected">
			<WifiOff class="mt-0.5 size-4 shrink-0" />
			<p>{m['systemLogs.follow.disconnectedBody']()}</p>
		</div>
	{/if}
	{#if view.failed === 'first'}
		{@render failure(() => void view.reload())}
	{/if}
	<div bind:this={scroller} class="min-h-0 flex-1 scroll-pt-16 overflow-y-auto overscroll-contain" data-testid="events-scroller">
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
					<Button class="mt-2" onclick={showAll} size="sm" variant="outline">{m['systemLogs.events.showAll']()}</Button>
				{:else}
					<p class="text-sm font-semibold">{m['systemLogs.events.emptyTitle']()}</p>
					<p class="text-muted-foreground max-w-prose text-sm">{m['systemLogs.events.emptyBody']()}</p>
				{/if}
			</div>
		{/if}
		{#each groups as group (group.key)}
			{const info = $derived(bootInfo.get(group.bootId))}
			<section aria-labelledby="{uid}-{group.key}" data-boot-id={group.bootId} data-testid="events-boot">
				<h3
					class="bg-muted sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-y px-4 py-2 text-xs"
					id="{uid}-{group.key}"
				>
					{#if info !== undefined}
						<time class="text-sm font-medium tabular-nums" datetime={new Date(info.boot.firstTs).toISOString()}
							><ParamText
								format={(time) => m['systemLogs.boots.started']({ time })}
								value={formatBootTime(info.boot.firstTs, getLocale())}
							/></time
						>
						<span class="text-muted-foreground flex flex-wrap gap-x-2">
							{#if info.osImage === null && info.slot === null}
								<span>{m['systemLogs.boots.versionsUnknown']()}</span>
							{:else}
								{#if info.osImage !== null}
									<span><ParamText format={(version) => m['systemLogs.boots.systemImage']({ version })} value={info.osImage} /></span>
								{/if}
								{#if info.slot !== null}
									<span><ParamText format={(slot) => m['systemLogs.boots.slot']({ slot })} value={info.slot} /></span>
								{/if}
							{/if}
						</span>
						<ShutdownMark shutdown={info.boot.shutdown} />
						{#if info.changed}
							<span class={TAG}>{m['systemLogs.boots.changed']()}</span>
						{/if}
					{:else if boots.failed}
						<span class="text-sm font-medium">{m['systemLogs.boots.loadFailed']()}</span>
					{:else if boots.boots === null}
						<span class="sr-only">{m['common.loading']()}</span>
						<Skeleton class="h-4 w-48" />
					{:else}
						<span class="text-sm font-medium">{m['systemLogs.boots.versionsUnknown']()}</span>
					{/if}
				</h3>
				<ul class="divide-y">
					{#each group.items as item (item.key)}
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
								onfocusin={() => (stopId = item.event.id)}
								onkeydown={(keyEvent) => navigate(keyEvent, item.event.id)}
								onviewraw={() => void view.viewRaw(item.event, onviewraw)}
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
			{@render failure(() => void view.loadOlder())}
		{:else if view.nextBeforeSeq !== null}
			<div class="flex justify-center px-4 py-3">
				<!-- aria-disabled, not disabled, while its page loads: the pressed button keeps keyboard focus. -->
				<Button
					aria-busy={view.loading === 'older' ? 'true' : undefined}
					aria-disabled={view.loading === 'older' ? 'true' : undefined}
					class="aria-disabled:pointer-events-none aria-disabled:opacity-50"
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
