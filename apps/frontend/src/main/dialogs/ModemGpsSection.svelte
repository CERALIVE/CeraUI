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

  It renders one of FOUR states (`DESIGN.md` §1), and the machine-readable
  `data-capability-state` is what makes them distinguishable to a gate rather
  than only to a reader:

    absent    — nothing at all, not one node (CT-1).
    unknown   — a `role="status"` diagnostic and NO control (CT-3/CT-4): below
                `capable` nobody has shown there is a receiver to switch on, and
                a disabled switch would claim there is.
    blocked   — the switch, DISABLED, with its reason ON SCREEN beside it (CT-2)
                — never a bare disabled control, and never a reason that lives
                only in a `title` the kiosk touchscreen cannot hover to reveal.
    available — the switch, live.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { GnssFixState, ModemGpsStatus, SupportClaimState } from '@ceraui/rpc/schemas';

import MutationOutcomeBand from '$lib/components/custom/MutationOutcomeBand.svelte';
import { Label } from '$lib/components/ui/label';
import { Switch } from '$lib/components/ui/switch';
import type { MutationOutcome } from '$lib/modem/mutation-outcome';

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
const capabilityState = $derived(
	view.kind === 'toggle' ? 'available' : view.kind,
);
const blockedReason = $derived(
	view.kind === 'blocked' ? resolveMessageKey(view.reasonKey) : undefined,
);
</script>

{#if view.kind !== 'absent'}
	<section class="space-y-2" data-testid="modem-gps" data-capability-state={capabilityState}>
		<div class="flex items-start justify-between gap-3">
			<div class="space-y-1">
				<Label for="modem-gps-toggle">{m['network.modem.gps.title']()}</Label>
				<p class="text-muted-foreground text-xs">
					{m['network.modem.gps.description']()}
				</p>
			</div>
			<!--
			  A DISABLED switch is offered only at `blocked`, where the claim is
			  already ≥ capable — CT-4's "no fake control". At `unknown` there is no
			  switch at all, disabled or otherwise.
			-->
			{#if view.kind === 'toggle' || view.kind === 'blocked'}
				<Switch
					id="modem-gps-toggle"
					data-testid="modem-gps-toggle"
					checked={view.kind === 'toggle' && view.enabled}
					disabled={busy || view.kind === 'blocked'}
					aria-label={blockedReason}
					title={blockedReason}
					onCheckedChange={(next) => onToggle(next)}
				/>
			{/if}
		</div>

		{#if view.kind === 'unknown'}
			<!--
			  Visibly distinct from BOTH the offered and the withheld renderings, and
			  announced: "we have not established this" is a different fact from
			  "this modem cannot do it", and rendering it as the latter is the one
			  substitution the capability ladder exists to prevent.
			-->
			<p
				class="text-muted-foreground text-xs"
				data-testid="modem-gps-unknown"
				data-state="unknown"
				role="status"
			>
				{resolveMessageKey(view.reasonKey)}
			</p>
		{:else if view.kind === 'blocked'}
			<p class="text-status-warning text-xs" data-testid="modem-gps-reason">
				{blockedReason}
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

		<MutationOutcomeBand name="modem-gps" {outcome} />
	</section>
{/if}
