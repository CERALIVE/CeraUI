<!--
  ExportDialog.svelte: the confirmation in front of "Export this view": what the
  file holds (the Raw logs filters, or the ten minutes around an exact anchor)
  and that it may contain sensitive data, before anything downloads.
  Download export asks the device for a ticket; Cancel, Escape and the close
  button discard a request still in flight.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { ShieldAlert, TriangleAlert } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import type { SharingFlow } from '$lib/device-logs/sharing-flow.svelte';

import KeepWords from './KeepWords.svelte';

let { sharing, returnFocus }: { sharing: SharingFlow; returnFocus?: () => HTMLElement | null } = $props();

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
