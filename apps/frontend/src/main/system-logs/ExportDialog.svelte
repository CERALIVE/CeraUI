<!--
  ExportDialog.svelte: the confirmation in front of "Export this view": the scope
  fixed when it opened (SharingFlow.exportScope), which is exactly what the
  ticket request sends, and that it may contain sensitive data, before anything downloads.
  Download export asks the device for a ticket; Cancel, Escape and the close
  button discard a request still in flight.
-->
<script lang="ts">
import { getLocale, m } from '@ceraui/i18n/svelte';
import { LOG_LEVELS, type LogSource } from '@ceraui/rpc/schemas';
import { ShieldAlert, TriangleAlert } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import { formatBootTime } from '$lib/device-logs/boot-rows';
import { markParam, paramPieces } from '$lib/device-logs/param-parts';
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

// The scope fixed when this confirmation opened, which the ticket request sends,
// in the words of the Raw logs controls and the boot picker; data params isolated.
const rows = $derived.by((): [string, string][] => {
	const scope = sharing.exportScope;
	if (scope === null) return [];
	const { query } = scope;
	const locale = getLocale();
	const time = (ts: number) => markParam(formatBootTime(ts, locale));
	// Absent fields take the wire defaults: this boot, every level.
	const boot = query.boot ?? 'current';
	const rows: [string, string][] = [
		[
			m['systemLogs.boots.heading'](),
			boot === 'all'
				? m['systemLogs.boots.all']()
				: boot === 'current'
					? m['systemLogs.boots.current']()
					: scope.bootStart === null
						? m['systemLogs.raw.timeBoot']()
						: m['systemLogs.boots.started']({ time: time(scope.bootStart) }),
		],
		[m['systemLogs.raw.levelLabel'](), LEVELS[levelCovering(query.levels ?? LOG_LEVELS)]()],
		[
			m['systemLogs.raw.sourceLabel'](),
			query.sources?.length ? query.sources.map((source) => SOURCES[source]()).join(', ') : m['systemLogs.raw.sourceAll'](),
		],
	];
	if (query.text) rows.push([m['systemLogs.raw.searchLabel'](), markParam(query.text)]);
	if (query.since !== undefined)
		rows.push([
			m['systemLogs.raw.timeLabel'](),
			query.until === undefined
				? m['systemLogs.sharing.exportFrom']({ time: time(query.since) })
				: m['systemLogs.sharing.exportBetween']({ from: time(query.since), to: time(query.until) }),
		]);
	return rows;
});

const PROBLEM = {
	busy: () => m['systemLogs.sharing.busy'](),
	failed: () => m['systemLogs.sharing.failed'](),
	credentialTooShort: () => m['systemLogs.sharing.exportCredentialTooShort'](),
	credentialsLoading: () => m['systemLogs.sharing.exportCredentialsLoading'](),
	credentialsUnreadable: () => m['systemLogs.sharing.exportCredentialsUnreadable'](),
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
	touchRegion
>
	<div class="flex flex-col gap-4 [word-break:auto-phrase] [&:lang(ko)]:break-keep [&:lang(zh)]:break-keep wrap-break-word text-pretty [&:lang(zh)]:text-balance">
		<p class="text-sm"><KeepWords text={sharing.exportScope?.span === 'moment' ? m['systemLogs.sharing.exportHintMoment']() : m['systemLogs.sharing.exportHint']()} /></p>
		<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm" data-testid="sharing-export-scope">
			{#each rows as [term, value] (term)}
				<dt class="text-muted-foreground">{term}</dt>
				<dd class="wrap-anywhere">{#each paramPieces(value) as piece, i (i)}{#if piece.param}<bdi>{piece.text}</bdi>{:else}{piece.text}{/if}{/each}</dd>
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
