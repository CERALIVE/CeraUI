<!--
  RawLogsTab.svelte: the Raw logs panel of System Logs: a fixed filter bar,
  state notices, and the list that owns the scroll. Each mount builds its own
  view and runs a fresh first query (or opens on a `logs.around` result), and
  unmounting stops any follow, so a hidden tab never reads logs. A message whose
  moment is not known opens on the newest entries with one line saying so, until
  Follow starts or the filter first leaves the default. One polite
  status region, mounted before anything can follow, announces follow states;
  failures are inline alert bands with their recovery.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { LogQueryInput } from '@ceraui/rpc/schemas';
import { TriangleAlert, WifiOff } from '@lucide/svelte';
import { onDestroy, untrack } from 'svelte';

import { Button } from '$lib/components/ui/button';
import { bootSelection } from '$lib/device-logs/boot-selection.svelte';
import { onHistoryChanged } from '$lib/device-logs/history-bus';
import { isDefaultFilter } from '$lib/device-logs/raw-filter';
import { type AroundPage, type RawAnnouncement, RawView, resetRawView } from '$lib/device-logs/raw-view.svelte';
import type { ExportSpan } from '$lib/device-logs/sharing';
import { rpc } from '$lib/rpc/client';
import { getSessionReady, setLogFollowListener } from '$lib/rpc/subscriptions.svelte';

import KeepWords from './KeepWords.svelte';
import RawLogList from './RawLogList.svelte';
import RawLogsFilterBar from './RawLogsFilterBar.svelte';

let { around, momentUnknown = false, onquery }: { around?: AroundPage; momentUnknown?: boolean; onquery?: (query: LogQueryInput, span?: ExportSpan) => void } = $props();

const ANNOUNCE: Record<RawAnnouncement['kind'], (count: number) => string> = {
	following: () => m['systemLogs.announce.following'](),
	resumed: () => m['systemLogs.announce.resumed'](),
	paused: () => m['systemLogs.announce.paused'](),
	stopped: () => m['systemLogs.announce.stopped'](),
	restarted: () => m['systemLogs.follow.bootChangedIdle'](),
	gap: () => m['systemLogs.announce.gap'](),
	disconnected: () => m['systemLogs.announce.disconnected'](),
	newEntries: (count) => m['systemLogs.announce.newEntries']({ count }),
};

const ENDED = {
	follower_exit: () => m['systemLogs.follow.endedReader'](),
	boot_changed: () => m['systemLogs.follow.endedBoot'](),
	cleared: () => m['systemLogs.follow.endedCleared'](),
};

const view = new RawView({
	logs: rpc.logs,
	readCurrentBoot: async () => (await rpc.logs.boots()).find((boot) => boot.current)?.bootId,
	setFollowListener: setLogFollowListener,
	now: () => Date.now(),
	onQuery: (query, span) => onquery?.(query, span),
});
// A link opens on its moment; otherwise the picker's choice once it was used in this view (All boots
// included), else This boot.
const initial = untrack(() => ({ around, boot: bootSelection.boot, picked: bootSelection.picked }));
void (initial.around !== undefined || !initial.picked
	? view.start(initial.around)
	: view.chooseBoot(initial.boot?.bootId ?? null, initial.boot?.current ? initial.boot.bootId : undefined));
const stopBoot = bootSelection.onChoose((bootId) =>
	void view.chooseBoot(bootId, bootSelection.boot?.current ? bootSelection.boot.bootId : undefined),
);
const stopHistory = onHistoryChanged(() => void resetRawView(view));
onDestroy(() => {
	bootSelection.rawScope = null;
	stopBoot();
	stopHistory();
	view.dispose();
});

$effect(() => {
	const anchorBoot = view.anchor === null ? undefined : view.bottom?.query.boot;
	bootSelection.rawScope = {
		anchored: view.anchor !== null,
		time: view.filter.time,
		bootId: anchorBoot === undefined || anchorBoot === 'all' || anchorBoot === 'current' ? view.filter.bootId : anchorBoot,
	};
});

$effect(() => {
	const ready = getSessionReady();
	untrack(() => view.connectionChanged(ready ? 'connected' : 'disconnected'));
});

// The unknown moment speaks for the opening view only; restoring the default filter does not bring it back.
let momentDismissed = $state(false);
$effect(() => {
	if (view.follow !== 'idle' || !isDefaultFilter(view.filter)) momentDismissed = true;
});

