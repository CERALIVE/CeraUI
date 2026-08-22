<!--
  CapabilitySection.svelte — the FOUR-STATE contract, once, for every surface.

  `ModemGpsSection` and `ModemFccUnlockSection` each wrote this ladder out by
  hand and got it right; a third and a fourth hand-written copy is how one of
  them eventually gets it wrong, and the way it goes wrong is always the same —
  a disabled control appears where nothing has been established, or a reason
  ends up in a `title` the shipped kiosk touchscreen cannot hover to reveal.
  This is that ladder extracted, so there is ONE of it.

  The four states and the DOM each renders:

    absent    — NOT ONE NODE. No section, no heading, no live region, no
                placeholder. `absent` means the capability positively does not
                exist here, and a ghost row for it is noise on every device that
                does not have it.
    unknown   — the heading, plus a visibly distinct `role="status"` diagnostic,
                and NO CONTROL AT ALL. Below `capable` nobody has shown there is
                a capability being withheld, so a disabled control would claim
                one. "We have not established this" and "this device cannot do
                it" are different facts and must not render the same way.
    blocked   — the heading, the control DISABLED, and the refusal ON SCREEN
                beside it. Never a bare disabled control; never a reason that
                lives only in a tooltip.
    available — the heading, the control live, and whatever readings the caller
                renders beneath it.

  `data-capability-state` makes all four distinguishable to a gate rather than
  only to a reader, and it is the attribute the capability-truth tests assert.

  ── THE CONTROL IS ONE SNIPPET, RENDERED IN TWO STATES ──────────────────────

  A caller writes its control ONCE and is handed `{ disabled, state, reason,
  reasonId }`. Authoring a live control and a disabled twin separately is how
  the two drift, and the drift is invisible until an operator meets the state
  nobody looks at. `busy` ORs into `disabled`, so an in-flight write disables
  the same control without changing which state the section is in.

  Nothing in this file — or anywhere under `lib/modem/sections/` — asks what
  KIND of device it is rendering for.
-->
<script lang="ts">
import { resolveMessageKey } from '@ceraui/i18n/svelte';
import type { Snippet } from 'svelte';

import MutationOutcomeBand from '$lib/components/custom/MutationOutcomeBand.svelte';
import { Label } from '$lib/components/ui/label';
import type { MutationOutcome } from '$lib/modem/mutation-outcome';

import type { CapabilityControlContext, CapabilityView } from './types';

interface Props {
	/**
	 * Test-id stem. The section is `<name>`; the diagnostic `<name>-unknown`;
	 * the refusal `<name>-reason`; the control wrapper `<name>-control`; the
	 * outcome band and its two live regions follow `MutationOutcomeBand`.
	 */
	name: string;
	/** The already-resolved four-state verdict. */
	view: CapabilityView;
	/** Section heading, already localized by the caller. */
	title: string;
	/** Optional supporting sentence under the heading. */
	description?: string;
	/** DOM id of the caller's control, so the heading can label it. */
	controlId?: string;
	/** A write is in flight — disables the control WITHOUT changing the state. */
	busy?: boolean;
	/** The last terminal outcome of a write — SUCCESS INCLUDED (§8 LR-5). */
	outcome?: MutationOutcome | undefined;
	/** Rendered at `available` and `blocked`. NEVER at `unknown` or `absent`. */
	control?: Snippet<[CapabilityControlContext]>;
	/** Rendered at `available` only — readings that only make sense when live. */
	children?: Snippet;
}

let {
	name,
	view,
	title,
	description,
	controlId,
	busy = false,
	outcome,
	control,
	children,
}: Props = $props();

const reasonId = $derived(`${name}-reason`);
const reason = $derived(
	view.mode === 'unknown' || view.mode === 'blocked'
		? resolveMessageKey(view.reasonKey)
		: undefined,
);
/*
  CT-4, expressed as a boolean rather than as three inline conditions: a control
  exists only where a capability has been established. `unknown` gets none.
*/
const offersControl = $derived(view.mode === 'available' || view.mode === 'blocked');
const controlContext = $derived<CapabilityControlContext>({
	disabled: busy || view.mode === 'blocked',
	state: view.mode === 'blocked' ? 'blocked' : 'available',
	...(view.mode === 'blocked' && reason !== undefined
		? { reason, reasonId }
		: {}),
});
</script>

{#if view.mode !== 'absent'}
	<section class="space-y-2" data-testid={name} data-capability-state={view.mode}>
		<div class="flex items-start justify-between gap-3">
			<div class="min-w-0 space-y-1">
				{#if controlId}
					<Label for={controlId}>{title}</Label>
				{:else}
					<p class="text-sm leading-none font-medium">{title}</p>
				{/if}
				{#if description}
					<p class="text-muted-foreground text-xs">{description}</p>
				{/if}
			</div>
			{#if control && offersControl}
				<div class="shrink-0" data-testid={`${name}-control`}>
					{@render control(controlContext)}
				</div>
			{/if}
		</div>

		{#if view.mode === 'unknown'}
			<!--
			  Visibly distinct from BOTH the offered and the withheld renderings, and
			  ANNOUNCED: rendering "we have not established this" as "this device
			  cannot do it" is the one substitution the ladder exists to prevent.
			-->
			<p
				class="text-muted-foreground text-xs"
				data-testid={`${name}-unknown`}
				data-state="unknown"
				role="status"
			>
				{reason}
			</p>
		{:else if view.mode === 'blocked'}
			<p class="text-status-warning text-xs" data-testid={`${name}-reason`} id={reasonId}>
				{reason}
			</p>
		{:else if children}
			{@render children()}
		{/if}

		<MutationOutcomeBand {name} {outcome} />
	</section>
{/if}
