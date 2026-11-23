<!--
  LegacyLogDownloads.svelte: the two shipped log downloads, moved from LogsDialog
  into the System Logs Downloads region, where they are the secondary Full log
  files group with outline buttons. Their state is a LogDownloads owned by
  SystemLogsView, so it outlives this component; long titles and descriptions
  wrap (Japanese at phrases, Korean at spaces, Chinese between words), and a
  narrow row puts its button on a line of its own.

  Both request the log over the system RPC (getLog / getSyslog); the backend
  pushes a `log` message which the subscription layer turns into a file download.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { AlertTriangle, Download, FileText, Loader2, RefreshCw, Terminal } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { legacyLocked } from '$lib/device-logs/download-gate.svelte';
import { LINE_BREAKS } from '$lib/device-logs/storage-readout';

import KeepWords from './KeepWords.svelte';
import type { LogDownloads } from './log-downloads.svelte';

let { downloads }: { downloads: LogDownloads } = $props();

const logs = $derived([
	{
		id: 'device' as const,
		icon: FileText,
		title: m["advanced.ceraliveLog"](),
		desc: m["advanced.ceraliveLogTooltip"](),
	},
	{
		id: 'system' as const,
		icon: Terminal,
		title: m["advanced.systemLog"](),
		desc: m["advanced.systemLogTooltip"](),
	},
]);
</script>

<div class="space-y-3 {LINE_BREAKS}">
	{#each logs as log (log.id)}
		{const Icon = $derived(log.icon)}
		{const isDownloading = $derived(downloads.downloading === log.id)}
		<div class="flex flex-wrap items-center gap-3 rounded-lg border p-3" data-testid={`log-row-${log.id}`}>
			<span class="bg-secondary text-foreground grid size-10 shrink-0 place-items-center rounded-lg">
				<Icon class="size-5" />
			</span>
			<div class="min-w-0 grow basis-40">
				<p class="text-sm font-semibold">{log.title}</p>
				<p class="text-muted-foreground text-xs"><KeepWords text={log.desc} /></p>
			</div>
			<Button
				aria-describedby={legacyLocked(log.id) ? 'log-download-locked' : undefined}
				class="ms-auto shrink-0 gap-1.5"
				data-testid={`log-download-${log.id}`}
				data-variant="outline"
				disabled={downloads.downloading !== null || legacyLocked(log.id)}
				onclick={() => downloads.download(log.id)}
				size="sm"
				variant="outline"
			>
				{#if isDownloading}
					<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
					{m["advanced.downloading"]()}
				{:else}
					<Download class="size-4" />
					{m["advanced.download"]()}
				{/if}
			</Button>
		</div>
	{/each}

	<!-- A device that echoes no request id may still answer a timed-out request on this socket: only that
	     answer or a new socket frees the downloads, so say how to get them back. -->
	{#if legacyLocked('device') || legacyLocked('system')}
		<p class="text-muted-foreground text-xs" data-testid="log-download-locked" id="log-download-locked" role="status">
			<KeepWords text={m["advanced.downloadLocked"]()} />
		</p>
	{/if}

	{#if downloads.failed}
		<!-- Calm amber recovery band: the failed download stays actionable. -->
		<div
			class="border-status-warning/30 bg-status-warning/10 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center"
			data-testid="log-download-error"
			role="alert"
		>
			<AlertTriangle aria-hidden="true" class="text-status-warning size-4 shrink-0" />
			<p class="text-status-warning min-w-0 flex-1 text-xs"><KeepWords text={m["advanced.downloadFailed"]()} /></p>
			<Button
				class="shrink-0 gap-1.5"
				aria-describedby={downloads.failed && legacyLocked(downloads.failed) ? 'log-download-locked' : undefined}
				data-testid="log-download-retry"
				disabled={downloads.downloading !== null || (downloads.failed !== null && legacyLocked(downloads.failed))}
				onclick={() => downloads.failed && downloads.download(downloads.failed)}
				size="sm"
				variant="outline"
			>
				<RefreshCw class="size-4" />
				{m["advanced.retryDownload"]()}
			</Button>
		</div>
	{/if}
</div>
