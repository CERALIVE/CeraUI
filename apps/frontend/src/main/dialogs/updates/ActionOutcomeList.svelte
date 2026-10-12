<!--
  ActionOutcomeList.svelte — every update action outcome on screen, oldest
  dispatch first.

  Each action keeps its own band (`update-action-outcome.ts`): a newer Check
  must not erase an Install whose outcome nobody has confirmed, so more than
  one band can stand at once, and each names the control that started it.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';

import type { ActionBand, UpdateActionKind } from '$lib/updates/update-action-outcome';

import ActionOutcomeBand from './ActionOutcomeBand.svelte';

interface Props {
	bands: readonly ActionBand[];
}

let { bands }: Props = $props();

const ACTION_LABEL = {
	check: () => m['settings.updates.system.checkNow'](),
	install: () => m['settings.updates.system.installNow'](),
	cellular: () => m['settings.updates.cellular.approve'](),
} satisfies Readonly<Record<UpdateActionKind, () => string>>;
</script>

{#if bands.length > 0}
	<div class="space-y-2" data-testid="update-action-outcomes">
		{#each bands as band (band.call)}
			{#if band.state === 'refused'}
				<ActionOutcomeBand
					label={ACTION_LABEL[band.action]()}
					refusal={{ action: band.action, reason: band.reason }}
					unconfirmed={undefined}
				/>
			{:else}
				<ActionOutcomeBand
					cause={band.cause}
					label={ACTION_LABEL[band.action]()}
					refusal={undefined}
					unconfirmed={band.action}
				/>
			{/if}
		{/each}
	</div>
{/if}
