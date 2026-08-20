<!--
  SimUnlockDialog.svelte — SIM PIN/PUK unlock prompt for a locked modem.

  Auto-opened by NetworkView when a modem reports a SIM lock. Two flows share one
  dialog:
    • PIN flow (sim_lock.required === 'sim-pin') — submits the PIN exactly once via
      the Task 22 `modems.unlockSim` RPC; maps the terminal state back to the UI:
        success      → toast + close
        wrong-pin    → inline error with remaining attempts (no resubmit)
        puk-required → hands off to the PUK flow (a PIN can no longer help)
    • PUK flow (sim_lock.required === 'sim-puk' / 'sim-puk2', or after PIN
      exhaustion) — submits the carrier PUK + a new PIN via `modems.unlockSimPuk`:
        success    → toast + close
        wrong-puk  → inline error + decremented PUK attempts counter (no resubmit)
        locked     → terminal lockout state; the SIM is permanently bricked
    • PIN2 flow (sim_lock.required === 'sim-pin2') — a SEPARATE credential, via
      `modems.unlockSimPin2`:
        success       → toast + close
        wrong-pin2    → inline error + decremented PIN2 attempts (no resubmit)
        puk2-required → terminal; only the carrier's PUK2 can restore it
        unsupported   → terminal; this modem exposes no PIN2 route
        no-pin2-lock  → close

  PIN2 IS NOT A SECOND SIM PIN, and the copy must never let the two blur. PIN1
  gates the card: unverified, the modem cannot register and there is no link.
  PIN2 gates only the Fixed-Dialling-Number list and some call-cost settings —
  ModemManager never even marks such a modem locked, because it registers,
  connects and bonds normally. An operator who reads "your SIM is locked" here
  and starts hunting for a PUK has been misled by us, not by their carrier.

  No secret is resubmitted automatically — a blind retry walks the SIM toward an
  irreversible lockout, so every attempt is an explicit user action. That matters
  more for PIN2 than for PIN1: its budget is ~3, and PUK2 is printed far less
  prominently than PUK1, so exhausting it is often unrecoverable in practice.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type {
	Modem,
	SimPin2UnlockOutput,
	SimPukUnlockOutput,
	SimUnlockOutput,
} from '@ceraui/rpc/schemas';
import { KeyRound, ListChecks, Loader2, ShieldAlert, ShieldX } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { networkConstraints } from '$lib/components/streaming/ValidationAdapter';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { rpc } from '$lib/rpc';
import { isOperationPending, osCommand } from '$lib/rpc/async-operation.svelte';
import {
	classifySimPin2Result,
	classifySimPinResult,
	classifySimPukResult,
} from '$lib/rpc/sim-unlock-outcome';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
	modem: Modem;
	deviceId: string | number;
	/**
	 * Set ONLY when this dialog was opened from inside another one — today the
	 * `ModemConfigDialog` lock band, for the non-blocking `sim-pin2`/`sim-puk2`
	 * case (todo 46's routing split). Unlocking a PIN2 is a sub-setting of that
	 * modem's settings, so leaving it must return to them rather than dropping
	 * the operator back onto the Network page having lost their place.
	 *
	 * Absent = the STANDALONE case (a blocking `sim-pin`/`sim-puk` reached from
	 * the row's own "Unlock SIM" button), which closes fully, unchanged.
	 */
	onBack?: () => void;
}

let { open = $bindable(false), modem, deviceId, onBack }: Props = $props();

// EVERY close route returns to the parent — the footer button, the header X,
// ESC, an overlay click, and the success path that closes the dialog itself.
// Hanging this off the open edge is what makes that true by construction; a
// handler on the footer button alone would leave four routes stranding the
// operator, and three of them are the ones a touchscreen actually uses.
let wasOpen = false;
$effect(() => {
	if (open) {
		wasOpen = true;
		return;
	}
	if (!wasOpen) return;
	wasOpen = false;
	onBack?.();
});

