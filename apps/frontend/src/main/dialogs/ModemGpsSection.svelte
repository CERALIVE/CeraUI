<!--
  ModemGpsSection.svelte — the gated GPS/location control.

  THE PRIVACY FENCE IS PART OF THE CONTROL, NOT A FOOTNOTE. This surface shows
  the CURRENT position and nothing else — there is no history list, no export,
  no map link, and no "share" affordance, and none may be added. The section
  states that on screen, because an operator deciding whether to switch a
  location receiver on is entitled to know what the device does with the answer
  before they act, not after.

  IT OWNS ITS OWN STATE AND ITS OWN RPC, and that is the fence too — the same
  reason `ModemUssdSection` does. A host dialog is mounted permanently by the
  view behind it, so a coordinate parked in the host outlives every close;
  `AppDialog` renders children only while open, so holding the fix HERE makes the
  retention bound the mount rather than a cleanup somebody has to remember. It is
  also what makes the section mountable by any modem family without a second copy
  of the load/toggle/expiry rules — see the mount in `RouterDongleDialog`.

  NOTHING HERE IS EVER A SPINNER. Acquisition is BOUNDED twice: the device's own
  state machine expires the wait, and — because that machine is advanced only by
  a read, so a modem that stops answering would leave it on `acquiring` forever —
  this surface re-states the same declared window at render time. A modem with no
  antenna answers "no fix", quite correctly, and it answers it in finite time.

  THE FOUR-STATE LADDER IS `CapabilitySection`'s, NOT THIS FILE'S. `gpsView`
  still decides WHICH state this modem is in — that rule is GPS-specific and
  stays here — and the shared primitive owns what each state renders: zero nodes
  at `absent`, a `role="status"` diagnostic and NO control at `unknown` (CT-3/CT-4),
  the control DISABLED with its reason ON SCREEN at `blocked` (CT-2), and the
  live control plus these readings at `available`. Every test id is unchanged:
  `modem-gps`, `-toggle`, `-reason`, `-unknown`, and the outcome band's own.
-->
<script lang="ts">
import { m, resolveMessageKey, resolveMessageKey as t } from '@ceraui/i18n/svelte';
import type { GnssFixState, ModemGpsStatus, SupportClaimState } from '@ceraui/rpc/schemas';

import { Switch } from '$lib/components/ui/switch';
import { loadWithinBound } from '$lib/modem/async-surface';
import { type MutationOutcome, mutationOutcome } from '$lib/modem/mutation-outcome';
import { CapabilitySection, gatedSurfaceCapability } from '$lib/modem/sections';
import { rpc } from '$lib/rpc';

import {
	gnssAcquireExpired,
	gnssAcquirePollDelay,
	gnssAcquireWindow,
	gnssFixLine,
	gpsErrorKey,
	gpsStatusLine,
	gpsView,
} from './modem-gps';

interface Props {
	claim: SupportClaimState | undefined;
	/** The device selector both GPS procedures take. */
	deviceId: string;
}

let { claim, deviceId }: Props = $props();

let status = $state<ModemGpsStatus | undefined>(undefined);
let fixState = $state<GnssFixState | undefined>(undefined);
let busy = $state(false);
/**
 * The last terminal outcome of a toggle — SUCCESS INCLUDED. A failure-only
 * string meant a screen-reader operator who turned the receiver on learned
 * nothing at all: the toggle they had just moved simply stayed where it was and
 * no text appeared anywhere. §8 LR-5 requires the terminal outcome either way.
 */
let outcome = $state<MutationOutcome | undefined>(undefined);
let acquireObservedAt = $state(0);
let acquireSince = $state<number | undefined>(undefined);
let now = $state(Date.now());

