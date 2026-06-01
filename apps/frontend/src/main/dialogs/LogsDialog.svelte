<!--
  LogsDialog.svelte — diagnostic log downloads (Task 26).

  Two actions: download the CeraLive application log and the full system log.
  Both request the log over the system RPC (getLog / getSyslog); the backend
  pushes a `log` message which the subscription layer turns into a file download.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Download, FileText, ScrollText, Terminal } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { getDeviceLog, getSystemLog } from '$lib/helpers/SystemHelper';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

let busy = $state(false);

async function download(kind: 'device' | 'system') {
	if (busy) return;
	busy = true;
	try {
		await (kind === 'device' ? getDeviceLog() : getSystemLog());
	} catch (error) {
		console.error(`Failed to request ${kind} log:`, error);
		toast.error($LL.advanced.copyFailed());
	} finally {
		busy = false;
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
			<div class="flex items-center gap-3 rounded-lg border p-3">
				<span class="bg-secondary text-foreground grid size-10 shrink-0 place-items-center rounded-lg">
					<Icon class="size-5" />
				</span>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-semibold">{log.title}</p>
					<p class="text-muted-foreground truncate text-xs">{log.desc}</p>
				</div>
				<Button
					class="shrink-0 gap-1.5"
					disabled={busy}
					onclick={() => download(log.id)}
					size="sm"
					variant="outline"
				>
					<Download class="size-4" />
					{$LL.advanced.download()}
				</Button>
			</div>
		{/each}
	</div>
</AppDialog>
