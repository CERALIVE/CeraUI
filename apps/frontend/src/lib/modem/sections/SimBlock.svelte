<!--
  SimBlock.svelte — WHETHER THERE IS A CARD IN IT.

  The empty-slot pill is `NoSimBadge`, the ONE "No SIM" tag this app has. It is
  reused rather than reproduced for the reason it was unified in the first
  place: the same physical condition once rendered in three different colours
  behind three different glyphs on three different surfaces, and an operator
  comparing two devices on one screen could not tell they were reading the same
  fact twice.

  FOUR states, because `unknown` is real. Different classes of device publish
  slot state through different wire fields and a device may publish neither, so
  "we were not told" is its own answer and must not be rendered as a populated
  slot. The predicate behind `absent` is the SHARED one the device's own bond
  gate applies — an offering the device refuses and a refusal the device does not
  apply are both lies, in opposite directions.

  Every state prints a WORD. Colour and glyph reinforce it; neither carries it.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { CircleCheck, CircleHelp, Lock } from '@lucide/svelte';

import Badge from '$lib/components/custom/Badge.svelte';
import NoSimBadge from '$lib/components/custom/NoSimBadge.svelte';

import type { SimModel } from './types';

interface Props {
	sim: SimModel;
	/** Test-id stem. */
	name?: string;
	/** Heading, already localized. Omit for a block whose host already titled it. */
	title?: string;
}

let { sim, name = 'modem-sim', title }: Props = $props();
</script>

<section class="space-y-1.5" data-testid={name} data-sim-presence={sim.presence}>
	{#if title}
		<p class="text-muted-foreground text-xs">{title}</p>
	{/if}

	{#if sim.presence === 'absent'}
		<NoSimBadge testid={`${name}-absent`} />
	{:else if sim.presence === 'locked'}
		<Badge
			data-sim-lock={sim.lock}
			data-testid={`${name}-locked`}
			label={m['network.cellular.state.locked']()}
			size="micro"
			variant="warning"
		>
			{#snippet icon()}
				<Lock aria-hidden="true" class="size-3 shrink-0" />
			{/snippet}
		</Badge>
	{:else if sim.presence === 'present'}
		<Badge data-testid={`${name}-present`} size="micro" variant="success">
			{#snippet icon()}
				<CircleCheck aria-hidden="true" class="size-3 shrink-0" />
			{/snippet}
			{m['network.modem.sections.sim.present']()}
		</Badge>
	{:else}
		<!--
		  NOT a pill. "The device did not say" is not a status the device reported,
		  so it must not wear the same chrome as one that it did.
		-->
		<p
			class="text-muted-foreground flex items-center gap-1.5 text-xs"
			data-testid={`${name}-unknown`}
			role="status"
		>
			<CircleHelp aria-hidden="true" class="size-3 shrink-0" />
			{m['network.modem.sections.sim.unknown']()}
		</p>
	{/if}
</section>
