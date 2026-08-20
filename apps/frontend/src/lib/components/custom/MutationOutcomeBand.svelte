<!--
  MutationOutcomeBand.svelte — one component for BOTH halves of a mutation
  outcome, because shipping either half alone is the defect this replaces.

  `DESIGN.md` §8 opens with the reason: *an outcome the operator cannot see is an
  outcome that did not happen*. Two ways to fail that were live on these
  surfaces, and a component that renders only one of them makes the second easy
  to forget:

    · A TOAST-ONLY outcome. `RouterDongleDialog` answered every router write with
      `toast.success`/`toast.error`. Four seconds later the dialog looked exactly
      like one where nothing had been attempted — and for a PESSIMISTIC surface,
      where a refused write correctly leaves the control unmoved, the toast was
      the ONLY thing that distinguished "refused" from "never tried".
    · An UNANNOUNCED outcome. The GPS and FCC failures rendered as a plain
      paragraph, so an operator using a screen reader learned nothing at all: the
      switch they just toggled simply stayed where it was.

  So this renders a PERSISTENT visible band AND announces it, and neither is
  optional. Six properties are load-bearing:

  1. **BOTH LIVE REGIONS ARE MOUNTED UNCONDITIONALLY (LR-1).** They exist before
     any outcome can fire, including on a surface whose control has not been
     touched yet. A region created at announcement time announces nothing, which
     is the single most common way this fails silently.
  2. **THE VISIBLE BAND CARRIES NO LIVE ROLE (LR-3).** The announcement rides the
     sr-only regions; giving the band `role="status"` too would announce every
     outcome twice. That is why `outcomeBandRole` exists and returns nothing —
     the rule is written down rather than left as an absence someone "fixes".
  3. **POLITENESS FOLLOWS THE KIND, NOT THE SURFACE (LR-2).** Resolved once, in
     `outcomeIsAssertive`. Success is polite; a refusal and an unknown outcome
     interrupt.
  4. **THE THREE KINDS ARE DISTINCT BY WORD, GLYPH AND TONE.** Colour is
     reinforcement only — every band prints its sentence, and `data-outcome`
     makes the distinction machine-readable for the gate.
  5. **`unknown` IS NEVER STYLED AS EITHER NEIGHBOUR.** It is the write whose
     fate we do not know (LR-6's third arm), so it takes the warning register and
     its own glyph rather than borrowing the refusal's.
  6. **IT IS STATIC CSS.** No transition, no animation — so both global motion
     freezes (`prefers-reduced-motion` and the e-ink `transition: none`) cover it
     for free, and an outcome can never be a state carried by movement.
-->
<script lang="ts">
import { CircleCheck, CircleHelp, TriangleAlert } from '@lucide/svelte';

import {
	type MutationOutcome,
	outcomeIsAssertive,
	outcomeTone,
} from '$lib/modem/mutation-outcome';

interface Props {
	/** The last terminal outcome, or `undefined` while none has been reached. */
	outcome: MutationOutcome | undefined;
	/** Test-id prefix. The band is `<name>-outcome`; the regions `<name>-announce-*`. */
	name: string;
}

let { outcome, name }: Props = $props();

const assertive = $derived(
	outcome !== undefined && outcomeIsAssertive(outcome.kind),
);
// Each region holds ONLY the outcomes of its own politeness class, so a refusal
// following a success replaces the assertive text and empties the polite one
// rather than leaving a stale sentence an assistive technology may re-read.
const politeText = $derived(outcome !== undefined && !assertive ? outcome.message : '');
const assertiveText = $derived(outcome !== undefined && assertive ? outcome.message : '');

const tone = $derived(outcome === undefined ? 'warning' : outcomeTone(outcome.kind));
const toneClass = $derived(
	tone === 'success'
		? 'border-status-success/30 bg-status-success/10 text-status-success'
		: tone === 'error'
			? 'border-status-error/30 bg-status-error/10 text-status-error'
			: 'border-status-warning/30 bg-status-warning/10 text-status-warning',
);
</script>

<!--
  LR-1. Outside every `{#if}` on purpose: these two nodes must already be in the
  document when the first outcome lands.
-->
<span
	class="sr-only"
	role="status"
	aria-live="polite"
	data-testid={`${name}-announce-polite`}>{politeText}</span
>
<span
	class="sr-only"
	role="alert"
	aria-live="assertive"
	data-testid={`${name}-announce-assertive`}>{assertiveText}</span
>

{#if outcome}
	<p
		class={`flex items-start gap-2 rounded-md border p-2 text-xs ${toneClass}`}
		data-testid={`${name}-outcome`}
		data-outcome={outcome.kind}
	>
		{#if outcome.kind === 'applied'}
			<CircleCheck class="mt-px size-3.5 shrink-0" aria-hidden="true" />
		{:else if outcome.kind === 'refused'}
			<TriangleAlert class="mt-px size-3.5 shrink-0" aria-hidden="true" />
		{:else}
			<CircleHelp class="mt-px size-3.5 shrink-0" aria-hidden="true" />
		{/if}
		<span>{outcome.message}</span>
	</p>
{/if}
