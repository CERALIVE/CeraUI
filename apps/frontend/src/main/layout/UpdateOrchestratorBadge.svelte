<!--
  UpdateOrchestratorBadge.svelte — the app-wide "an update is working" badge
  (Todo 41).

  Separate from `UpdateBanner`, which reports the legacy `status.updating` apt
  run and is dismissable. This one reads the orchestrator's LIVE
  `update_orchestrator` push and follows it exactly: it appears while the phase
  is one an operator should see from anywhere (`isUpdateBusy`: a download or
  install running or waiting for idle, a staged image armed for the next
  restart, a slot mirror copying) and retracts itself the moment the phase
  leaves that set. There is no dismiss, because there is nothing to latch.

  It sits IN FLOW beneath the banner — no fixed position and no stacking layer —
  so it can push content down and never cover it. Tapping it opens the Updates
  dialog through the same request bus a notification action uses.
-->
<script lang="ts">
import { formatPercent } from '@ceraui/i18n/formatters';
import { getLocale, m, resolveMessageKey } from '@ceraui/i18n/svelte';
import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
import ClockIcon from '@lucide/svelte/icons/clock';
import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';

import { getUpdateOrchestratorState } from '$lib/rpc/subscriptions.svelte';
import { requestDialog } from '$lib/stores/dialog-request.svelte';
import { isUpdateWaiting } from '$lib/updates/update-dialog-view';
import {
	etaMinutes,
	isUpdateBusy,
	phaseLabelKey,
	progressPercent,
} from '$lib/updates/update-view';

const wire = $derived(getUpdateOrchestratorState());
const busy = $derived(isUpdateBusy(wire));
const percent = $derived(progressPercent(wire));
const eta = $derived(etaMinutes(wire?.progress?.etaSeconds));
const locale = $derived(getLocale());
</script>

{#if busy && wire}
	<div
		class="bg-status-info/10 border-status-info/30 flex justify-center border-b px-4 py-1.5"
		data-phase={wire.phase}
		data-testid="update-orchestrator-badge"
	>
		<button
			class="text-foreground hover:bg-status-info/15 focus-visible:ring-ring/50 inline-flex min-h-[var(--touch-target-min)] max-w-full items-center gap-2 rounded-md px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
			onclick={() => requestDialog('updates-dialog')}
			title={m['settings.updates.badge.open']()}
			type="button"
		>
			{#if isUpdateWaiting(wire.phase)}
				<ClockIcon aria-hidden="true" class="text-status-info size-4 shrink-0" />
			{:else}
				<RefreshCwIcon aria-hidden="true" class="text-status-info size-4 shrink-0 motion-safe:animate-spin" />
			{/if}
			<span class="truncate font-medium" data-testid="update-orchestrator-badge-phase">
				{resolveMessageKey(phaseLabelKey(wire.phase))}
			</span>
			{#if percent !== undefined}
				<span class="font-mono text-xs tabular-nums" data-testid="update-orchestrator-badge-percent">
					{formatPercent(locale)(percent)}
				</span>
			{/if}
			{#if eta !== undefined}
				<span class="text-muted-foreground hidden text-xs sm:inline">
					{m['settings.updates.eta']({ minutes: eta })}
				</span>
			{/if}
			<span class="sr-only">{m['settings.updates.badge.open']()}</span>
			<ChevronRightIcon aria-hidden="true" class="text-muted-foreground size-4 shrink-0 rtl:-scale-x-100" />
		</button>
	</div>
{/if}
