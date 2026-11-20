<!--
  EventRow.svelte: one Events row: the severity glyph (shape, tone and name;
  an unknown code shows its family icon), the title, the absolute and relative
  time, one detail sentence with its data params in <bdi>, how many similar
  events were folded in, a quiet View raw logs action and what that action
  found, and a collapsed Diagnostics disclosure for the raw tokens the sentences
  never show: a quiet toggle beside View raw logs whose body stays `hidden`
  until opened, never a card nested in the row. Below 768 px the time moves
  under the title. A long unbroken value wraps inside the row, whole and still
  isolated, never scrolling the list sideways. Chinese titles and details
  balance their lines so a sentence ending never stands alone. The row's
  actions are tab stops only while the row holds the list's one stop.
-->
<script lang="ts">
import { getLocale, m } from '@ceraui/i18n/svelte';
import type { DeviceEvent } from '@ceraui/rpc/schemas';
import { ChevronDown } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import type { RawLinkState } from '$lib/device-logs/events-view.svelte';
import { eventCopy, eventTime } from '$lib/device-logs/timeline-copy';

import ParamText from './ParamText.svelte';

interface Props {
	event: DeviceEvent;
	names: ReadonlyMap<string, string>;
	stale: boolean;
	rawLink: RawLinkState | null;
	onviewraw: () => void;
	/** This row holds the list's one tab stop. */
	stop: boolean;
	/** The list moves focus between rows with the arrow keys, Home and End. */
	onkeydown: (event: KeyboardEvent) => void;
	onfocusin: () => void;
}

let { event, names, stale, rawLink, onviewraw, stop, onkeydown, onfocusin }: Props = $props();

const RAW_NOTES = {
	removed: () => m['systemLogs.events.rawRemoved'](),
	busy: () => m['systemLogs.error.busy'](),
	failed: () => m['systemLogs.error.readFailed'](),
};

const uid = $props.id();
let diagnosticsOpen = $state(false);
const copy = $derived(eventCopy(event, names));
const time = $derived(eventTime(event.at, getLocale()));
</script>

<li
	class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-4 py-3"
	data-code={event.code}
	data-testid="event-row"
	{onfocusin}
>
	<span aria-label={copy.glyph.label} class="flex h-5 items-center" role="img">
		<copy.glyph.icon class="size-4 {copy.glyph.tone}" />
	</span>
	<div class="flex min-w-0 flex-col gap-1 wrap-anywhere">
		<div class="flex flex-col gap-x-3 gap-y-0.5 md:flex-row md:items-baseline md:justify-between">
			<p
				class={['text-sm font-semibold text-pretty [&:lang(zh)]:text-balance', stale ? 'text-muted-foreground' : 'text-foreground']}
				data-testid="event-title"
			>
				{copy.title}
			</p>
			<time class="text-muted-foreground flex shrink-0 gap-2 text-xs tabular-nums" datetime={time.iso}
				><span>{time.absolute}</span><span>{time.relative}</span></time
			>
		</div>
		{#if copy.detail !== null}
			<p class="text-muted-foreground text-sm text-pretty [&:lang(zh)]:text-balance" data-testid="event-detail">
				{#each copy.detail as part, i (i)}{#if part.param}<bdi>{part.text}</bdi>{:else}{part.text}{/if}{/each}
			</p>
		{/if}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
			{#if event.suppressed}
				<span class="text-muted-foreground text-xs" data-testid="event-folded"
					><ParamText
						format={(count) => m['systemLogs.events.folded']({ count })}
						value={new Intl.NumberFormat(getLocale()).format(event.suppressed)}
					/></span
				>
			{/if}
			<!-- aria-disabled, not disabled: a pending button keeps focus, so the list's keys still reach it. -->
			<Button
				aria-busy={rawLink === 'pending' ? 'true' : undefined}
				aria-disabled={rawLink === 'pending' ? 'true' : undefined}
				class="-ms-2.5 aria-disabled:pointer-events-none aria-disabled:opacity-50"
				onclick={onviewraw}
				{onkeydown}
				size="sm"
				tabindex={stop ? 0 : -1}
				variant="ghost"
			>
				{m['systemLogs.events.viewRaw']()}
			</Button>
			{#if copy.diagnostics !== null}
				<Button
					aria-controls="{uid}-diagnostics"
					aria-expanded={diagnosticsOpen}
					class="text-muted-foreground gap-1"
					data-testid="event-diagnostics-toggle"
					onclick={() => (diagnosticsOpen = !diagnosticsOpen)}
					{onkeydown}
					size="sm"
					tabindex={stop ? 0 : -1}
					variant="ghost"
				>
					{m['systemLogs.events.diagnostics']()}
					<ChevronDown class={['size-3.5 transition-transform', diagnosticsOpen && 'rotate-180']} />
				</Button>
			{/if}
		</div>
		{#if rawLink !== null && rawLink !== 'pending'}
			<p
				class="text-sm"
				data-state={rawLink}
				data-testid="event-raw-note"
				role={rawLink === 'removed' ? undefined : 'alert'}
			>
				{RAW_NOTES[rawLink]()}
			</p>
		{/if}
		{#if copy.diagnostics !== null}
			<div
				class="bg-muted/50 rounded-md px-3 py-2 text-xs"
				data-testid="event-diagnostics-body"
				hidden={!diagnosticsOpen}
				id="{uid}-diagnostics"
			>
				<p>
					<ParamText
						format={(code) => m['systemLogs.events.diagnosticsCode']({ code })}
						value={copy.diagnostics.code}
					/>
				</p>
				{#if copy.diagnostics.values.length > 0}
					<dl class="mt-1 space-y-0.5 font-mono" dir="ltr">
						{#each copy.diagnostics.values as [name, value] (name)}
							<div><dt class="inline">{name}:</dt> <dd class="inline break-all">{value}</dd></div>
						{/each}
					</dl>
				{/if}
			</div>
		{/if}
	</div>
</li>
