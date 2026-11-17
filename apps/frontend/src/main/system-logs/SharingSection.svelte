<!--
  SharingSection.svelte — the second group of the System Logs Downloads region,
  after a neutral rule: Export this view and Support bundle, in the shipped rows'
  anatomy, with the line saying the browser saves the files. Each row opens a
  nested dialog that states what the file holds and that it may contain
  sensitive data before anything downloads. The flows' state is a SharingFlow
  owned by SystemLogsView, so it outlives this group remounting. Long labels wrap
  inside their buttons.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { FileOutput, LifeBuoy } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import type { SharingFlow } from '$lib/device-logs/sharing-flow.svelte';

import BundleDialog from './BundleDialog.svelte';
import ExportDialog from './ExportDialog.svelte';
import KeepWords from './KeepWords.svelte';

let { sharing }: { sharing: SharingFlow } = $props();

const rows = $derived([
	{
		id: 'export',
		icon: FileOutput,
		title: m['systemLogs.sharing.export'](),
		hint: m['systemLogs.sharing.exportHint'](),
		open: () => sharing.openExport(),
	},
	{
		id: 'bundle',
		icon: LifeBuoy,
		title: m['systemLogs.sharing.bundle'](),
		hint: m['systemLogs.sharing.bundleHint'](),
		open: () => void sharing.openBundle(),
	},
]);
</script>

<div class="flex flex-col gap-3 border-t pt-3 [word-break:auto-phrase] [&:lang(ko)]:break-keep [&:lang(zh)]:break-keep wrap-break-word text-pretty [&:lang(zh)]:text-balance" data-testid="sharing-group">
	{#each rows as row (row.id)}
		<div class="flex flex-wrap items-center gap-3 rounded-lg border p-3" data-testid="sharing-row-{row.id}">
			<span aria-hidden="true" class="bg-secondary text-foreground grid size-10 shrink-0 place-items-center rounded-lg">
				<row.icon class="size-5" />
			</span>
			<div class="min-w-0 grow basis-40">
				<p class="text-sm font-semibold">{row.title}</p>
				<p class="text-muted-foreground text-xs"><KeepWords text={row.hint} /></p>
			</div>
			<Button
				class="ms-auto h-auto max-w-full py-1 whitespace-normal"
				data-testid="sharing-open-{row.id}"
				onclick={row.open}
				size="sm"
				variant="outline"
			>
				{row.title}
			</Button>
		</div>
	{/each}
	<p class="text-muted-foreground text-xs"><KeepWords text={m['systemLogs.sharing.browserSaves']()} /></p>
</div>

<ExportDialog {sharing} />
<BundleDialog {sharing} />
