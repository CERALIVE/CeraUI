<!--
  ModemFccUnlockSection.svelte — the per-MODEL FCC auto-unlock opt-in.

  THE DISCLOSURE IS PART OF THE CONTROL, NOT A FOOTNOTE. ModemManager's mechanism
  is a `/etc/ModemManager/fcc-unlock.d/<vid>:<pid>` symlink, so this toggle applies
  to EVERY attached device matching that model — two identical dongles cannot be
  separated, and no per-unit refinement exists without changing ModemManager. An
  operator who is not told that before they act will reasonably read the toggle as
  being about the modem row they opened, which it is not. The `<vid>:<pid>` is
  shown for the same reason: it is the exact thing the toggle acts on.

  THE FOUR-STATE LADDER IS `CapabilitySection`'s, NOT THIS FILE'S — see
  `ModemGpsSection` for the same note. `fccUnlockView` keeps the FCC-specific
  decision (which state this model is in); the shared primitive owns what each
  state renders, and every test id is unchanged: `modem-fcc-unlock`, `-toggle`,
  `-reason`, `-unknown`, plus the outcome band's own.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { FccUnlockState, SupportClaimState } from '@ceraui/rpc/schemas';

import { Switch } from '$lib/components/ui/switch';
import type { MutationOutcome } from '$lib/modem/mutation-outcome';
import { CapabilitySection, gatedSurfaceCapability } from '$lib/modem/sections';

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
const capability = $derived(gatedSurfaceCapability(view));
</script>

<CapabilitySection
	name="modem-fcc-unlock"
	view={capability}
	{busy}
	{outcome}
	controlId="modem-fcc-unlock-toggle"
	title={m['network.modem.fccUnlock.title']()}
	description={m['network.modem.fccUnlock.description']()}
>
	{#snippet control(ctx)}
		<Switch
			id="modem-fcc-unlock-toggle"
			data-testid="modem-fcc-unlock-toggle"
			checked={view.kind === 'toggle' && view.enabled}
			disabled={ctx.disabled}
			aria-label={ctx.reason}
			aria-describedby={ctx.reasonId}
			title={ctx.reason}
			onCheckedChange={(next) => onToggle(next)}
		/>
	{/snippet}

	{#if view.kind === 'toggle'}
		<p class="text-muted-foreground text-xs" data-testid="modem-fcc-unlock-model-wide">
			{m['network.modem.fccUnlock.modelWide']({ model: view.key })}
		</p>
		<p class="text-muted-foreground text-xs" data-testid="modem-fcc-unlock-reprobe">
			{m['network.modem.fccUnlock.reprobeNotice']()}
		</p>
	{/if}
</CapabilitySection>
