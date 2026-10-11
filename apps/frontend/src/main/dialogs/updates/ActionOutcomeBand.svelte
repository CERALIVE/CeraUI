<!--
  ActionOutcomeBand.svelte — what became of the last update action (C-M1).

  Two different facts, never merged into one band: the DEVICE declined
  (`refusal`, "Not started" plus its reason), or its reply never arrived
  (`unconfirmed`), in which case nobody knows yet whether it acted. The second
  band carries no spinner and no countdown; it is retired by the device's own
  report (a pushed phase or a fresh details read, `update-surface.svelte.ts`),
  by the next attempt, or by closing the dialog.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { AlertTriangle, CircleHelp } from '@lucide/svelte';

import type { ActionRefusal, UpdateActionKind } from '$lib/updates/update-surface.svelte';
import { actionRefusalKey } from '$lib/updates/update-view';

interface Props {
	refusal: ActionRefusal | undefined;
	unconfirmed: UpdateActionKind | undefined;
}

let { refusal, unconfirmed }: Props = $props();
</script>

{#if refusal}
	<div
		class="border-status-warning/60 bg-status-warning/10 flex items-start gap-2 rounded-lg border p-3"
		data-action={refusal.action}
		data-testid="update-action-refused"
		role="status"
	>
		<AlertTriangle aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
		<div class="min-w-0 space-y-0.5">
			<p class="text-sm font-medium">{m['settings.updates.refusal.title']()}</p>
			<p class="text-muted-foreground text-sm">{resolveMessageKey(actionRefusalKey(refusal.reason))}</p>
		</div>
	</div>
{:else if unconfirmed}
	<div
		class="border-border bg-muted/40 flex items-start gap-2 rounded-lg border p-3"
		data-action={unconfirmed}
		data-testid="update-action-unconfirmed"
		role="status"
	>
		<CircleHelp aria-hidden="true" class="text-muted-foreground mt-0.5 size-4 shrink-0" />
		<div class="min-w-0 space-y-0.5">
			<p class="text-sm font-medium">{m['settings.updates.unconfirmed.title']()}</p>
			<p class="text-muted-foreground text-sm">{m['settings.updates.unconfirmed.body']()}</p>
		</div>
	</div>
{/if}
