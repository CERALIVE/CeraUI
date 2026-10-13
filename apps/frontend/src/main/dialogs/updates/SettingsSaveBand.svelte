<!--
  SettingsSaveBand.svelte — what became of the last update-settings save
  (round-3 review C, C3-3).

  Two different facts, never merged: the change was NOT SENT (the client never
  put the write on the wire, or could not read the device's current settings
  to build it), or nobody can CONFIRM it (the reply was lost or the device
  raised an error while handling it, so it may have been saved). The second
  band never says the change failed; the settings shown beside it are the last
  ones the device reported, and it clears once a read shows the change applied.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { CircleHelp } from '@lucide/svelte';

import type { SaveOutcome } from '$lib/updates/update-surface.svelte';

interface Props {
	outcome: SaveOutcome | undefined;
}

let { outcome }: Props = $props();
</script>

{#if outcome?.kind === 'not-sent'}
	<p
		class="border-status-warning/40 bg-status-warning/10 rounded-lg border px-3 py-2.5 text-sm break-words"
		data-testid="update-settings-save-failed"
		role="status"
	>
		{m['settings.updates.save.notSent']()}
	</p>
{:else if outcome?.kind === 'unconfirmed'}
	<div
		class="border-border bg-muted/40 flex items-start gap-2.5 rounded-lg border p-3"
		data-testid="update-settings-unconfirmed"
		role="status"
	>
		<CircleHelp aria-hidden="true" class="text-muted-foreground mt-0.5 size-4 shrink-0" />
		<div class="min-w-0 space-y-0.5">
			<p class="text-sm font-medium break-words">{m['settings.updates.save.unconfirmedTitle']()}</p>
			<p class="text-muted-foreground text-sm break-words">{m['settings.updates.save.unconfirmedBody']()}</p>
		</div>
	</div>
{/if}
