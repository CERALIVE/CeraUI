<!--
  ModemGpsSection.svelte — the gated GPS/location control.

  THE PRIVACY FENCE IS PART OF THE CONTROL, NOT A FOOTNOTE. This surface shows
  the CURRENT position and nothing else — there is no history list, no export,
  no map link, and no "share" affordance, and none may be added. The section
  states that on screen, because an operator deciding whether to switch a
  location receiver on is entitled to know what the device does with the answer
  before they act, not after.

  NOTHING HERE IS EVER A SPINNER. Acquisition is BOUNDED, so the waiting state
  states the bound and then becomes an honest "no fix" — a modem with no antenna
  answers "no fix" forever, quite correctly, and an unbounded wait would render
  as a spinner that never resolves.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { GnssFixState, ModemGpsStatus, SupportClaimState } from '@ceraui/rpc/schemas';

import { Label } from '$lib/components/ui/label';
import { Switch } from '$lib/components/ui/switch';

import { gnssFixLine, gpsStatusLine, gpsView } from './modem-gps';

interface Props {
	claim: SupportClaimState | undefined;
	status: ModemGpsStatus | undefined;
	state: GnssFixState | undefined;
	busy?: boolean;
	/** Rendered verbatim beneath the control; already a localized string. */
	failure?: string | undefined;
	onToggle: (enabled: boolean) => void;
}

let { claim, status, state, busy = false, failure, onToggle }: Props = $props();

const view = $derived(gpsView(claim, status));
const line = $derived(gpsStatusLine(state));
</script>

{#if view.kind !== 'hidden'}
	<section class="space-y-2" data-testid="modem-gps">
		<div class="flex items-start justify-between gap-3">
			<div class="space-y-1">
				<Label for="modem-gps-toggle">{m['network.modem.gps.title']()}</Label>
				<p class="text-muted-foreground text-xs">
					{m['network.modem.gps.description']()}
				</p>
			</div>
			{#if view.kind === 'toggle'}
				<Switch
					id="modem-gps-toggle"
					data-testid="modem-gps-toggle"
					checked={view.enabled}
					disabled={busy}
					onCheckedChange={(next) => onToggle(next)}
				/>
			{/if}
		</div>

		{#if view.kind === 'blocked'}
			<p class="text-muted-foreground text-xs" data-testid="modem-gps-blocked">
				{resolveMessageKey(view.reasonKey)}
			</p>
		{:else}
			<!--
			  The privacy statement renders whenever the control does, never behind a
			  `title` — the shipped kiosk touchscreen cannot hover to reveal one.
			-->
			<p class="text-muted-foreground text-xs" data-testid="modem-gps-privacy">
				{m['network.modem.gps.privacyNotice']()}
			</p>

			<div class="text-xs" data-testid="modem-gps-state" data-gps-state={line.kind}>
				{#if line.kind === 'off'}
					<span class="text-muted-foreground">{m['network.modem.gps.state.off']()}</span>
				{:else if line.kind === 'acquiring'}
					<span class="text-muted-foreground" data-testid="modem-gps-acquiring">
						{m['network.modem.gps.state.acquiring']()}
					</span>
				{:else if line.kind === 'no-fix'}
					<span class="text-status-warning" data-testid="modem-gps-no-fix">
						{resolveMessageKey(line.reasonKey)}
					</span>
				{:else if line.kind === 'fix'}
					<span
						class="font-mono tabular-nums"
						dir="ltr"
						data-testid="modem-gps-fix"
					>{gnssFixLine(line.fix)}</span>
				{:else}
					<span class="text-status-warning" data-testid="modem-gps-unavailable">
						{m['network.modem.gps.state.unavailable']()}
					</span>
				{/if}
			</div>
		{/if}

		{#if failure}
			<p class="text-status-warning text-xs" data-testid="modem-gps-error">{failure}</p>
		{/if}
	</section>
{/if}
