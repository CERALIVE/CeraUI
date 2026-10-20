<!--
  SlotsSection.svelte — the two RAUC root slots, side by side as one table
  (Todo 41).

  Rendered only on an image that carries the lagged slot mirror
  (`updateCapabilityView().slots`). `null` slots means the device could not read
  `rauc status`, which is its own sentence — never an empty table that reads
  like a board with no slots. Every state is a WORD; the badge colour only
  reinforces it. Versions and mirror times are data and render as the device
  reported them, and a slot that reported none says so instead of showing a dash.
-->
<script lang="ts">
import { getLocale, m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { UpdateSlotStatus } from '@ceraui/rpc/schemas';

import Badge from '$lib/components/custom/Badge.svelte';
import {
	formatUpdateTime,
	slotHealthKey,
	slotLetter,
	slotStateKey,
} from '$lib/updates/update-view';

interface Props {
	/** `null` = the device answered but could not read the slots; `undefined` = not read. */
	slots: readonly UpdateSlotStatus[] | null | undefined;
}

let { slots }: Props = $props();

const locale = $derived(getLocale());
</script>

<section aria-labelledby="updates-slots-heading" class="space-y-2.5" data-testid="updates-slots">
	<h3 class="text-sm font-semibold" id="updates-slots-heading">{m['settings.updates.slots.title']()}</h3>

	{#if slots === null || slots === undefined || slots.length === 0}
		<p
			class="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-3 text-sm"
			data-testid="update-slots-unavailable"
			role="status"
		>
			{m['settings.updates.slots.unavailable']()}
		</p>
	{:else}
		<ul class="divide-border divide-y overflow-hidden rounded-lg border">
			{#each slots as slot (slot.name)}
				{@const letter = slotLetter(slot)}
				{@const healthKey = slotHealthKey(slot.bootStatus)}
				{@const mirrored = formatUpdateTime(slot.lastSyncedAt, locale)}
				<li
					class="space-y-1.5 px-4 py-3"
					data-slot-name={slot.name}
					data-slot-state={slot.state}
					data-testid={`update-slot-${letter}`}
				>
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-sm font-semibold">{m['settings.updates.slots.slot']({ letter })}</span>
						<Badge
							label={resolveMessageKey(slotStateKey(slot.state))}
							variant={slot.state === 'booted' ? 'success' : 'neutral'}
						/>
						{#if healthKey}
							<Badge
								label={resolveMessageKey(healthKey)}
								variant={slot.bootStatus === 'bad' ? 'error' : 'success'}
							/>
						{/if}
					</div>
					<p class="text-sm">
						{#if slot.version}
							<span class="font-mono text-xs" dir="ltr">{slot.version}</span>
						{:else}
							<span class="text-muted-foreground text-xs">{m['settings.updates.slots.versionUnknown']()}</span>
						{/if}
					</p>
					<p class="text-muted-foreground text-xs">
						{mirrored
							? m['settings.updates.slots.lastSynced']({ time: mirrored })
							: m['settings.updates.slots.neverSynced']()}
					</p>
				</li>
			{/each}
		</ul>
	{/if}
</section>
