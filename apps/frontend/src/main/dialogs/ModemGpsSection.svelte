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

  THE FOUR-STATE LADDER IS `CapabilitySection`'s, NOT THIS FILE'S. This section
  and `ModemFccUnlockSection` each wrote it out by hand and each got it right,
  which is precisely how a third copy eventually gets it wrong. `gpsView` still
  decides WHICH state this modem is in — that rule is GPS-specific and stays
  here — and the shared primitive owns what each state renders: zero nodes at
  `absent`, a `role="status"` diagnostic and NO control at `unknown` (CT-3/CT-4),
  the control DISABLED with its reason ON SCREEN at `blocked` (CT-2), and the
  live control plus these readings at `available`. Every test id is unchanged:
  `modem-gps`, `-toggle`, `-reason`, `-unknown`, and the outcome band's own.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { GnssFixState, ModemGpsStatus, SupportClaimState } from '@ceraui/rpc/schemas';

import { Switch } from '$lib/components/ui/switch';
import type { MutationOutcome } from '$lib/modem/mutation-outcome';
import { CapabilitySection, type CapabilityView } from '$lib/modem/sections';

import { gnssFixLine, gpsStatusLine, gpsView } from './modem-gps';

interface Props {
	claim: SupportClaimState | undefined;
	status: ModemGpsStatus | undefined;
	state: GnssFixState | undefined;
	busy?: boolean;
	/**
	 * The last terminal outcome of a toggle — SUCCESS INCLUDED.
	 *
	 * It replaced a failure-only string, which meant a screen-reader operator who
	 * turned the receiver on learned nothing at all: the toggle they had just
	 * moved simply stayed where it was and no text appeared anywhere. §8 LR-5
	 * requires the terminal outcome of an in-flight operation either way.
	 */
	outcome?: MutationOutcome | undefined;
	onToggle: (enabled: boolean) => void;
}

let { claim, status, state, busy = false, outcome, onToggle }: Props = $props();

const view = $derived(gpsView(claim, status));
const line = $derived(gpsStatusLine(state));
const capability = $derived.by((): CapabilityView => {
	switch (view.kind) {
		case 'absent':
			return { mode: 'absent' };
		case 'unknown':
			return { mode: 'unknown', reasonKey: view.reasonKey };
		case 'blocked':
			return { mode: 'blocked', reasonKey: view.reasonKey };
		case 'toggle':
			return { mode: 'available' };
	}
});
</script>

<CapabilitySection
	name="modem-gps"
	view={capability}
	{busy}
	{outcome}
	controlId="modem-gps-toggle"
	title={m['network.modem.gps.title']()}
	description={m['network.modem.gps.description']()}
>
	<!--
	  WRITTEN ONCE, RENDERED IN TWO STATES. `CapabilitySection` renders this at
	  `available` and at `blocked` with `disabled` flipped, and never at `unknown`
	  — so there is no disabled twin to keep in step by hand.
	-->
	{#snippet control(ctx)}
		<Switch
			id="modem-gps-toggle"
			data-testid="modem-gps-toggle"
			checked={view.kind === 'toggle' && view.enabled}
			disabled={ctx.disabled}
			aria-label={ctx.reason}
			aria-describedby={ctx.reasonId}
			title={ctx.reason}
			onCheckedChange={(next) => onToggle(next)}
		/>
	{/snippet}

	<!--
	  The privacy statement renders whenever the control is LIVE, never behind a
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
</CapabilitySection>
