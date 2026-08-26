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

  ── `class` AND `icon` ARE ADDITIVE, AND THAT IS WHY THEY EXIST ─────────────

  A host renders this as one of several stacked CARDS, each with its own frame
  and leading glyph. Without those two props a caller has to wrap the section in
  a bordered `<div>` and put the glyph outside the heading it belongs to — which
  is a second layout for the same object, i.e. exactly the drift this component
  removes. Both default to nothing, so every existing call site is byte-identical.

  ── SO IS `reason`, AND IT IS THE SAME BARGAIN AS `DiagnosticsBlock.extra` ───

  A refusal is normally a KEY, resolved here. Some refusals are not: the router
  dongle's network-mode capability answers with the FIRMWARE's own error code
  interpolated into copy (`…refuses to report its network modes (error 112008)`),
  so the caller already holds an operator sentence and has no key left to hand
  over. `reason` takes that sentence verbatim and wins over `view.reasonKey`.
  Do NOT pass a raw wire token through it — the point of the key path is that a
  machine token can never reach an operator, and that rule is unchanged.
-->
<script lang="ts">
import { resolveMessageKey } from '@ceraui/i18n/svelte';
import type { Component, Snippet } from 'svelte';

import MutationOutcomeBand from '$lib/components/custom/MutationOutcomeBand.svelte';
import { Label } from '$lib/components/ui/label';
import type {
	MutationOutcome,
	MutationOutcomeDetail,
} from '$lib/modem/mutation-outcome';
import { cn } from '$lib/utils';

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
	/**
	 * The classified operation detail behind that outcome, already localized.
	 * Additive — a section whose wire carries none is byte-identical.
	 */
	detail?: MutationOutcomeDetail | undefined;
	/**
	 * An ALREADY-LOCALIZED refusal sentence, for a caller whose reason carries a
	 * device-supplied value and is therefore no longer a key. Wins over
	 * `view.reasonKey` at `unknown` and `blocked`.
	 */
	reason?: string;
	/** Extra section classes, so a host card keeps its own frame. */
	class?: string;
	/** Optional leading glyph, rendered beside the heading it belongs to. */
	icon?: Component;
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
	detail,
	reason: reasonOverride,
	class: className,
	icon,
	control,
	children,
}: Props = $props();

const Icon = $derived(icon);

const reasonId = $derived(`${name}-reason`);
const reason = $derived(
	view.mode === 'unknown' || view.mode === 'blocked'
		? (reasonOverride ?? resolveMessageKey(view.reasonKey))
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
	<section
		class={cn('space-y-2', className)}
		data-testid={name}
		data-capability-state={view.mode}
	>
		<div class="flex items-start justify-between gap-3">
			<div class="flex min-w-0 items-start gap-2.5">
				{#if Icon}
					<Icon class="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
				{/if}
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

		<MutationOutcomeBand {name} {outcome} {detail} />
	</section>
{/if}
