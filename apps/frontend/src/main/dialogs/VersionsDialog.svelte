<!--
  VersionsDialog.svelte — read-only device/component versions (Task 27).

  View-only: shows the installed component and firmware build strings. Rows are
  seeded from the live revisions push (subscriptions.svelte → getRevisions) and
  re-pulled on open, because cerastream is a separate systemd-owned process that
  can be restarted or upgraded after login — the boot-time snapshot would
  otherwise latch whatever the engine reported (or failed to report) back then.

  Every row renders the same shape via splitVersionValue: a version number as the
  primary value, with any build metadata demoted to a secondary line.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { Revisions } from '@ceraui/rpc/schemas';
import { Info } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import { rpc } from '$lib/rpc/client';
import { getRevisions } from '$lib/rpc/subscriptions.svelte';
import { splitVersionValue } from '$lib/system/version-display';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

let refreshed = $state<Revisions | undefined>(undefined);

const revisions = $derived(refreshed ?? getRevisions());

$effect(() => {
	if (!open) return;
	let cancelled = false;
	rpc.system
		.getRevisions()
		.then((next) => {
			if (!cancelled) refreshed = next;
		})
		.catch((error: unknown) => {
			// The pushed snapshot already on screen stays authoritative — a failed
			// refresh must not blank a dialog that is otherwise readable.
			console.error('Failed to refresh device versions:', error);
		});
	return () => {
		cancelled = true;
	};
});

// Stable display order: the streaming components first (they are what an
// operator is asked for when reporting a problem), then the runtime and the
// board. Optional rows are omitted rather than shown empty.
const rows = $derived(
	revisions
		? [
				{ label: 'CeraUI', value: revisions.ceralive },
				{ label: 'cerastream', value: revisions.cerastream },
				{ label: 'SRTLA', value: revisions.srtla },
				{ label: 'Bun Runtime', value: revisions.bun },
				{ label: 'Kernel', value: revisions.kernel },
				{ label: 'CERALIVE Image', value: revisions['CERALIVE image'] },
			].flatMap(({ label, value }) =>
				value ? [{ label, ...splitVersionValue(value) }] : [],
			)
		: [],
);
</script>

<AppDialog
	bind:open
	description={m["settings.index.versionsDesc"]()}
	icon={Info}
	title={m["settings.index.versions"]()}
>
	{#if rows.length > 0}
		<dl class="divide-border bg-card divide-y overflow-hidden rounded-lg border">
			{#each rows as row (row.label)}
				<div class="flex items-start justify-between gap-4 px-4 py-3">
					<dt class="text-muted-foreground pt-px text-sm font-medium">{row.label}</dt>
					<dd class="min-w-0 text-end" dir="ltr">
						<span class="text-foreground block truncate font-mono text-sm">{row.value}</span>
						{#if row.detail}
							<span class="text-muted-foreground block truncate font-mono text-xs"
								>{row.detail}</span
							>
						{/if}
					</dd>
				</div>
			{/each}
		</dl>
	{:else}
		<p class="text-muted-foreground py-4 text-sm">{m["common.loading"]()}</p>
	{/if}
</AppDialog>
