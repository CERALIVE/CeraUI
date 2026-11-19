<!--
  RawLogList.svelte: the Raw logs list, the tab's one scroll owner. A virtual
  list (@tanstack/svelte-virtual) of measured rows, so wrapped and expanded rows
  keep their height; it is a plain list, never a live region. The list is one
  tab stop: arrow keys, Home and End move between entries. Follow entries that
  arrive while it is scrolled away wait behind a New entries button, so nothing
  moves the reading position. Paging controls sit at each end it can page.
-->
<script lang="ts">
import { getLocale, m } from '@ceraui/i18n/svelte';
import { createVirtualizer } from '@tanstack/svelte-virtual';
import { tick, untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';

import { Button } from '$lib/components/ui/button';
import { Skeleton } from '$lib/components/ui/skeleton';
import { type DisplayRow, displayRows, ROW_CAP, withMoment } from '$lib/device-logs/raw-rows';
import type { RawEdge, RawEnd, RawView } from '$lib/device-logs/raw-view.svelte';

import RawLogRow from './RawLogRow.svelte';

let { view }: { view: RawView } = $props();

const BUSY = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';
const NAVIGATION: Record<string, (index: number, last: number) => number> = {
	ArrowDown: (index) => index + 1,
	ArrowUp: (index) => index - 1,
	Home: () => 0,
	End: (_, last) => last,
};

let scroller = $state<HTMLDivElement>();
let focusKey = $state<string>();
let pendingFocus = $state(untrack(() => view.anchor?.cursor ?? undefined));
const expanded = new SvelteSet<string>();

// An approximate window's older half reads up to the selected moment, so that bound marks where it falls.
const moment = $derived(view.anchor?.approximate ? view.bottom?.query.until : undefined);
const rows = $derived.by(() => {
	const display = displayRows(view.rows, view.newestFirst);
	return moment === undefined ? display : withMoment(display, moment);
});
const entryKeys = $derived(
	rows.flatMap((row) => (row.kind === 'entry' && row.entry.marker === null ? [row.key] : [])),
);
const timeFormat = $derived(
	new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
);
const dateFormat = $derived(new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }));
const heldCount = $derived(view.held.filter((row) => row.kind === 'entry').length);

const virtualizer = createVirtualizer<HTMLDivElement, HTMLLIElement>({
	count: 0,
	getScrollElement: () => scroller ?? null,
	estimateSize: () => 36,
	overscan: 12,
});

// The scroller height the virtualizer has measured: none until it has the scroller laid out.
const viewport = $derived($virtualizer.scrollRect?.height);

const tabKey = $derived.by(() => {
	const top = scroller?.scrollTop ?? 0;
	const bottom = top + (scroller?.clientHeight ?? 0);
	const visibleKeys = new Set(
		$virtualizer.getVirtualItems().filter((item) => item.end > top && item.start < bottom).map((item) => item.key),
	);
	const choices = entryKeys.filter((key) => visibleKeys.has(key));
	return choices.find((key) => key === focusKey) ?? choices.find((key) => key === view.anchor?.cursor) ?? choices[0];
});

// Before the template reads the virtual items, so they always match `rows`;
// re-run once the scroll element exists so the virtualizer can measure it.
$effect.pre(() => {
	const shown = rows;
	if (scroller === undefined) return;
	untrack(() =>
		$virtualizer.setOptions({
			count: shown.length,
			getItemKey: (index: number) => (shown[index] as DisplayRow).key,
		}),
	);
});

// Brings a row that keyboard or anchor focus targets into the rendered range,
// once the virtualizer has a viewport: a scroll issued before that is lost.
$effect(() => {
	const key = pendingFocus;
	if (key === undefined || !viewport) return;
	untrack(() => $virtualizer.scrollToIndex(rows.findIndex((row) => row.key === key), { align: 'auto' }));
});

// The end whose paging button held focus as its page landed, a new object per landing: focus
// moves to that end's paging button after the page, else to the row stop, Reset filters or the list.
let pressed = $state.raw<{ end: RawEnd }>();
let top = $state<HTMLDivElement>();

