<!--
  RawLogsFilterBar.svelte — the Raw logs filter bar, fixed above the list. Level,
  Search and Follow stay visible; Source, Time and Order sit in a second row
  when the panel is at least 720 px wide and the viewport is taller than 600 px,
  and fold behind a Filters button otherwise (the 1024x600 kiosk, phones). The
  fold is a container query on this bar, so the 320 px side column counts.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { LOG_SOURCES, type LogSource } from '@ceraui/rpc/schemas';
import { Search, SlidersHorizontal, X } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import * as Select from '$lib/components/ui/select';
import { foldedFilterCount, type RawLevel, type RawOrder, type RawTime, timeShown } from '$lib/device-logs/raw-filter';
import type { RawView } from '$lib/device-logs/raw-view.svelte';
import { cn } from '$lib/utils';

import RawFollowControl from './RawFollowControl.svelte';
import SegmentedChoice from './SegmentedChoice.svelte';

let { view }: { view: RawView } = $props();

const uid = $props.id();

let open = $state(false);

const levels = $derived<{ value: RawLevel; label: string }[]>([
	{ value: 'errors', label: m['systemLogs.raw.levelErrors']() },
	{ value: 'warnings', label: m['systemLogs.raw.levelWarnings']() },
	{ value: 'info', label: m['systemLogs.raw.levelInfo']() },
	{ value: 'everything', label: m['systemLogs.raw.levelEverything']() },
]);
const orders = $derived<{ value: RawOrder; label: string }[]>([
	{ value: 'newest', label: m['systemLogs.raw.orderNewest']() },
	{ value: 'oldest', label: m['systemLogs.raw.orderOldest']() },
]);
// An anchor window's Level and Time state what it reads; Back to latest returns to the operator's choices.
const timeValue = $derived(timeShown(view.filter, view.anchor !== null));
const times = $derived<{ value: RawTime | 'boot'; label: string }[]>([
	{ value: 'current', label: m['systemLogs.raw.timeThisBoot']() },
	{ value: '15m', label: m['systemLogs.raw.timeLast15m']() },
	{ value: '1h', label: m['systemLogs.raw.timeLastHour']() },
	{ value: '24h', label: m['systemLogs.raw.timeLast24h']() },
	{ value: 'all', label: m['systemLogs.raw.timeAll']() },
	...(timeValue === 'boot' ? [{ value: 'boot' as const, label: m['systemLogs.raw.timeBoot']() }] : []),
]);
const folded = $derived(foldedFilterCount(view.filter, view.anchor !== null));
const sourceCount = $derived(view.filter.sources.length);

function chooseTime(value: string): void {
	if (value !== 'boot') void view.setTime(value as RawTime);
}
</script>

<div class="@container border-b" data-testid="raw-filters">
	<div class="flex flex-wrap items-center gap-2 p-3">
		<SegmentedChoice
			class="w-full @min-[30rem]:w-auto"
			label={m['systemLogs.raw.levelLabel']()}
			onSelect={(level) => view.setLevel(level)}
			options={levels}
			testid="raw-level"
			value={view.anchor?.level ?? view.filter.level}
		/>
		<div class="relative min-w-32 flex-1">
			<Search class="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2" />
			<Input
				aria-label={m['systemLogs.raw.searchLabel']()}
				class="min-h-(--touch-target-min) ps-8 pe-9 text-ellipsis"
				data-testid="raw-search"
				enterkeyhint="search"
				oninput={(event) => view.setDraft(event.currentTarget.value)}
				onkeydown={(event) => {
					if (event.key === 'Enter') void view.applyDraft();
				}}
				placeholder={m['systemLogs.raw.searchLabel']()}
				value={view.draft}
			/>
			{#if view.draft !== ''}
				<button
					aria-label={m['systemLogs.raw.searchClear']()}
					class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute end-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md outline-none focus-visible:ring-3"
					data-testid="raw-search-clear"
					data-touch-target="hit-area"
					onclick={() => view.clearSearch()}
					type="button"
				>
					<X class="size-4" />
				</button>
			{/if}
		</div>
		<Button
			aria-controls="{uid}-filters"
			aria-expanded={open}
			class="gap-1.5 @min-[45rem]:[@media(min-height:601px)]:hidden"
			data-testid="raw-filters-toggle"
			onclick={() => (open = !open)}
			size="sm"
			variant="outline"
		>
			<SlidersHorizontal class="size-4" />
			{folded === 0 ? m['systemLogs.raw.filters']() : m['systemLogs.raw.filtersActive']({ count: folded })}
		</Button>
		<RawFollowControl {view} />
		<div
			class={cn(
				'basis-full flex-wrap items-start gap-3 @min-[45rem]:[@media(min-height:601px)]:flex',
				open ? 'flex' : 'hidden',
			)}
			data-open={open}
			data-testid="raw-filters-panel"
			id="{uid}-filters"
		>
			<div class="flex min-w-40 flex-col gap-1">
				<span class="text-muted-foreground text-xs font-medium" id="{uid}-sources">{m['systemLogs.raw.sourceLabel']()}</span>
				<Select.Root
					onValueChange={(next) => view.setSources(next as LogSource[])}
					type="multiple"
					value={[...view.filter.sources]}
				>
					<!-- No source chosen reads All sources, a choice in the value colour rather than placeholder grey. -->
					<Select.Trigger aria-labelledby="{uid}-sources" class="w-full data-placeholder:text-foreground" data-testid="raw-sources">
						{sourceCount === 0 ? m['systemLogs.raw.sourceAll']() : m['systemLogs.raw.sourceCount']({ count: sourceCount })}
					</Select.Trigger>
					<Select.Content>
						{#each LOG_SOURCES as source (source)}
							<Select.Item
								class="min-h-(--touch-target-min)"
								data-testid="raw-source-option-{source}"
								label={m[`systemLogs.source.${source}`]()}
								value={source}
							/>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<div class="flex min-w-40 flex-col gap-1">
				<span class="text-muted-foreground text-xs font-medium" id="{uid}-time">{m['systemLogs.raw.timeLabel']()}</span>
				<Select.Root onValueChange={chooseTime} type="single" value={timeValue}>
					<Select.Trigger aria-labelledby="{uid}-time" class="w-full" data-testid="raw-time">
						{times.find((time) => time.value === timeValue)?.label}
					</Select.Trigger>
					<Select.Content>
						{#each times as time (time.value)}
							<Select.Item
								class="min-h-(--touch-target-min)"
								data-testid="raw-time-option-{time.value}"
								label={time.label}
								value={time.value}
							/>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<div class="flex flex-col gap-1">
				<span class="text-muted-foreground text-xs font-medium" aria-hidden="true">{m['systemLogs.raw.orderLabel']()}</span>
				<SegmentedChoice
					label={m['systemLogs.raw.orderLabel']()}
					onSelect={(order) => view.setOrder(order)}
					options={orders}
					testid="raw-order"
					value={view.filter.order}
				/>
			</div>
		</div>
	</div>
</div>
