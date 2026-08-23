<!--
  ModemLockSection.svelte — the dongle login, in OUR interface.

  A router-mode dongle's own web interface is the only thing that can report or
  change its settings, and some units gate it behind a login. Until now the only
  answer CeraUI had was "go and use the vendor's page" — which is still offered
  below this section as a SECONDARY affordance, and is no longer the primary
  one: an operator types the password here, and watches the dongle's capability
  and control blocks appear.

  ── `open` IS THE COMMON CASE, AND IT GETS NO PROMPT ────────────────────────

  Every dialect on this bench answered unauthenticated, so most fleet devices
  have no password at all. A password field at one of them is exactly the
  dishonesty this effort exists to remove, so the entry is gated on
  `offersEntryFor` rather than rendered and disabled: at `open` this section is
  at most a status line. The same rule withholds it at `unlocked` (nothing to
  ask for), at `locked-out` (see below), and at a `locked` row carrying
  `unsupported-profile` — where a password would never be sent to the device at
  all, so offering the field invites an operator to blame their own typing for a
  limitation of this build.

  ── THREE FAILURE CAUSES, THREE MESSAGES ───────────────────────────────────

  Wrong password, unsupported firmware profile, and device lockout call for
  three different actions — retype it, stop and use the vendor's page, wait — so
  each has its own sentence. `modem-lock.ts` owns which one, as a table over the
  wire vocabulary rather than as branches here.

  ── `locked-out` RENDERS THE WAIT, NOT A RETRY ─────────────────────────────

  Every dialect here counts a failed login toward a window the operator cannot
  clear, so a retry button during a lockout spends the attempts that would have
  let them fix a typo. There is no entry, no submit and no retry — only the
  device's own remaining window, from `lock_detail.lockout_until`, or an honest
  "it did not say" when the device named none.

  "Forget stored login" DOES remain there, and it is deliberately not a retry:
  clearing performs ZERO device requests, and during a lockout it is the one
  useful thing an operator can do, because it stops the rejected credential from
  being presented again on the next cycle.

  ── THE CREDENTIAL IS HELD BY THE MOUNT, AND NOTHING ELSE ──────────────────

  The password lives in this component's own `$state` — never a store, never a
  URL, never `localStorage`, never a `$persist`. `AppDialog` renders children
  only while open, so closing the dialog drops it: the retention bound is the
  mount rather than a cleanup somebody has to remember. It is additionally
  cleared BEFORE the await (the `ModemUssdSection` rule), so it is out of the
  component the instant it is dispatched and can never be echoed back into a
  heading, an outcome band or a retry affordance. There is no reveal toggle and
  no autofill: the field is `type="password"` with `autocomplete="off"`
  throughout.

  ── THE LADDER IS `CapabilitySection`'s, NOT THIS FILE'S ───────────────────

  It answers `absent` (a device with no admin-auth surface renders ZERO nodes —
  every MM-managed modem in the roster) and `available`, and never `blocked`:
  the controls here ARE the children, and `blocked` suppresses children, so a
  refusal rendered that way would take the login form off screen at exactly the
  moment the operator needs to read why. That is the documented third pattern.
-->
<script lang="ts">
import { m, resolveMessageKey as t } from '@ceraui/i18n/svelte';
import type { ModemCredentialsOutput } from '@ceraui/rpc/schemas';
import { KeyRound, Loader2, LockKeyhole } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import {
	lockErrorKey,
	lockoutRemainingMinutes,
	type LockView,
} from '$lib/modem/lock-state';
import { type MutationOutcome, mutationOutcome } from '$lib/modem/mutation-outcome';
import { CapabilitySection, type CapabilityView } from '$lib/modem/sections';
import { rpc } from '$lib/rpc';

interface Props {
	/** The device selector all three credential procedures take. */
	deviceId: string;
	/** The resolved lock, or `undefined` when this device has no login surface. */
	lock: LockView | undefined;
}

let { deviceId, lock }: Props = $props();

/**
 * The operator's typed credential. LOCAL, cleared before every dispatch, and
 * dropped with the mount — see the header. Nothing else in this app may hold it.
 */
let password = $state('');
let username = $state('');
let busy = $state(false);
let outcome = $state<MutationOutcome | undefined>(undefined);
let now = $state(Date.now());

/**
 * A dialog re-pointed at a different modem while open must not carry the
 * previous device's typed password — or its outcome — onto the new one.
 */
let lastScope: string | undefined;
$effect(() => {
	if (lastScope === deviceId) return;
	const first = lastScope === undefined;
	lastScope = deviceId;
	if (first) return;
	password = '';
	username = '';
	outcome = undefined;
});

/*
  The lockout wait is a COUNTDOWN, so it needs a clock — but only while a
  lockout is actually on screen. A tick outside that window would be a timer
  running for the whole session to render nothing.
*/
$effect(() => {
	if (lock?.state !== 'locked-out') return;
	const timer = setInterval(() => {
		now = Date.now();
	}, 30_000);
	return () => clearInterval(timer);
});

const view = $derived<CapabilityView>(
	lock === undefined ? { mode: 'absent' } : { mode: 'available' },
);
const waitMinutes = $derived(
	lock?.state === 'locked-out'
		? lockoutRemainingMinutes(lock.lockoutUntil, now)
		: undefined,
);
const canSubmit = $derived(
	!busy && lock?.offersEntry === true && password.length > 0,
);

function refuse(result: ModemCredentialsOutput): void {
	outcome = mutationOutcome('refused', t(lockErrorKey(result.error)));
}

