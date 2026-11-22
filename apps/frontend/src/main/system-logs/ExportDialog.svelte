<!--
  ExportDialog.svelte: the confirmation in front of "Export this view": what the
  file holds (the Raw logs filters, or the ten minutes around an exact anchor)
  and that it may contain sensitive data, before anything downloads.
  Download export asks the device for a ticket; Cancel, Escape and the close
  button discard a request still in flight.
-->
<script lang="ts">
import { getLocale, m } from '@ceraui/i18n/svelte';
import { LOG_LEVELS, type LogSource } from '@ceraui/rpc/schemas';
import { ShieldAlert, TriangleAlert } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import { formatBootTime } from '$lib/device-logs/boot-rows';
import { bootSelection } from '$lib/device-logs/boot-selection.svelte';
import { levelCovering, type RawLevel } from '$lib/device-logs/raw-filter';
import type { SharingFlow } from '$lib/device-logs/sharing-flow.svelte';

import KeepWords from './KeepWords.svelte';

let { sharing, returnFocus }: { sharing: SharingFlow; returnFocus?: () => HTMLElement | null } = $props();

const LEVELS: Record<RawLevel, () => string> = {
	errors: () => m['systemLogs.raw.levelErrors'](),
	warnings: () => m['systemLogs.raw.levelWarnings'](),
	info: () => m['systemLogs.raw.levelInfo'](),
	everything: () => m['systemLogs.raw.levelEverything'](),
};
const SOURCES: Record<LogSource, () => string> = {
	app: () => m['systemLogs.source.app'](),
	engine: () => m['systemLogs.source.engine'](),
	bonding: () => m['systemLogs.source.bonding'](),
	network: () => m['systemLogs.source.network'](),
	cellular: () => m['systemLogs.source.cellular'](),
	updates: () => m['systemLogs.source.updates'](),
	device: () => m['systemLogs.source.device'](),
	kernel: () => m['systemLogs.source.kernel'](),
};

// What the ticket will save, in the same words as the Raw logs controls and the boot picker.
const scope = $derived.by(() => {
	const query = sharing.exportQuery;
	const locale = getLocale();
	const chosen = bootSelection.boot;
	// Absent fields take the wire defaults: this boot, every level.
	const boot = query.boot ?? 'current';
	const rows: [string, string][] = [
		[
			m['systemLogs.boots.heading'](),
			boot === 'all'
				? m['systemLogs.boots.all']()
				: boot === 'current'
					? m['systemLogs.boots.current']()
					: chosen !== null && chosen.bootId === boot
						? m['systemLogs.boots.started']({ time: formatBootTime(chosen.firstTs, locale) })
						: m['systemLogs.raw.timeBoot'](),
		],
		[m['systemLogs.raw.levelLabel'](), LEVELS[levelCovering(query.levels ?? LOG_LEVELS)]()],
		[
			m['systemLogs.raw.sourceLabel'](),
			query.sources?.length ? query.sources.map((source) => SOURCES[source]()).join(', ') : m['systemLogs.raw.sourceAll'](),
		],
	];
	if (query.text) rows.push([m['systemLogs.raw.searchLabel'](), query.text]);
	if (sharing.viewSpan === 'filters' && query.since !== undefined)
		rows.push([m['systemLogs.raw.timeLabel'](), m['systemLogs.sharing.exportFrom']({ time: formatBootTime(query.since, locale) })]);
	return rows;
});

const PROBLEM = {
	busy: () => m['systemLogs.sharing.busy'](),
	failed: () => m['systemLogs.sharing.failed'](),
};
</script>

<AppDialog
	bind:open={() => sharing.exportStep !== 'closed', (open) => {
		if (!open) sharing.closeExport();
	}}
	closeOnPrimary={false}
	onPrimary={() => void sharing.confirmExport()}
	primaryLabel={m['systemLogs.sharing.exportDownload']()}
	primaryLoading={sharing.exportStep === 'creating'}
	{returnFocus}
	title={m['systemLogs.sharing.export']()}
>
	<div class="flex flex-col gap-4 [word-break:auto-phrase] [&:lang(ko)]:break-keep [&:lang(zh)]:break-keep wrap-break-word text-pretty [&:lang(zh)]:text-balance">
		<p class="text-sm"><KeepWords text={sharing.viewSpan === 'moment' ? m['systemLogs.sharing.exportHintMoment']() : m['systemLogs.sharing.exportHint']()} /></p>
		<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm" data-testid="sharing-export-scope">
			{#each scope as [term, value] (term)}
				<dt class="text-muted-foreground">{term}</dt>
				<dd class="wrap-anywhere">{value}</dd>
			{/each}
		</dl>
		<div class="flex items-start gap-3 rounded-lg border p-3">
			<ShieldAlert aria-hidden="true" class="text-muted-foreground mt-0.5 size-4 shrink-0" />
			<p class="text-sm" data-testid="sharing-export-sensitive"><KeepWords text={m['systemLogs.sharing.exportSensitive']()} /></p>
		</div>
		{#if sharing.exportProblem}
			<div
				class="border-status-warning/30 bg-status-warning/10 flex items-start gap-3 rounded-lg border p-3"
				data-testid="sharing-export-problem"
				role="alert"
			>
				<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
				<p class="text-sm"><KeepWords text={PROBLEM[sharing.exportProblem]()} /></p>
			</div>
		{/if}
		<p class="text-muted-foreground text-sm empty:hidden" data-testid="sharing-export-status" role="status">{sharing.exportStep === 'creating' ? m['advanced.downloading']() : ''}</p>
	</div>
</AppDialog>
