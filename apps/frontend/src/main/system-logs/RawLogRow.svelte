<!--
  RawLogRow.svelte — one row of the Raw logs list. An entry is a button that
  expands to the full message, the full unit and Copy; raw text stays dir="ltr"
  inside RTL chrome and wraps instead of scrolling. Gaps, journald's own
  suppression notice, day changes, a clock that moved back and the selected
  moment of an approximate window are separator rows between neutral rules,
  never log lines and never coloured bars.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { LogLevel } from '@ceraui/rpc/schemas';
import { CircleAlert, CircleDashed, Info, TriangleAlert } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import type { DisplayRow, MarkerKind } from '$lib/device-logs/raw-rows';
import { copyToClipboard } from '$lib/helpers/clipboard';
import { cn } from '$lib/utils';

import ParamText from './ParamText.svelte';

interface Props {
	row: DisplayRow;
	/** The socket dropped: nothing may look fresh. */
	stale: boolean;
	anchored: boolean;
	expanded: boolean;
	focusable: boolean;
	formatTime: (ts: number) => string;
	formatDate: (ts: number) => string;
	onToggle: () => void;
	/** The list moves focus between rows with the arrow keys. */
	onKeydown: (event: KeyboardEvent) => void;
}

let { row, stale, anchored, expanded, focusable, formatTime, formatDate, onToggle, onKeydown }: Props = $props();

const uid = $props.id();

const GLYPH: Record<LogLevel, { icon: typeof Info; tint: string; name: () => string }> = {
	error: { icon: CircleAlert, tint: 'text-status-error', name: () => m['systemLogs.level.error']() },
	warning: { icon: TriangleAlert, tint: 'text-status-warning', name: () => m['systemLogs.level.warning']() },
	info: { icon: Info, tint: 'text-muted-foreground', name: () => m['systemLogs.level.info']() },
	debug: { icon: CircleDashed, tint: 'text-muted-foreground', name: () => m['systemLogs.level.debug']() },
};

const MARKER: Record<MarkerKind, (count: number) => string> = {
	dropped: (count) => m['systemLogs.marker.dropped']({ count }),
	catchupExceeded: () => m['systemLogs.marker.catchupExceeded'](),
	cursorUnavailable: () => m['systemLogs.marker.cursorUnavailable'](),
};

const SEPARATOR =
	'text-muted-foreground flex items-center gap-3 px-4 py-1.5 text-center text-xs before:bg-border before:h-px before:flex-1 after:bg-border after:h-px after:flex-1';

let copied = $state<boolean>();

async function copy(text: string): Promise<void> {
	copied = await copyToClipboard(text);
}
</script>

{#if row.kind === 'date'}
	<div class={SEPARATOR} data-testid="raw-date">
		<time datetime={new Date(row.ts).toISOString()}>{formatDate(row.ts)}</time>
	</div>
{:else if row.kind === 'clock'}
	<div class={SEPARATOR} data-testid="raw-clock">{m['systemLogs.marker.clockChanged']()}</div>
{:else if row.kind === 'moment'}
	<div class={SEPARATOR} data-testid="raw-moment">
		<time class="tabular-nums" datetime={new Date(row.ts).toISOString()}
			><ParamText format={(time) => m['systemLogs.anchor.moment']({ time })} value={formatTime(row.ts)} /></time
		>
	</div>
{:else if row.kind === 'marker'}
	<div class={SEPARATOR} data-marker={row.marker} data-testid="raw-marker">{MARKER[row.marker](row.count)}</div>
{:else if row.entry.marker === 'suppressed'}
	<div class={SEPARATOR} data-marker="suppressed" data-testid="raw-marker">{m['systemLogs.marker.suppressed']()}</div>
{:else}
	{const entry = $derived(row.entry)}
	{const glyph = $derived(GLYPH[entry.level])}
	{const muted = $derived(stale || entry.level === 'debug')}
	<!-- The anchor's wash leaves muted text under 4.5:1 in dark, so its quiet text takes the foreground role. -->
	{const quiet = $derived(anchored ? 'text-foreground' : 'text-muted-foreground')}
	<div
		class={cn('border-b', anchored && 'bg-status-info/10')}
		data-anchor={anchored}
		data-cursor={entry.cursor}
		data-level={entry.level}
		data-stale={stale}
		data-testid="raw-row"
	>
		<button
			aria-describedby={anchored ? `${uid}-anchor` : undefined}
			aria-expanded={expanded}
			class="hover:bg-muted/50 focus-visible:ring-ring/50 grid min-h-(--touch-target-min) w-full grid-cols-[1rem_auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 px-4 py-1.5 text-start outline-none focus-visible:ring-3 focus-visible:ring-inset @min-[40rem]:grid-cols-[1rem_auto_14ch_minmax(0,1fr)]"
			onclick={onToggle}
			onkeydown={onKeydown}
			tabindex={focusable ? 0 : -1}
			type="button"
		>
			<glyph.icon aria-label={glyph.name()} class={cn('mt-0.5 size-4 shrink-0', glyph.tint)} role="img" />
			<time class={cn('font-mono text-xs leading-5 tabular-nums', quiet)} datetime={new Date(entry.ts).toISOString()}>
				{formatTime(entry.ts)}
			</time>
			<span class={cn('truncate text-xs leading-5', quiet)} data-testid="raw-row-unit" dir="ltr">{entry.unit}</span>
			{#if !expanded}
				<span
					class={cn(
						'col-span-full line-clamp-2 font-mono text-xs leading-5 [overflow-wrap:anywhere] @min-[40rem]:col-span-1',
						muted ? quiet : 'text-foreground',
					)}
					data-testid="raw-row-message"
					dir="ltr">{entry.message}</span
				>
			{/if}
		</button>
		{#if anchored}
			<span class="sr-only" id="{uid}-anchor">{m['systemLogs.anchor.match']()}</span>
		{/if}
		{#if expanded}
			<div class="space-y-2 px-4 pb-3 ps-10" data-testid="raw-row-detail">
				<p
					class={cn('font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]', muted && quiet)}
					data-testid="raw-row-full"
					dir="ltr">{entry.message}</p
				>
				<p class={cn('text-xs [overflow-wrap:anywhere]', quiet)} dir="ltr">{entry.unit}</p>
				{#if entry.truncated}
					<p class={cn('text-xs', quiet)} data-testid="raw-row-truncated">{m['systemLogs.raw.truncated']()}</p>
				{/if}
				<div class="flex flex-wrap items-center gap-2">
					<Button data-testid="raw-row-copy" onclick={() => copy(entry.message)} size="sm" variant="outline">
						{m['systemLogs.raw.copy']()}
					</Button>
					{#if copied !== undefined}
						<span class={cn('text-xs', quiet)} data-testid="raw-row-copy-status" role="status">
							{copied ? m['systemLogs.raw.copied']() : m['systemLogs.raw.copyFailed']()}
						</span>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}
