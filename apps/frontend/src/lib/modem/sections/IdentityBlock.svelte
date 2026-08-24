<!--
  IdentityBlock.svelte — WHICH DEVICE this is. Leg 1 of the guaranteed minimum
  baseline, and the one that makes "never an empty card" true.

  IT ALWAYS RENDERS SOMETHING. There is no input — not an unrecognised device,
  not a device that published nothing but an interface name, not an empty object
  from a backend older than every field below — for which this block draws
  nothing. `derive.ts` guarantees a title or a stand-in key, and this renders
  whichever it was handed.

  A row that fell back to its INTERFACE NAME is labelled honestly rather than
  quietly: the name is shown (it is a real identity, and it is what every other
  network surface on this device calls the same link) AND a note says the device
  named itself nothing. Presenting a kernel name as a product name is the small
  lie that makes an operator hunt for a device they are already looking at.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';

import Badge from '$lib/components/custom/Badge.svelte';

import type { IdentityModel } from './types';

interface Props {
	identity: IdentityModel;
	/** Test-id stem. Defaults to the shared name both dialogs assert against. */
	name?: string;
	/** Heading, already localized. Omit for a block whose host already titled it. */
	title?: string;
}

let { identity, name = 'modem-identity', title }: Props = $props();

const heading = $derived(
	identity.title !== '' ? identity.title : resolveMessageKey(identity.titleKey ?? ''),
);
</script>

<section class="space-y-1.5" data-testid={name} data-identified={identity.identified}>
	{#if title}
		<p class="text-muted-foreground text-xs">{title}</p>
	{/if}

	<div class="flex flex-wrap items-center gap-2">
		<p class="min-w-0 text-sm leading-tight font-medium" data-testid={`${name}-title`}>
			{heading}
		</p>
		{#if identity.slotLabel}
			<Badge
				data-testid={`${name}-slot`}
				label={identity.slotLabel}
				size="micro"
				variant="neutral"
			/>
		{/if}
	</div>

	{#if identity.detail}
		<p class="text-muted-foreground text-xs" data-testid={`${name}-detail`}>
			{identity.detail}
		</p>
	{/if}

	<!--
	  Rendered on screen rather than in a `title`: the shipped kiosk touchscreen
	  cannot hover, and "the device did not name itself" is exactly the fact an
	  operator needs before they go looking for the name they expected.
	-->
	{#if !identity.identified}
		<p class="text-muted-foreground text-xs" data-testid={`${name}-unnamed`} role="status">
			{m['network.modem.sections.identity.unnamedNote']()}
		</p>
	{/if}

	<p class="text-muted-foreground text-xs" data-testid={`${name}-class-hint`}>
		{resolveMessageKey(identity.classHintKey)}
	</p>
</section>
