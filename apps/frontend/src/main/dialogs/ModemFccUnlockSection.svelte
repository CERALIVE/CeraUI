<!--
  ModemFccUnlockSection.svelte — the per-MODEL FCC auto-unlock opt-in.

  THE DISCLOSURE IS PART OF THE CONTROL, NOT A FOOTNOTE. ModemManager's mechanism
  is a `/etc/ModemManager/fcc-unlock.d/<vid>:<pid>` symlink, so this toggle applies
  to EVERY attached device matching that model — two identical dongles cannot be
  separated, and no per-unit refinement exists without changing ModemManager. An
  operator who is not told that before they act will reasonably read the toggle as
  being about the modem row they opened, which it is not. The `<vid>:<pid>` is
  shown for the same reason: it is the exact thing the toggle acts on.

  It renders one of the FOUR `DESIGN.md` §1 states, tagged for a gate by
  `data-capability-state`:

    absent    — this build or this modem cannot act, so not one node is rendered
                (CT-1). On a fleet where 7 of 8 devices are uncovered, a permanent
                row on every one of them is noise, not honesty.
    unknown   — a `role="status"` diagnostic and NO control (CT-3/CT-4).
    blocked   — the switch, DISABLED, with its reason ON SCREEN (CT-2).
    available — the switch, live, with the model-wide disclosure beside it.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { FccUnlockState, SupportClaimState } from '@ceraui/rpc/schemas';

import MutationOutcomeBand from '$lib/components/custom/MutationOutcomeBand.svelte';
import { Label } from '$lib/components/ui/label';
import { Switch } from '$lib/components/ui/switch';
import type { MutationOutcome } from '$lib/modem/mutation-outcome';

import { fccUnlockView } from './modem-fcc-unlock';

interface Props {
	claim: SupportClaimState | undefined;
	state: FccUnlockState | undefined;
	busy?: boolean;
	/** The last terminal outcome of a toggle — success included (§8 LR-5). */
	outcome?: MutationOutcome | undefined;
	onToggle: (enabled: boolean) => void;
}

let { claim, state, busy = false, outcome, onToggle }: Props = $props();

const view = $derived(fccUnlockView(claim, state));
const capabilityState = $derived(
	view.kind === 'toggle' ? 'available' : view.kind,
);
const blockedReason = $derived(
	view.kind === 'blocked' ? resolveMessageKey(view.reasonKey) : undefined,
);
</script>

{#if view.kind !== 'absent'}
	<section
		class="space-y-2"
		data-testid="modem-fcc-unlock"
		data-capability-state={capabilityState}
	>
		<div class="flex items-start justify-between gap-3">
			<div class="space-y-1">
				<Label for="modem-fcc-unlock-toggle">{m['network.modem.fccUnlock.title']()}</Label>
				<p class="text-muted-foreground text-xs">
					{m['network.modem.fccUnlock.description']()}
				</p>
			</div>
			<!--
			  A DISABLED switch is offered only at `blocked`, where the claim is
			  already ≥ capable — CT-4's "no fake control". At `unknown` there is no
			  switch at all, disabled or otherwise.
			-->
			{#if view.kind === 'toggle' || view.kind === 'blocked'}
				<Switch
					id="modem-fcc-unlock-toggle"
					data-testid="modem-fcc-unlock-toggle"
					checked={view.kind === 'toggle' && view.enabled}
					disabled={busy || view.kind === 'blocked'}
					aria-label={blockedReason}
					title={blockedReason}
					onCheckedChange={(next) => onToggle(next)}
				/>
			{/if}
		</div>

		{#if view.kind === 'toggle'}
			<p class="text-muted-foreground text-xs" data-testid="modem-fcc-unlock-model-wide">
				{m['network.modem.fccUnlock.modelWide']({ model: view.key })}
			</p>
			<p class="text-muted-foreground text-xs" data-testid="modem-fcc-unlock-reprobe">
				{m['network.modem.fccUnlock.reprobeNotice']()}
			</p>
		{:else if view.kind === 'unknown'}
			<!--
			  Visibly distinct from BOTH the offered and the withheld renderings, and
			  announced: "we have not established this" is a different fact from
			  "this modem cannot do it".
			-->
			<p
				class="text-muted-foreground text-xs"
				data-testid="modem-fcc-unlock-unknown"
				data-state="unknown"
				role="status"
			>
				{resolveMessageKey(view.reasonKey)}
			</p>
		{:else}
			<p class="text-status-warning text-xs" data-testid="modem-fcc-unlock-reason">
				{blockedReason}
			</p>
		{/if}

		<MutationOutcomeBand name="modem-fcc-unlock" {outcome} />
	</section>
{/if}
