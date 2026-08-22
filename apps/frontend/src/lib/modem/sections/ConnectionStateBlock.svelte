<!--
  ConnectionStateBlock.svelte — WHAT IT IS DOING, and WHY IT IS NOT WORKING.

  Leg 3 of the guaranteed minimum baseline lives here: `unavailability` is the
  row's explicit statement that it cannot be acted on, WITH a reason, and
  `derive.ts` guarantees it is non-empty whenever the row would otherwise say
  nothing at all. That is what stops an unrecognised device rendering identity
  and then silence — which an operator reads as a broken card rather than as an
  honest "we were told nothing".

  ── THE REASONS DO NOT FOLD ─────────────────────────────────────────────────

  Every note here is also a disabled control's reason somewhere, and the shipped
  kiosk touchscreen cannot hover to reveal a tooltip — so folding them behind a
  disclosure would trade a real honesty invariant for pixels. They are already
  de-duplicated and capped by the row's own authority before they reach this
  block, so there is no wall to fold: what is on screen is the minimum set of
  distinct facts.

  ── EVERY STATE CARRIES A WORD AND A GLYPH ──────────────────────────────────

  Colour is reinforcement. `data-tone` and `data-connection-state` make the
  register machine-readable so a gate can assert the distinction without
  matching on a class name a CSS change would walk straight through.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import {
	CircleAlert,
	CircleCheck,
	CircleHelp,
	Hourglass,
	Plane,
	TriangleAlert,
} from '@lucide/svelte';

import Badge, { type StatusVariant } from '$lib/components/custom/Badge.svelte';

import type { ConnectionModel, ModemRowTone, UnavailabilityNote } from './types';

interface Props {
	connection: ConnectionModel;
	/** The row's explanation lines, already ordered and de-duplicated. */
	unavailability?: readonly UnavailabilityNote[];
	/** Test-id stem. */
	name?: string;
	/** Heading, already localized. Omit for a block whose host already titled it. */
	title?: string;
}

let {
	connection,
	unavailability = [],
	name = 'modem-connection',
	title,
}: Props = $props();

/*
  The SAME register map the cellular row uses. `ready` takes the info register
  because it is the only one that is neither a claim of trouble nor a claim of
  traffic: amber would say "still working on it" about a resting-healthy radio,
  and the live colour is reserved for a link that is actually carrying.
*/
const TONE_BADGE: Record<ModemRowTone, StatusVariant> = {
	live: 'success',
	ready: 'info',
	pending: 'warning',
	attention: 'warning',
	error: 'error',
	idle: 'neutral',
};

const TONE_ICON = {
	live: CircleCheck,
	ready: CircleCheck,
	pending: Hourglass,
	attention: TriangleAlert,
	error: CircleAlert,
	idle: CircleHelp,
} satisfies Record<ModemRowTone, unknown>;

const StateIcon = $derived(TONE_ICON[connection.tone]);
</script>

<section class="space-y-1.5" data-testid={name} data-connection-state={connection.state}>
	{#if title}
		<p class="text-muted-foreground text-xs">{title}</p>
	{/if}

	<div class="flex flex-wrap items-center gap-2">
		<Badge
			data-testid={`${name}-state`}
			data-tone={connection.tone}
			size="micro"
			variant={TONE_BADGE[connection.tone]}
		>
			{#snippet icon()}
				<StateIcon aria-hidden="true" class="size-3 shrink-0" />
			{/snippet}
			{resolveMessageKey(connection.labelKey)}
		</Badge>

		{#if connection.carrier}
			<Badge
				data-testid={`${name}-carrier`}
				label={connection.carrier}
				size="micro"
				variant="neutral"
			/>
		{/if}

		<!--
		  Rendered only while the radio is ACTUALLY roaming, i.e. only while money
		  is being spent. The operator's PERMISSION to roam is a setting, and
		  badging a modem on its home network would report that setting back to the
		  person who set it.
		-->
		{#if connection.roaming}
			<Badge
				data-roaming="true"
				data-testid={`${name}-roaming`}
				size="micro"
				title={m['network.cellular.roaming.hint']()}
				variant="warning"
			>
				{#snippet icon()}
					<Plane aria-hidden="true" class="size-3 shrink-0" />
				{/snippet}
				{m['network.cellular.roaming.badge']()}
			</Badge>
		{/if}
	</div>

	{#if connection.rejectionKey}
		<p class="text-status-warning text-xs" data-testid={`${name}-rejection`} role="status">
			{resolveMessageKey(connection.rejectionKey)}
		</p>
	{/if}

	{#if unavailability.length > 0}
		<ul class="space-y-1" data-testid="modem-unavailability">
			{#each unavailability as note (note.reasonKey)}
				<li
					class="text-muted-foreground text-xs"
					data-testid={`modem-unavailability-${note.id}`}
					data-reason-key={note.reasonKey}
				>
					{resolveMessageKey(note.reasonKey)}
				</li>
			{/each}
		</ul>
	{/if}
</section>
