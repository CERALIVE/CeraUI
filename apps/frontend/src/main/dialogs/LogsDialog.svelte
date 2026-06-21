<!--
  LogsDialog.svelte — diagnostic log downloads (Task 26).

  Two actions: download the CeraLive application log and the full system log.
  Both request the log over the system RPC (getLog / getSyslog); the backend
  pushes a `log` message which the subscription layer turns into a file download.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { AlertTriangle, Download, FileText, Loader2, RefreshCw, ScrollText, Terminal } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { getDeviceLog, getSystemLog } from '$lib/helpers/SystemHelper';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

type LogKind = 'device' | 'system';

// In-flight + failure are surfaced INLINE (progress spinner on the row, calm
// amber retry band below) rather than via a bare toast — a transient toast is
// easy to miss and offers no recovery. The download is a single awaited request
// with no backend progress events, so "progress" is the in-flight indicator.
let downloading = $state<LogKind | null>(null);
let failed = $state<LogKind | null>(null);

async function download(kind: LogKind) {
	if (downloading !== null) return;
	downloading = kind;
	failed = null;
	try {
		await (kind === 'device' ? getDeviceLog() : getSystemLog());
	} catch (error) {
		console.error(`Failed to request ${kind} log:`, error);
		failed = kind;
	} finally {
		downloading = null;
	}
}

const logs = $derived([
	{
		id: 'device' as const,
		icon: FileText,
		title: $LL.advanced.ceraliveLog(),
		desc: $LL.advanced.ceraliveLogTooltip(),
	},
	{
		id: 'system' as const,
		icon: Terminal,
		title: $LL.advanced.systemLog(),
		desc: $LL.advanced.systemLogTooltip(),
	},
]);
</script>

<AppDialog
	bind:open
	description={$LL.settings.index.logsDesc()}
	hideFooter
	icon={ScrollText}
	title={$LL.settings.index.logs()}
>
	<div class="space-y-3">
		{#each logs as log (log.id)}
			{@const Icon = log.icon}
			{@const isDownloading = downloading === log.id}
			<div class="flex items-center gap-3 rounded-lg border p-3" data-testid={`log-row-${log.id}`}>
				<span class="bg-secondary text-foreground grid size-10 shrink-0 place-items-center rounded-lg">
					<Icon class="size-5" />
				</span>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-semibold">{log.title}</p>
					<p class="text-muted-foreground truncate text-xs">{log.desc}</p>
				</div>
				<Button
					class="shrink-0 gap-1.5"
					data-testid={`log-download-${log.id}`}
					disabled={downloading !== null}
					onclick={() => download(log.id)}
					size="sm"
					variant="outline"
				>
					{#if isDownloading}
						<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
						{$LL.advanced.downloading()}
					{:else}
						<Download class="size-4" />
						{$LL.advanced.download()}
					{/if}
				</Button>
			</div>
		{/each}

		{#if failed}
			<!-- Calm amber recovery band — the failed download stays actionable. -->
			<div
				class="border-status-warning/30 bg-status-warning/10 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center"
				data-testid="log-download-error"
				role="alert"
			>
				<AlertTriangle aria-hidden="true" class="text-status-warning size-4 shrink-0" />
				<p class="text-status-warning min-w-0 flex-1 text-xs">{$LL.advanced.downloadFailed()}</p>
				<Button
					class="shrink-0 gap-1.5"
					data-testid="log-download-retry"
					disabled={downloading !== null}
					onclick={() => failed && download(failed)}
					size="sm"
					variant="outline"
				>
					<RefreshCw class="size-4" />
					{$LL.advanced.retryDownload()}
				</Button>
			</div>
		{/if}
	</div>
</AppDialog>