const band = $derived.by(() => {
	const code = view.failure?.code;
	if (code === undefined) return undefined;
	if (code === 'CURSOR_UNAVAILABLE' || code === 'FILTER_CHANGED')
		return {
			title: m['systemLogs.error.expiredTitle'](),
			body: m['systemLogs.error.expiredBody'](),
			action: m['systemLogs.error.startFromNewest'](),
			run: () => view.reset(),
		};
	if (code === 'BOOT_UNAVAILABLE')
		return {
			title: m['systemLogs.error.bootRemoved'](),
			action: m['systemLogs.error.showCurrentBoot'](),
			run: () => view.showCurrentBoot(),
		};
	return {
		title: code === 'BUSY' ? m['systemLogs.error.busy']() : m['systemLogs.error.readFailed'](),
		action: m['systemLogs.action.retry'](),
		run: () => view.retry(),
	};
});
</script>

{#snippet controls()}
	<RawLogsFilterBar {view} />
	{#if view.stale}
		<div class="text-muted-foreground flex items-start gap-2 border-b px-4 py-2 text-sm" data-testid="raw-disconnected">
			<WifiOff class="mt-0.5 size-4 shrink-0" />
			<p>{m['systemLogs.follow.disconnectedBody']()}</p>
		</div>
	{/if}
	{#if view.ended !== null && (view.follow === 'stopped' || view.follow === 'idle')}
		<!-- An idle view only learns that the device restarted: nothing was following, so nothing stopped. -->
		<p class="text-muted-foreground border-b px-4 py-2 text-xs" data-testid="raw-follow-ended">{view.follow === 'idle' ? m['systemLogs.follow.bootChangedIdle']() : ENDED[view.ended]()}</p>
	{/if}
	{#if momentUnknown && !momentDismissed}
		<p class="text-muted-foreground border-b px-4 py-2 text-xs [&:lang(zh)]:break-keep" data-testid="raw-moment-unknown">
			<KeepWords text={m['systemLogs.anchor.unknown']()} />
		</p>
	{/if}
	{#if view.anchor !== null}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2" data-testid="raw-anchor">
			{#if view.anchor.approximate}
				<!-- A basis, so a long Back to latest entries label wraps below the note instead of squeezing the note into a narrow column. -->
				<p class="text-muted-foreground min-w-0 flex-1 basis-48 text-xs [&:lang(zh)]:break-keep" data-testid="raw-anchor-approximate">
					<KeepWords text={m['systemLogs.anchor.approximate']()} />
				</p>
			{/if}
			<Button class="ms-auto" data-testid="raw-anchor-leave" onclick={() => view.reset()} size="sm" variant="ghost">
				{m['systemLogs.anchor.leave']()}
			</Button>
		</div>
	{/if}
	{#if band !== undefined}
		<div
			class="border-status-warning/30 bg-status-warning/10 m-3 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center"
			data-code={view.failure?.code}
			data-testid="raw-failure"
			role="alert"
		>
			<TriangleAlert class="text-status-warning size-4 shrink-0" />
			<div class="min-w-0 flex-1 space-y-1">
				<p class="text-sm font-semibold">{band.title}</p>
				{#if band.body !== undefined}
					<p class="text-sm">{band.body}</p>
				{/if}
			</div>
			<Button data-testid="raw-failure-action" onclick={band.run} size="sm" variant="outline">
				{band.action}
			</Button>
		</div>
	{/if}
	{#if view.gapLimitReached}
		<p class="text-muted-foreground border-b px-4 py-2 text-xs">{m['systemLogs.marker.recoveryLimit']()}</p>
	{/if}
{/snippet}

<!-- CJK chrome copy breaks by phrase in Japanese, at spaces in Korean, and never leaves one character alone. -->
<div class="flex h-full min-h-0 flex-col text-pretty [word-break:auto-phrase] [&:lang(ko)]:break-keep" data-testid="raw-logs">
	<!-- On short phones, keep one full target visible in the controls scroller. -->
	<div class="contents max-sm:[@media(max-height:600px)]:block max-sm:[@media(max-height:600px)]:min-h-(--touch-target-min) max-sm:[@media(max-height:600px)]:overflow-y-auto max-sm:[@media(max-height:600px)]:overscroll-y-contain">
		{@render controls()}
	</div>
	<RawLogList {view} />
	<div aria-live="polite" class="sr-only" data-testid="raw-status" role="status">
		{#key view.announcement?.serial}{view.announcement === null
				? ''
				: ANNOUNCE[view.announcement.kind](view.announcement.count)}{/key}
	</div>
</div>