const pinMin = networkConstraints.modem.simPin.min;
const pinMax = networkConstraints.modem.simPin.max;
const pukLength = networkConstraints.modem.simPuk.length;
const pinPattern = new RegExp(`^\\d{${pinMin},${pinMax}}$`);
const pukPattern = new RegExp(`^\\d{${pukLength}}$`);

// PIN + PUK share ONE keyed op per modem — the osCommand re-entry guard enforces
// a single SIM unlock in flight at a time (a blind resubmit walks the SIM toward
// an irreversible lockout). SIM unlocks are SYNCHRONOUS (await mmcli, return the
// real terminal in the RPC body), so they dispatch with `confirmOnResolve: true`.
const simKey = $derived(`sim:${deviceId}`);
const submitting = $derived(isOperationPending(simKey));

let pin = $state('');
let errorState = $state<SimUnlockOutput['state'] | null>(null);
let remainingAttempts = $state<number | undefined>(undefined);

// PUK flow state — kept separate from the PIN flow so a hand-off preserves both.
let puk = $state('');
let newPin = $state('');
let pukErrorState = $state<SimPukUnlockOutput['error'] | null>(null);
let pukRemainingAttempts = $state<number | undefined>(undefined);

// PIN2 flow state — separate again, for the same reason: a PIN2 terminal must
// never leak into the PIN1/PUK counters an operator is reading.
let pin2 = $state('');
let pin2ErrorState = $state<SimPin2UnlockOutput['state'] | null>(null);
let pin2RemainingAttempts = $state<number | undefined>(undefined);

const pukRequired = $derived(
	errorState === 'puk-required' ||
		modem.sim_lock?.required === 'sim-puk' ||
		modem.sim_lock?.required === 'sim-puk2',
);
// PIN2 yields to the PUK branch: `sim-puk2` means PIN2's own budget is already
// spent, which is a recovery flow rather than an entry one.
const pin2Required = $derived(!pukRequired && modem.sim_lock?.required === 'sim-pin2');
// PIN2 terminals that no further entry in this dialog can resolve.
const pin2Terminal = $derived(
	pin2ErrorState === 'puk2-required' || pin2ErrorState === 'unsupported',
);
const locked = $derived(pukErrorState === 'locked');
// Zero PUK retries remaining: the next wrong PUK bricks the SIM, so the submit
// is disabled the moment a PUK-locked modem opens reporting 0 — even before the
// terminal `locked` state is reached via a submit. Derived from the existing
// SIM status field (pukRetries), never a new data source.
const pukExhausted = $derived(pukRemainingAttempts === 0);
const pinValid = $derived(pinPattern.test(pin));
const pukValid = $derived(pukPattern.test(puk));
const newPinValid = $derived(pinPattern.test(newPin));
const pukFormValid = $derived(pukValid && newPinValid);
const pin2Valid = $derived(pinPattern.test(pin2));
const dialogTitle = $derived(
	locked
		? m["network.modem.simUnlock.pukLockedTitle"]()
		: pukRequired
			? m["network.modem.simUnlock.pukTitle"]()
			: pin2Required
				? m["network.modem.simUnlock.pin2Title"]()
				: m["network.modem.simUnlock.title"](),
);
// PIN2 gets its own glyph, not the PIN1 key: a shared icon is the first thing
// that makes two different credentials look like one.
const dialogIcon = $derived(
	locked ? ShieldX : pukRequired ? ShieldAlert : pin2Required ? ListChecks : KeyRound,
);

// Re-seed from the live modem each time the dialog opens. The error/attempt
// state below is LOCAL $state, set only here (open edge) and from a submit
// result — never re-derived from a live broadcast — so a periodic `modems` push
// can never clear the inline error the operator is reading.
let prevOpen = false;
$effect(() => {
	if (open && !prevOpen) {
		pin = '';
		puk = '';
		newPin = '';
		pin2 = '';
		errorState = null;
		pukErrorState = null;
		pin2ErrorState = null;
		remainingAttempts = modem.sim_lock?.remainingAttempts;
		pukRemainingAttempts =
			modem.sim_lock?.required === 'sim-puk' || modem.sim_lock?.required === 'sim-puk2'
				? modem.sim_lock?.remainingAttempts
				: undefined;
		pin2RemainingAttempts =
			modem.sim_lock?.required === 'sim-pin2' ? modem.sim_lock?.remainingAttempts : undefined;
	}
	prevOpen = open;
});

