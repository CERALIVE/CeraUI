<!--
  UpdateRefusalBand.svelte — "an update owns the device right now" on the stream
  start surface (Todo 41).

  Stream admission refuses a start while the update orchestrator is committing
  packages or restarting services (D8, `update_in_progress`), because neither
  can be interrupted safely. This band says so BEFORE the operator presses Start,
  with the phase and whatever progress and time estimate the device published,
  and it goes away on its own the moment the phase moves on — the live push is
  authoritative (`goLiveUpdateRefusal`). A backend that publishes no push still
  gets the band from the typed refusal its last start returned.

  Presentational: LiveView derives the refusal and passes it in. Amber, never
  destructive — nothing is broken, the device is busy with work that finishes
  by itself.
-->
<script lang="ts">
import { formatPercent } from '@ceraui/i18n/formatters';
import { getLocale, m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { ArrowUpToLine } from '@lucide/svelte';

import { Progress } from '$lib/components/ui/progress';
import type { GoLiveUpdateRefusal } from '$lib/updates/update-bands';
import { phaseLabelKey } from '$lib/updates/update-view';

interface Props {
	refusal: GoLiveUpdateRefusal;
}

let { refusal }: Props = $props();

const locale = $derived(getLocale());
</script>

<div
	aria-live="polite"
	class="border-status-warning/40 bg-status-warning/10 space-y-3 rounded-lg border px-4 py-3"
	data-phase={refusal.phase}
	data-source={refusal.source}
	data-testid="update-refusal-band"
	role="status"
>
	<div class="flex items-start gap-2.5">
		<ArrowUpToLine aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
		<div class="min-w-0 space-y-0.5">
			<p class="text-sm font-medium">{m['live.updateInProgress.title']()}</p>
			<p class="text-muted-foreground text-sm">{m['live.updateInProgress.body']()}</p>
		</div>
	</div>
	{#if refusal.phase || refusal.percent !== undefined}
		<div class="space-y-1.5">
			<p class="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
				{#if refusal.phase}
					<span class="font-medium" data-testid="update-refusal-phase">
						{resolveMessageKey(phaseLabelKey(refusal.phase))}
					</span>
				{/if}
				<span class="text-muted-foreground flex gap-3 tabular-nums">
					{#if refusal.percent !== undefined}
						<span data-testid="update-refusal-percent">{formatPercent(locale)(refusal.percent)}</span>
					{/if}
					{#if refusal.etaMinutes !== undefined}
						<span data-testid="update-refusal-eta">
							{m['settings.updates.eta']({ minutes: refusal.etaMinutes })}
						</span>
					{/if}
				</span>
			</p>
			{#if refusal.percent !== undefined}
				<Progress value={refusal.percent} />
			{/if}
		</div>
	{/if}
</div>