$effect.pre(() => {
	if (view.loading !== null) return;
	const end = document.activeElement?.getAttribute('data-paging');
	untrack(() => (pressed = end === 'top' || end === 'bottom' ? { end } : undefined));
});

$effect(() => {
	const landed = pressed;
	if (landed === undefined) return;
	untrack(() => {
		const next = (landed.end === 'top' ? top : scroller)?.querySelector<HTMLElement>('[data-paging]');
		if (next) next.focus();
		else if (tabKey !== undefined) pendingFocus = tabKey;
		else (scroller?.querySelector<HTMLElement>('[data-testid="raw-reset-filters"]') ?? scroller)?.focus();
	});
});

function focusRow(node: HTMLLIElement): void {
	node.querySelector('button')?.focus();
	pendingFocus = undefined;
}

function measure(node: HTMLLIElement): void {
	untrack(() => $virtualizer.measureElement(node));
}

function toggle(key: string): void {
	focusKey = key;
	if (expanded.has(key)) expanded.delete(key);
	else expanded.add(key);
}

function navigate(event: KeyboardEvent, currentKey: string): void {
	const move = NAVIGATION[event.key];
	if (move === undefined) return;
	event.preventDefault();
	const key = entryKeys[move(entryKeys.indexOf(currentKey), entryKeys.length - 1)];
	if (key === undefined) return;
	focusKey = key;
	pendingFocus = key;
}

function showHeld(): void {
	view.showHeld();
	(scroller as HTMLDivElement).scrollTop = 0;
}

async function readGap(action: HTMLElement, gap: { key: string; continuation: string }): Promise<void> {
	const focused = document.activeElement === action;
	const next = await view.loadGap(gap.key, gap.continuation);
	await tick();
	if (!focused || action.isConnected || document.activeElement !== document.body) return;
	if (typeof next === 'string') pendingFocus = next;
	else if (next === null || view.rows.some((row) => row.key === gap.key && row.kind === 'marker' && row.gapError))
		scroller?.focus();
}
</script>