// Apply a PIN result to the inline UI. success closes; wrong-pin/puk-required/
// no-locked-modem are handled here (no generic toast); a genuine error toast is
// owned by osCommand's failure path.
function applyPinResult(result: SimUnlockOutput) {
	const verdict = classifySimPinResult(result);
	if (verdict.ok) {
		toast.success(m["network.modem.simUnlock.success"]());
		open = false;
		return;
	}
	switch (verdict.reason) {
		case 'wrong-pin':
			errorState = 'wrong-pin';
			remainingAttempts = result.remainingAttempts;
			pin = '';
			break;
		case 'puk-required':
			errorState = 'puk-required';
			pin = '';
			break;
		case 'no-locked-modem':
			open = false;
			break;
		default:
			// Generic failure: osCommand already toasted via failMessage.
			errorState = 'error';
	}
}

function applyPukResult(result: SimPukUnlockOutput) {
	const verdict = classifySimPukResult(result);
	if (verdict.ok) {
		toast.success(m["network.modem.simUnlock.pukSuccess"]());
		open = false;
		return;
	}
	switch (verdict.reason) {
		case 'wrong-puk':
			pukErrorState = 'wrong-puk';
			pukRemainingAttempts = result.remainingAttempts;
			puk = '';
			newPin = '';
			break;
		case 'locked':
			pukErrorState = 'locked';
			pukRemainingAttempts = 0;
			puk = '';
			newPin = '';
			break;
		case 'no-locked-modem':
			open = false;
			break;
		default:
			pukErrorState = 'error';
	}
}

function applyPin2Result(result: SimPin2UnlockOutput) {
	const verdict = classifySimPin2Result(result);
	if (verdict.ok) {
		toast.success(m["network.modem.simUnlock.pin2Success"]());
		open = false;
		return;
	}
	switch (verdict.reason) {
		case 'wrong-pin2':
			pin2ErrorState = 'wrong-pin2';
			pin2RemainingAttempts = result.remainingAttempts;
			pin2 = '';
			break;
		case 'puk2-required':
			pin2ErrorState = 'puk2-required';
			pin2RemainingAttempts = 0;
			pin2 = '';
			break;
		case 'unsupported':
			pin2ErrorState = 'unsupported';
			pin2 = '';
			break;
		case 'no-pin2-lock':
			open = false;
			break;
		default:
			pin2ErrorState = 'error';
	}
}

async function handleSubmitPin2() {
	if (!pin2Valid || submitting || pin2Terminal) return;
	await osCommand({
		key: simKey,
		rpc: () => rpc.modems.unlockSimPin2({ modemPath: String(deviceId), pin2 }),
		confirmOnResolve: true,
		classify: (r) => {
			const v = classifySimPin2Result(r);
			return v.reason === 'error' ? { ok: false, reason: 'error' } : { ok: true };
		},
		failMessage: () => m["network.os.operationFailed"](),
		onResult: (r) => applyPin2Result(r),
	});
}

function handlePin2Keydown(event: KeyboardEvent) {
	if (event.key === 'Enter') {
		event.preventDefault();
		handleSubmitPin2();
	}
}

async function handleSubmit() {
	// `pin2Required` is a hard guard, not a formality: submitting a PIN2 code
	// through the PIN1 procedure would spend a PIN1 attempt on a credential that
	// can never satisfy it, walking a working SIM toward a PUK1 lockout.
	if (!pinValid || submitting || pukRequired || pin2Required) return;
	await osCommand({
		key: simKey,
		rpc: () => rpc.modems.unlockSim({ modemPath: String(deviceId), pin }),
		confirmOnResolve: true,
		// Only a genuine `error` surfaces osCommand's failure toast/phase; every
		// other non-ok terminal (wrong-pin / puk-required / no-locked-modem) is
		// handled inline by applyPinResult, so report it as ok to suppress the toast.
		classify: (r) => {
			const v = classifySimPinResult(r);
			return v.reason === 'error' ? { ok: false, reason: 'error' } : { ok: true };
		},
		failMessage: () => m["network.os.operationFailed"](),
		onResult: (r) => applyPinResult(r),
	});
}

