<!--
  VersionsDialog.svelte — read-only device/component versions (Task 27).

  View-only: shows the installed component and firmware build strings from the
  live revisions push (subscriptions.svelte → getRevisions). No interactive
  elements; the AppDialog renders a single close affordance via `hideFooter` =
  false default footer (info-only close button).
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Info } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import { getRevisions } from '$lib/rpc/subscriptions.svelte';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const revisions = $derived(getRevisions());

// Stable display order with human labels. The optional image row is only
// shown when present.
const rows = $derived(
	revisions
		? [
				{ label: 'CeraUI', value: revisions.ceralive },
				{ label: 'SRTLA', value: revisions.srtla },
				{ label: 'Bun Runtime', value: revisions.bun },
				...(revisions['CERALIVE image']
					? [{ label: 'CERALIVE Image', value: revisions['CERALIVE image'] }]
					: []),
			]
		: [],
);
</script>

<AppDialog
	bind:open
	description={$LL.settings.index.versionsDesc()}
	icon={Info}
	title={$LL.settings.index.versions()}
>
	{#if rows.length > 0}
		<dl class="divide-border bg-card divide-y overflow-hidden rounded-lg border">
			{#each rows as row (row.label)}
				<div class="flex items-center justify-between gap-4 px-4 py-3">
					<dt class="text-muted-foreground text-sm font-medium">{row.label}</dt>
					<dd class="text-foreground min-w-0 truncate text-end font-mono text-sm" dir="ltr">
						{row.value}
					</dd>
				</div>
			{/each}
		</dl>
	{:else}
		<p class="text-muted-foreground py-4 text-sm">{$LL.common.loading()}</p>
	{/if}
</AppDialog>