{#snippet skeletonRows(count: number)}
	{#each Array.from({ length: count }, (_, index) => index) as index (index)}
		<div class="flex gap-3 px-4 py-2">
			<Skeleton class="size-4 rounded-full" />
			<div class="flex-1 space-y-1.5">
				<Skeleton class="h-3 w-32" />
				<Skeleton class="h-3 w-full" />
			</div>
		</div>
	{/each}
{/snippet}

{#snippet edge(end: RawEnd, state: RawEdge | null)}
	{const busy = $derived(view.loading === end ? 'true' : undefined)}
	<!-- aria-disabled, not disabled, while this end loads: the pressed button keeps keyboard focus. -->
	{#if busy}
		<div data-testid="raw-loading-{end}">{@render skeletonRows(2)}</div>
	{/if}
	{#if end === 'bottom' && view.capped}
		<p class="text-muted-foreground px-4 py-3 text-center text-xs" data-testid="raw-cap">
			{m['systemLogs.raw.capReached']({ count: ROW_CAP })}
		</p>
	{:else if state !== null && !state.lost && view.loading !== 'first'}
		{#if state.hasMore === true}
			<div class="flex justify-center px-4 py-3">
				<Button
					aria-busy={busy}
					aria-disabled={busy}
					class={BUSY}
					data-paging={end}
					data-testid="raw-load-more-{end}"
					onclick={() => view.loadMore(end)}
					size="sm"
					variant="outline"
				>
					{m['systemLogs.raw.loadMore']()}
				</Button>
			</div>
		{:else if state.hasMore === null}
			<div class="flex flex-col items-center gap-2 px-4 py-3 text-center">
				<Button
					aria-busy={busy}
					aria-disabled={busy}
					class={BUSY}
					data-paging={end}
					data-testid="raw-keep-searching-{end}"
					onclick={() => view.loadMore(end)}
					size="sm"
					variant="outline"
				>
					{m['systemLogs.raw.keepSearching']()}
				</Button>
				<p class="text-muted-foreground max-w-prose text-xs">{m['systemLogs.raw.keepSearchingHint']()}</p>
			</div>
		{:else if view.rows.length > 0}
			<p
				class="text-muted-foreground flex items-center gap-3 px-4 py-3 text-xs before:bg-border before:h-px before:flex-1 after:bg-border after:h-px after:flex-1"
				data-testid="raw-end-{end}"
			>
				<!-- The top edge exists only in a window around a moment, and pages toward newer entries. An approximate
				     window reads a bounded time range on each side, so its ends speak only for that range. -->
				{#if view.anchor?.approximate}
					{end === 'top' ? m['systemLogs.raw.endNewerWindow']() : m['systemLogs.raw.endOlderWindow']()}
				{:else}
					{end === 'top' ? m['systemLogs.raw.endNewer']() : m['systemLogs.raw.end']()}
				{/if}
			</p>
		{/if}
	{/if}
{/snippet}

{#if view.top !== null}
	<div bind:this={top} class="border-b" data-testid="raw-top">{@render edge('top', view.top)}</div>
{/if}
<div class="relative flex min-h-0 flex-1 flex-col">
	{#if heldCount > 0}
		<Button
			class="absolute inset-x-0 top-2 z-10 mx-auto w-fit shadow-sm"
			data-testid="raw-held"
			onclick={showHeld}
			size="sm"
			variant="secondary"
		>
			{m['systemLogs.follow.newEntries']({ count: heldCount })}
		</Button>
	{/if}
	<div
		bind:this={scroller}
		class="@container focus-visible:ring-ring/50 min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:ring-3 focus-visible:ring-inset"
		data-raw-scroller
		data-testid="raw-scroller"
		onscroll={(event) => view.setAtTop(event.currentTarget.scrollTop < 8)}
		tabindex="-1"
	>
		{#if view.loading === 'first'}
			<div aria-busy="true" data-testid="raw-loading" role="status">
				<span class="sr-only">{m['systemLogs.loading.entries']()}</span>
				{@render skeletonRows(6)}
			</div>
		{:else if view.rows.length === 0 && view.anchor !== null}
			<p class="text-muted-foreground px-6 py-10 text-center text-sm" data-testid="raw-anchor-empty">
				{m['systemLogs.anchor.empty']()}
			</p>
		{:else if view.rows.length === 0 && view.failure === null && view.bottom?.hasMore === false}
			<div class="flex flex-col items-center gap-2 px-6 py-10 text-center" data-testid="raw-empty">
				<p class="text-sm font-semibold">{m['systemLogs.raw.emptyTitle']()}</p>
				<p class="text-muted-foreground max-w-prose text-sm">{m['systemLogs.raw.emptyHint']()}</p>
				<Button class="mt-2" data-testid="raw-reset-filters" onclick={() => view.resetFilters()} size="sm" variant="outline">
					{m['systemLogs.raw.resetFilters']()}
				</Button>
			</div>
		{/if}
		<ul class="relative" data-testid="raw-list" style:height="{$virtualizer.getTotalSize()}px">
			{#each $virtualizer.getVirtualItems() as item (item.key)}
				{const row = $derived(rows[item.index] as DisplayRow)}
				<li
					class="absolute inset-x-0 top-0"
					data-index={item.index}
					style:transform="translateY({item.start}px)"
					{@attach measure}
					{@attach row.key === pendingFocus ? focusRow : undefined}
				>
					<RawLogRow
						anchored={row.key === view.anchor?.cursor}
						expanded={expanded.has(row.key)}
						focusable={row.key === tabKey}
						formatDate={(ts) => dateFormat.format(ts)}
						formatTime={(ts) => timeFormat.format(ts)}
						onKeydown={(event) => navigate(event, row.key)}
						onToggle={() => toggle(row.key)}
						readGap={(action, continuation) => readGap(action, { key: row.key, continuation })}
						loadingGap={view.loadingGap === row.key}
						{row}
						stale={view.stale}
					/>
				</li>
			{/each}
		</ul>
		{#if view.bottom !== null}
			{@render edge('bottom', view.bottom)}
		{/if}
	</div>
</div>
