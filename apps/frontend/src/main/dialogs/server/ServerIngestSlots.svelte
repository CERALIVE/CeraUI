<!--
  ServerIngestSlots.svelte — the platform-managed ingest-slot picker (T19).

  Presentational: ServerDialog owns the auto-selection (autoSelectIngestSlot) and
  the save handler; this section renders the platform-pushed slots as a one-tap
  radio group, highlights the active slot, and reports the operator's pick through
  `onSelectSlot`. It surfaces only when managed ingest accounts exist; the manual
  custom endpoint stays available via the destination radiogroup regardless.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Cloud } from '@lucide/svelte';

import type { ManagedIngestAccount } from '$lib/streaming/receiver-experience';
import { managedSlotLabel, obsInstanceAssociation } from '$lib/streaming/receiver-experience';
import { Label } from '$lib/components/ui/label';

interface Props {
	accounts: readonly ManagedIngestAccount[];
	/** endpointId of the active slot, or undefined while prompting for a pick. */
	activeEndpointId: string | undefined;
	/** True when no slot is auto-resolved and the operator must choose one. */
	prompting: boolean;
	isStreaming: boolean;
	onSelectSlot: (endpointId: string) => void;
}

let { accounts, activeEndpointId, prompting, isStreaming, onSelectSlot }: Props = $props();

const choiceBase =
	'flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-start ' +
	'transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const activeChoice = 'border-primary bg-primary/10 text-foreground';
const idleChoice = 'border-border text-muted-foreground hover:text-foreground';
</script>

<div class="space-y-2">
	<Label class="text-sm font-medium" id="ingest-slot-label">{$LL.settings.ingestSlot()}</Label>
	<p class="text-muted-foreground text-xs leading-snug">
		{prompting ? $LL.settings.ingestSlotPrompt() : $LL.settings.ingestSlotHint()}
	</p>
	<div
		aria-label={$LL.settings.ingestSlot()}
		class="grid gap-2"
		data-testid="ingest-slots"
		role="radiogroup"
	>
		{#each accounts as account (account.endpointId)}
			<button
				aria-checked={activeEndpointId === account.endpointId}
				class="{choiceBase} {activeEndpointId === account.endpointId ? activeChoice : idleChoice}"
				data-endpoint-id={account.endpointId}
				data-testid={`ingest-slot-${account.endpointId}`}
				disabled={isStreaming}
				onclick={() => onSelectSlot(account.endpointId)}
				role="radio"
				type="button"
			>
				<Cloud class="text-primary size-5 shrink-0" />
				<span class="flex min-w-0 flex-col gap-0.5">
					<span class="text-foreground flex items-center gap-2 text-sm font-medium">
						<span class="truncate" data-testid="ingest-slot-label">{managedSlotLabel(account)}</span>
						{#if account.default}
							<span class="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase">
								{$LL.settings.ingestSlotDefault()}
							</span>
						{/if}
					</span>
					{#if account.region}
						<span class="text-muted-foreground text-xs leading-snug">{account.region}</span>
					{/if}
					{#if obsInstanceAssociation(account)}
						<span
							class="text-muted-foreground text-xs leading-snug"
							data-testid="obs-instance-association"
							data-endpoint-id={account.endpointId}
						>
							{$LL.settings.feedsCloudObsInstance({
								label: obsInstanceAssociation(account)?.label ?? '',
							})}
						</span>
					{/if}
				</span>
			</button>
		{/each}
	</div>
</div>