async function handleSubmitPuk() {
	if (!pukFormValid || submitting || locked || pukExhausted) return;
	await osCommand({
		key: simKey,
		rpc: () => rpc.modems.unlockSimPuk({ modemPath: String(deviceId), puk, newPin }),
		confirmOnResolve: true,
		classify: (r) => {
			const v = classifySimPukResult(r);
			return v.reason === 'error' ? { ok: false, reason: 'error' } : { ok: true };
		},
		failMessage: () => m["network.os.operationFailed"](),
		onResult: (r) => applyPukResult(r),
	});
}

function handlePinKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter') {
		event.preventDefault();
		handleSubmit();
	}
}

function handlePukKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter') {
		event.preventDefault();
		handleSubmitPuk();
	}
}
</script>

<AppDialog icon={dialogIcon} title={dialogTitle} bind:open>
	<div class="space-y-4">
		{#if locked}
			<!-- Terminal lockout: PUK attempts exhausted, SIM is bricked -->
			<div
				class="border-status-error/40 bg-status-error/10 flex items-start gap-3 rounded-lg border p-3"
				data-testid="sim-puk-locked"
				role="alert"
			>
				<ShieldX class="text-status-error mt-0.5 size-5 shrink-0" aria-hidden="true" />
				<div class="min-w-0">
					<p class="text-sm font-semibold">{m["network.modem.simUnlock.pukLockedTitle"]()}</p>
					<p class="text-muted-foreground mt-0.5 text-sm leading-relaxed">
						{m["network.modem.simUnlock.pukLocked"]()}
					</p>
				</div>
			</div>
		{:else if pukRequired}
			<!-- PUK recovery: enter the carrier PUK and program a new PIN -->
			<div
				class="border-status-error/40 bg-status-error/10 flex items-start gap-3 rounded-lg border p-3"
				data-testid="sim-puk-required"
				role="alert"
			>
				<ShieldAlert class="text-status-error mt-0.5 size-5 shrink-0" aria-hidden="true" />
				<div class="min-w-0">
					<p class="text-sm font-semibold">{m["network.modem.simUnlock.pukTitle"]()}</p>
					<p class="text-muted-foreground mt-0.5 text-sm leading-relaxed">
						{m["network.modem.simUnlock.pukRequired"]()}
					</p>
				</div>
			</div>

			{#if pukRemainingAttempts !== undefined}
				<div
					class="border-border/60 bg-muted/30 flex items-center justify-between rounded-lg border px-3 py-2"
					data-testid="sim-puk-attempts"
				>
					<span class="text-muted-foreground text-xs">
						{m["network.modem.simUnlock.pukAttemptsLabel"]()}
					</span>
					<span
						class={cn(
							'font-mono text-sm tabular-nums',
							pukRemainingAttempts <= 2 ? 'text-status-error' : 'text-foreground',
						)}
					>
						{pukRemainingAttempts}
					</span>
				</div>
			{/if}

			<div class="space-y-1.5">
				<Label class="text-muted-foreground text-xs" for="sim-puk">
					{m["network.modem.simUnlock.pukLabel"]()}
				</Label>
				<Input
					id="sim-puk"
					class={cn(
						'h-12 text-center text-lg tracking-[0.3em]',
						pukErrorState === 'wrong-puk' &&
							'border-status-error focus-visible:ring-status-error',
					)}
					aria-invalid={pukErrorState === 'wrong-puk'}
					autocomplete="off"
					data-testid="sim-puk-input"
					inputmode="numeric"
					maxlength={pukLength}
					onkeydown={handlePukKeydown}
					placeholder={m["network.modem.simUnlock.pukPlaceholder"]()}
					type="password"
					bind:value={puk}
				/>
			</div>

			<div class="space-y-1.5">
				<Label class="text-muted-foreground text-xs" for="sim-new-pin">
					{m["network.modem.simUnlock.newPinLabel"]()}
				</Label>
				<Input
					id="sim-new-pin"
					class="h-12 text-center text-lg tracking-[0.4em]"
					autocomplete="off"
					data-testid="sim-puk-newpin-input"
					inputmode="numeric"
					maxlength={pinMax}
					onkeydown={handlePukKeydown}
					placeholder={m["network.modem.simUnlock.newPinPlaceholder"]()}
					type="password"
					bind:value={newPin}
				/>
				{#if pukErrorState === 'wrong-puk'}
					<p class="text-status-error text-sm" data-testid="sim-puk-error" role="alert">
						{m["network.modem.simUnlock.wrongPuk"]()}
					</p>
				{:else}
					<p class="text-muted-foreground text-xs">
						{m["network.modem.simUnlock.pukLengthHint"]({ length: pukLength })}
					</p>
				{/if}
			</div>
		{:else if pin2Required}
			<!--
			  The PIN2 branch leads with what PIN2 IS and what it does NOT do,
			  because the row that opened this dialog says "SIM locked" and an
			  operator's default reading of that is "my data is blocked".
			-->
			<div
				class="border-status-info/40 bg-status-info/10 flex items-start gap-3 rounded-lg border p-3"
				data-testid="sim-pin2-explainer"
				role="status"
			>
				<ListChecks class="text-status-info mt-0.5 size-5 shrink-0" aria-hidden="true" />
				<div class="min-w-0">
					<p class="text-sm font-semibold">{m["network.modem.simUnlock.pin2Title"]()}</p>
					<p class="text-muted-foreground mt-0.5 text-sm leading-relaxed">
						{m["network.modem.simUnlock.pin2Description"]()}
					</p>
					<p class="text-muted-foreground mt-1.5 text-sm leading-relaxed">
						{m["network.modem.simUnlock.pin2ServiceUnaffected"]()}
					</p>
				</div>
			</div>

			{#if pin2ErrorState === 'unsupported'}
				<div
					class="border-border/60 bg-muted/30 flex items-start gap-3 rounded-lg border p-3"
					data-testid="sim-pin2-unsupported"
					role="status"
				>
					<ShieldAlert class="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
					<p class="text-muted-foreground min-w-0 text-sm leading-relaxed">
						{m["network.modem.simUnlock.pin2Unsupported"]()}
					</p>
				</div>
			{:else if pin2ErrorState === 'puk2-required'}
				<div
					class="border-status-warning/40 bg-status-warning/10 flex items-start gap-3 rounded-lg border p-3"
					data-testid="sim-pin2-puk2-required"
					role="alert"
				>
					<ShieldAlert class="text-status-warning mt-0.5 size-5 shrink-0" aria-hidden="true" />
					<div class="min-w-0">
						<p class="text-sm font-semibold">
							{m["network.modem.simUnlock.pin2Puk2Title"]()}
						</p>
						<p class="text-muted-foreground mt-0.5 text-sm leading-relaxed">
							{m["network.modem.simUnlock.pin2Puk2Required"]()}
						</p>
					</div>
				</div>
			{:else}
				{#if pin2RemainingAttempts !== undefined}
					<div
						class="border-border/60 bg-muted/30 flex items-center justify-between rounded-lg border px-3 py-2"
						data-testid="sim-pin2-attempts"
					>
						<span class="text-muted-foreground text-xs">
							{m["network.modem.simUnlock.pin2AttemptsLabel"]()}
						</span>
						<span
							class={cn(
								'font-mono text-sm tabular-nums',
								pin2RemainingAttempts <= 1 ? 'text-status-error' : 'text-foreground',
							)}
						>
							{pin2RemainingAttempts}
						</span>
					</div>
				{/if}

				<div class="space-y-1.5">
					<Label class="text-muted-foreground text-xs" for="sim-pin2">
						{m["network.modem.simUnlock.pin2Label"]()}
					</Label>
					<Input
						id="sim-pin2"
						class={cn(
							'h-12 text-center text-lg tracking-[0.4em]',
							pin2ErrorState === 'wrong-pin2' &&
								'border-status-error focus-visible:ring-status-error',
						)}
						aria-invalid={pin2ErrorState === 'wrong-pin2'}
						autocomplete="off"
						data-testid="sim-pin2-input"
						inputmode="numeric"
						maxlength={pinMax}
						onkeydown={handlePin2Keydown}
						placeholder={m["network.modem.simUnlock.pin2Placeholder"]()}
						type="password"
						bind:value={pin2}
					/>
					{#if pin2ErrorState === 'wrong-pin2'}
						<p class="text-status-error text-sm" data-testid="sim-pin2-error" role="alert">
							{pin2RemainingAttempts === undefined
								? m["network.modem.simUnlock.wrongPin2"]()
								: m["network.modem.simUnlock.pin2AttemptsRemaining"]({
										count: pin2RemainingAttempts,
									})}
						</p>
					{:else}
						<p class="text-muted-foreground text-xs">
							{m["network.modem.simUnlock.lengthHint"]({ min: pinMin, max: pinMax })}
						</p>
					{/if}
				</div>
			{/if}
		{:else}
			<p class="text-muted-foreground text-sm leading-relaxed">
				{m["network.modem.simUnlock.description"]()}
			</p>

			<div class="space-y-1.5">
				<Label class="text-muted-foreground text-xs" for="sim-pin">
					{m["network.modem.simUnlock.pinLabel"]()}
				</Label>
				<Input
					id="sim-pin"
					class={cn(
						'h-12 text-center text-lg tracking-[0.4em]',
						errorState === 'wrong-pin' && 'border-status-error focus-visible:ring-status-error',
					)}
					aria-invalid={errorState === 'wrong-pin'}
					autocomplete="off"
					data-testid="sim-pin-input"
					inputmode="numeric"
					maxlength={pinMax}
					onkeydown={handlePinKeydown}
					placeholder={m["network.modem.simUnlock.pinPlaceholder"]()}
					type="password"
					bind:value={pin}
				/>
				{#if errorState === 'wrong-pin'}
					<p class="text-status-error text-sm" data-testid="sim-pin-error" role="alert">
						{remainingAttempts === undefined
							? m["network.modem.simUnlock.wrongPin"]()
							: m["network.modem.simUnlock.attemptsRemaining"]({ count: remainingAttempts })}
					</p>
				{:else}
					<p class="text-muted-foreground text-xs">
						{m["network.modem.simUnlock.lengthHint"]({ min: pinMin, max: pinMax })}
					</p>
				{/if}
			</div>
		{/if}
	</div>

	{#snippet actions()}
		<Button
			class="sm:min-w-24"
			data-testid="sim-unlock-dismiss"
			onclick={() => (open = false)}
			variant="outline"
		>
			{onBack ? m["network.modem.simUnlock.back"]() : m["dialogs.close"]()}
		</Button>
		{#if pukRequired && !locked}
			<Button
				class="sm:min-w-24"
				data-testid="sim-puk-submit"
				disabled={!pukFormValid || submitting || pukExhausted}
				onclick={handleSubmitPuk}
			>
				{#if submitting}
					<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
					{m["network.modem.simUnlock.unlocking"]()}
				{:else}
					{m["network.modem.simUnlock.pukSubmit"]()}
				{/if}
			</Button>
		{:else if pin2Required}
			{#if !pin2Terminal}
				<Button
					class="sm:min-w-24"
					data-testid="sim-pin2-submit"
					disabled={!pin2Valid || submitting}
					onclick={handleSubmitPin2}
				>
					{#if submitting}
						<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
						{m["network.modem.simUnlock.unlocking"]()}
					{:else}
						{m["network.modem.simUnlock.pin2Submit"]()}
					{/if}
				</Button>
			{/if}
		{:else if !pukRequired}
			<Button
				class="sm:min-w-24"
				data-testid="sim-pin-submit"
				disabled={!pinValid || submitting}
				onclick={handleSubmit}
			>
				{#if submitting}
					<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
					{m["network.modem.simUnlock.unlocking"]()}
				{:else}
					{m["network.modem.simUnlock.submit"]()}
				{/if}
			</Button>
		{/if}
	{/snippet}
</AppDialog>
