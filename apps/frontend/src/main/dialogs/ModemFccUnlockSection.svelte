<!--
  ModemFccUnlockSection.svelte — the per-MODEL FCC auto-unlock opt-in.

  THE DISCLOSURE IS PART OF THE CONTROL, NOT A FOOTNOTE. ModemManager's mechanism
  is a `/etc/ModemManager/fcc-unlock.d/<vid>:<pid>` symlink, so this toggle applies
  to EVERY attached device matching that model — two identical dongles cannot be
  separated, and no per-unit refinement exists without changing ModemManager. An
  operator who is not told that before they act will reasonably read the toggle as
  being about the modem row they opened, which it is not. The `<vid>:<pid>` is
  shown for the same reason: it is the exact thing the toggle acts on.

  It renders DISABLED-WITH-A-REASON rather than hidden whenever the operator can
  do something about it (the device gate is off), and hides only when neither this
  build nor this hardware can act — see `modem-fcc-unlock.ts` for the ordering.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { FccUnlockState, SupportClaimState } from '@ceraui/rpc/schemas';

import { Label } from '$lib/components/ui/label';
import { Switch } from '$lib/components/ui/switch';

import { fccUnlockView } from './modem-fcc-unlock';

interface Props {
	claim: SupportClaimState | undefined;
	state: FccUnlockState | undefined;
	busy?: boolean;
	/** Rendered verbatim beneath the control; already a localized string. */
	failure?: string | undefined;
	onToggle: (enabled: boolean) => void;
}

let { claim, state, busy = false, failure, onToggle }: Props = $props();

const view = $derived(fccUnlockView(claim, state));
</script>

{#if view.kind !== 'hidden'}
	<section class="space-y-2" data-testid="modem-fcc-unlock">
		<div class="flex items-start justify-between gap-3">
			<div class="space-y-1">
				<Label for="modem-fcc-unlock-toggle">{m['network.modem.fccUnlock.title']()}</Label>
				<p class="text-muted-foreground text-xs">
					{m['network.modem.fccUnlock.description']()}
				</p>
			</div>
			{#if view.kind === 'toggle'}
				<Switch
					id="modem-fcc-unlock-toggle"
					data-testid="modem-fcc-unlock-toggle"
					checked={view.enabled}
					disabled={busy}
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
		{:else}
			<p class="text-muted-foreground text-xs" data-testid="modem-fcc-unlock-blocked">
				{resolveMessageKey(view.reasonKey)}
			</p>
		{/if}

		{#if failure}
			<p class="text-status-warning text-xs" data-testid="modem-fcc-unlock-error">{failure}</p>
		{/if}
	</section>
{/if}