const view = $derived(gpsView(claim, status));
const acquireWindow = $derived(gnssAcquireWindow(fixState, acquireObservedAt));
const acquireExpired = $derived(gnssAcquireExpired(acquireWindow, now));
const line = $derived(gpsStatusLine(fixState, acquireExpired));
const capability = $derived(gatedSurfaceCapability(view));
/**
 * The read gate below, and it is resolved from the CLAIM ALONE — that second
 * argument is `undefined` on purpose. `absent` is the ladder's first line and
 * nothing under it moves that line, so a status-free call answers the same
 * question with a `===`-stable string.
 *
 * Reading `capability` there instead would make the effect a subscriber of
 * `status`, which `read()` WRITES: every successful read would re-derive the
 * view, re-fire the effect and re-issue itself, at RPC-round-trip cadence.
 */
const readGate = $derived(gpsView(claim, undefined).kind);

function adoptState(next: GnssFixState | undefined): void {
	if (next?.kind === 'acquiring') {
		if (acquireSince !== next.since) {
			acquireSince = next.since;
			acquireObservedAt = Date.now();
		}
	} else {
		acquireSince = undefined;
	}
	fixState = next;
	now = Date.now();
}

async function read(): Promise<void> {
	const requested = deviceId;
	// The read is BOUNDED, and its expiry is the same non-verdict as a failure.
	// Without the bound the acquisition re-read below could be issued against a
	// modem that never answers, and each one would sit in flight for the
	// transport's own 30 s while the section reported an active wait.
	const outcome = await loadWithinBound('getGps', () =>
		rpc.modems.getGps({ device: deviceId }),
	);
	// A close/reopen onto another modem while this was in flight must not adopt
	// the previous device's position.
	if (requested !== deviceId) return;
	// A failed or expired read claims nothing about the device — the ladder
	// already withholds the control below `capable`, and an absent `status`
	// renders the `notReported` reason, so neither may invent a verdict here.
	if (outcome.phase !== 'loaded' || !outcome.value.success) return;
	status = outcome.value.status;
	adoptState(outcome.value.state);
}

async function toggle(enabled: boolean): Promise<void> {
	busy = true;
	outcome = undefined;
	try {
		const result = await rpc.modems.setGps({ device: deviceId, enabled });
		if (result.success) {
			status = result.status;
			adoptState(result.state);
			outcome = mutationOutcome(
				'applied',
				enabled
					? m['network.modem.gps.outcome.enabled']()
					: m['network.modem.gps.outcome.disabled'](),
			);
		} else {
			outcome = mutationOutcome(
				'refused',
				t(gpsErrorKey(result.error ?? result.mutationRefusal ?? 'read_failed')),
			);
		}
	} catch {
		outcome = mutationOutcome('refused', t(gpsErrorKey('read_failed')));
	} finally {
		busy = false;
	}
}

/*
  The read is issued for every claim that renders ANYTHING, and that is the
  point: the capability evidence each GPS mutation gates on is process-local and
  resets on boot, so a surface that waited for the claim to say `capable` could
  never make it say so — the operator would meet a section that is permanently
  unproven. The one state it skips is `absent`, which renders zero nodes: a
  surface that says nothing asks nothing. It tracks `deviceId`, so pointing the
  host at another modem re-reads.

  It asks the RESOLVED ladder, never the raw claim. Restating "undefined or
  `unavailable`" here made this effect a second, silent copy of the ladder's
  first line — free to keep reading a module the section had stopped rendering.
  It asks `readGate` rather than `capability` for the reason stated there.
*/
$effect(() => {
	if (readGate === 'absent') return;
	void read();
});

/*
  Re-armed once per read rather than a standing interval, so the timer that
  survives to fire IS "the wait is still live". It arms only while acquiring and
  never past the declared window, so the poll cannot outlive the bound it serves.
*/
$effect(() => {
	const delay = gnssAcquirePollDelay(acquireWindow, Date.now());
	if (delay === undefined) return;
	const timer = setTimeout(() => {
		now = Date.now();
		void read();
	}, delay);
	return () => clearTimeout(timer);
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
			onCheckedChange={(next) => void toggle(next)}
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
