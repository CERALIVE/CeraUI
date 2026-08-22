<!--
  Test harness for `CapabilitySection`.

  It exists because the control is a SNIPPET, and a snippet cannot be handed to
  `render()` as a plain prop. The control it supplies is a bare `<button>` so the
  assertions are about the SECTION's contract — is a control offered at all, is
  it disabled, is the reason on screen and reachable from the control — rather
  than about any particular widget's internals.
-->
<script lang="ts">
import type { MutationOutcome } from '$lib/modem/mutation-outcome';

import CapabilitySection from '../CapabilitySection.svelte';
import type { CapabilityView } from '../types';

interface Props {
	view: CapabilityView;
	title?: string;
	description?: string;
	controlId?: string;
	busy?: boolean;
	outcome?: MutationOutcome | undefined;
	withControl?: boolean;
	withChildren?: boolean;
}

let {
	view,
	title = 'Location',
	description,
	controlId,
	busy = false,
	outcome,
	withControl = true,
	withChildren = true,
}: Props = $props();
</script>

<CapabilitySection
	{busy}
	{controlId}
	{description}
	name="harness-capability"
	{outcome}
	{title}
	{view}
>
	{#snippet control(context)}
		{#if withControl}
			<button
				aria-describedby={context.reasonId}
				aria-label={context.reason}
				data-control-state={context.state}
				data-testid="harness-capability-toggle"
				disabled={context.disabled}
				id={controlId}
				type="button">toggle</button
			>
		{/if}
	{/snippet}

	{#if withChildren}
		<p data-testid="harness-capability-body">reading</p>
	{/if}
</CapabilitySection>
