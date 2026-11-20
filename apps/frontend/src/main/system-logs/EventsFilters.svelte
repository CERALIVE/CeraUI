<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { EVENT_FAMILIES } from '@ceraui/rpc/schemas';
import { ListFilter } from '@lucide/svelte';
import { MediaQuery } from 'svelte/reactivity';

import { Button } from '$lib/components/ui/button';
import { Toggle } from '$lib/components/ui/toggle';
import type { EventsView } from '$lib/device-logs/events-view.svelte';

let { view }: { view: EventsView } = $props();

// Chips sit inline only with room both ways; a 1024x600 kiosk folds them too.
const inline = new MediaQuery('(min-width: 768px) and (min-height: 601px)');
const CHIP = 'min-h-(--touch-target-min)';
const uid = $props.id();
let filtersOpen = $state(false);
</script>

{#snippet filters()}
	<fieldset aria-label={m['systemLogs.events.families']()} class="flex flex-wrap items-center gap-2">
		{#each EVENT_FAMILIES as family (family)}
			<Toggle
				class={CHIP}
				onPressedChange={() => view.toggleFamily(family)}
				pressed={view.filter.families.includes(family)}
				size="sm"
				variant="outline"
			>
				{m[`timeline.family.${family}`]()}
			</Toggle>
		{/each}
	</fieldset>
	<Toggle
		class={CHIP}
		onPressedChange={(pressed) => view.setProblemsOnly(pressed)}
		pressed={view.filter.problemsOnly}
		size="sm"
		variant="outline"
	>
		{m['systemLogs.events.problemsOnly']()}
	</Toggle>
{/snippet}

<div class="flex flex-col gap-3 border-b px-4 py-3" data-testid="events-filters">
	{#if inline.current}
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2">{@render filters()}</div>
	{:else}
		<Button
			aria-controls="{uid}-filters"
			aria-expanded={filtersOpen}
			class="data-active:bg-muted gap-1.5 self-start"
			data-active={view.filtered || undefined}
			data-testid="events-filter-toggle"
			onclick={() => (filtersOpen = !filtersOpen)}
			size="sm"
			variant="outline"
		>
			<ListFilter class="size-4" />
			{m['systemLogs.events.filter']()}
		</Button>
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2" hidden={!filtersOpen} id="{uid}-filters">
			{@render filters()}
		</div>
	{/if}
</div>