/**
 * Store the credential, then present it EXACTLY ONCE.
 *
 * Two procedures because the device separates them: `setCredentials` performs
 * zero device requests (so it can never itself spend an attempt), and
 * `verifyCredentials` is the one bounded attempt. The unlock is a CAPABILITY
 * EXPANSION rather than a private fact because the device re-broadcasts the
 * roster afterwards — the withheld capability and control blocks arrive through
 * the same `modems` surface they always rode, and this dialog renders them
 * through the same uniform sections as everything else.
 */
async function unlock(): Promise<void> {
	if (!canSubmit) return;
	// Cleared BEFORE the await. The captured values are the only copies left, and
	// they are function-local, so nothing survives the dispatch.
	const credential = { username, password };
	password = '';
	username = '';
	busy = true;
	outcome = undefined;
	try {
		const stored = await rpc.modems.setCredentials({
			device: deviceId,
			...credential,
		});
		if (!stored.success) {
			refuse(stored);
			return;
		}
		const verified = await rpc.modems.verifyCredentials({ device: deviceId });
		outcome = verified.success
			? mutationOutcome(
					'applied',
					m['network.routerCellular.lock.outcome.unlocked'](),
				)
			: mutationOutcome('refused', t(lockErrorKey(verified.error)));
	} catch {
		outcome = mutationOutcome('refused', t(lockErrorKey(undefined)));
	} finally {
		busy = false;
	}
}

/** Remove the stored login. Zero device requests, so it is never a retry. */
async function forget(): Promise<void> {
	if (busy) return;
	busy = true;
	outcome = undefined;
	try {
		const result = await rpc.modems.clearCredentials({ device: deviceId });
		outcome = result.success
			? mutationOutcome(
					'applied',
					m['network.routerCellular.lock.outcome.cleared'](),
				)
			: mutationOutcome('refused', t(lockErrorKey(result.error)));
	} catch {
		outcome = mutationOutcome('refused', t(lockErrorKey(undefined)));
	} finally {
		busy = false;
	}
}
</script>

<CapabilitySection
	name="dongle-lock"
	{view}
	{busy}
	{outcome}
	class="space-y-3 rounded-lg border p-3"
	icon={LockKeyhole}
	title={m['network.routerCellular.lock.title']()}
	description={m['network.routerCellular.lock.description']()}
>
	{#if lock}
		<div class="space-y-3" data-testid="dongle-lock-body" data-lock-state={lock.state}>
			<!--
			  THE one sentence for this situation. The three failure causes take the
			  warning register; `open`/`locked`/`unlocked` are ordinary readings and
			  must not be dressed as faults. Colour is reinforcement — every state
			  prints its own words, and `data-lock-state` above makes the six
			  distinguishable to a gate as well as to a reader.
			-->
			<p
				class={lock.isFailure ? 'text-status-warning text-xs' : 'text-muted-foreground text-xs'}
				data-testid="dongle-lock-message"
				role="status"
			>
				{t(lock.messageKey)}
			</p>

			{#if lock.state === 'locked-out'}
				<!--
				  THE WAIT, never a retry. The device's own window when it named one,
				  and an honest "it did not say" when it did not — inventing an
				  expiry from this host's clock would be a claim about a counter only
				  the dongle can see.
				-->
				<p class="text-muted-foreground text-xs" data-testid="dongle-lock-wait">
					{waitMinutes === undefined
						? m['network.routerCellular.lock.waitUnknown']()
						: m['network.routerCellular.lock.wait']({ minutes: waitMinutes })}
				</p>
			{/if}

			{#if lock.credentialConfigured}
				<p class="text-muted-foreground/80 text-xs" data-testid="dongle-lock-configured">
					{m['network.routerCellular.lock.configured']()}
				</p>
			{/if}

			{#if lock.offersEntry}
				<div class="space-y-2" data-testid="dongle-lock-form">
					<div class="space-y-1.5">
						<Label class="text-xs" for="dongle-lock-username">
							{m['network.routerCellular.lock.usernameLabel']()}
						</Label>
						<Input
							autocomplete="off"
							bind:value={username}
							class="h-9 text-sm"
							data-testid="dongle-lock-username"
							dir="ltr"
							id="dongle-lock-username"
							maxlength={64}
							spellcheck={false}
							type="text"
						/>
					</div>
					<div class="space-y-1.5">
						<Label class="text-xs" for="dongle-lock-password">
							{m['network.routerCellular.lock.passwordLabel']()}
						</Label>
						<Input
							autocomplete="off"
							bind:value={password}
							class="h-9 text-sm"
							data-testid="dongle-lock-password"
							dir="ltr"
							id="dongle-lock-password"
							maxlength={128}
							onkeydown={(event: KeyboardEvent) => {
								if (event.key === 'Enter') {
									event.preventDefault();
									void unlock();
								}
							}}
							spellcheck={false}
							type="password"
						/>
					</div>
					<Button
						class="min-h-[var(--touch-target-min)] w-fit gap-1.5"
						data-testid="dongle-lock-submit"
						disabled={!canSubmit}
						onclick={() => void unlock()}
						size="sm"
						type="button"
					>
						{#if busy}
							<Loader2 class="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
							{m['network.routerCellular.lock.submitBusy']()}
						{:else}
							<KeyRound class="size-3.5" aria-hidden="true" />
							{m['network.routerCellular.lock.submit']()}
						{/if}
					</Button>
				</div>
			{/if}

			{#if lock.offersClear}
				<Button
					class="min-h-[var(--touch-target-min)] w-fit"
					data-testid="dongle-lock-clear"
					disabled={busy}
					onclick={() => void forget()}
					size="sm"
					variant="outline"
					type="button"
				>
					{m['network.routerCellular.lock.clear']()}
				</Button>
			{/if}
		</div>
	{/if}
</CapabilitySection>
