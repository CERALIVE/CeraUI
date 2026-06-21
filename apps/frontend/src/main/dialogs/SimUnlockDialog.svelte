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

  Neither secret is resubmitted automatically — a blind retry walks the SIM toward
  an irreversible lockout, so every attempt is an explicit user action.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Modem, SimPukUnlockOutput, SimUnlockOutput } from '@ceraui/rpc/schemas';
import { KeyRound, Loader2, ShieldAlert, ShieldX } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { networkConstraints } from '$lib/components/streaming/ValidationAdapter';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { rpc } from '$lib/rpc';
import { isOperationPending, osCommand } from '$lib/rpc/async-operation.svelte';
import {
	classifySimPinResult,
	classifySimPukResult,
} from '$lib/rpc/sim-unlock-outcome';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
	modem: Modem;
	deviceId: string | number;
}

let { open = $bindable(false), modem, deviceId }: Props = $props();

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

const pukRequired = $derived(
	errorState === 'puk-required' ||
		modem.sim_lock?.required === 'sim-puk' ||
		modem.sim_lock?.required === 'sim-puk2',
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
const dialogTitle = $derived(
	locked
		? $LL.network.modem.simUnlock.pukLockedTitle()
		: pukRequired
			? $LL.network.modem.simUnlock.pukTitle()
			: $LL.network.modem.simUnlock.title(),
);
const dialogIcon = $derived(locked ? ShieldX : pukRequired ? ShieldAlert : KeyRound);

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
		errorState = null;
		pukErrorState = null;
		remainingAttempts = modem.sim_lock?.remainingAttempts;
		pukRemainingAttempts =
			modem.sim_lock?.required === 'sim-puk' || modem.sim_lock?.required === 'sim-puk2'
				? modem.sim_lock?.remainingAttempts
				: undefined;
	}
	prevOpen = open;
});

// Apply a PIN result to the inline UI. success closes; wrong-pin/puk-required/
// no-locked-modem are handled here (no generic toast); a genuine error toast is
// owned by osCommand's failure path.
function applyPinResult(result: SimUnlockOutput) {
	const verdict = classifySimPinResult(result);
	if (verdict.ok) {
		toast.success($LL.network.modem.simUnlock.success());
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
		toast.success($LL.network.modem.simUnlock.pukSuccess());
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

async function handleSubmit() {
	if (!pinValid || submitting || pukRequired) return;
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
		failMessage: () => $LL.network.os.operationFailed(),
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
		failMessage: () => $LL.network.os.operationFailed(),
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
					<p class="text-sm font-semibold">{$LL.network.modem.simUnlock.pukLockedTitle()}</p>
					<p class="text-muted-foreground mt-0.5 text-sm leading-relaxed">
						{$LL.network.modem.simUnlock.pukLocked()}
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
					<p class="text-sm font-semibold">{$LL.network.modem.simUnlock.pukTitle()}</p>
					<p class="text-muted-foreground mt-0.5 text-sm leading-relaxed">
						{$LL.network.modem.simUnlock.pukRequired()}
					</p>
				</div>
			</div>

			{#if pukRemainingAttempts !== undefined}
				<div
					class="border-border/60 bg-muted/30 flex items-center justify-between rounded-lg border px-3 py-2"
					data-testid="sim-puk-attempts"
				>
					<span class="text-muted-foreground text-xs">
						{$LL.network.modem.simUnlock.pukAttemptsLabel()}
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
					{$LL.network.modem.simUnlock.pukLabel()}
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
					placeholder={$LL.network.modem.simUnlock.pukPlaceholder()}
					type="password"
					bind:value={puk}
				/>
			</div>

			<div class="space-y-1.5">
				<Label class="text-muted-foreground text-xs" for="sim-new-pin">
					{$LL.network.modem.simUnlock.newPinLabel()}
				</Label>
				<Input
					id="sim-new-pin"
					class="h-12 text-center text-lg tracking-[0.4em]"
					autocomplete="off"
					data-testid="sim-puk-newpin-input"
					inputmode="numeric"
					maxlength={pinMax}
					onkeydown={handlePukKeydown}
					placeholder={$LL.network.modem.simUnlock.newPinPlaceholder()}
					type="password"
					bind:value={newPin}
				/>
				{#if pukErrorState === 'wrong-puk'}
					<p class="text-status-error text-sm" data-testid="sim-puk-error" role="alert">
						{$LL.network.modem.simUnlock.wrongPuk()}
					</p>
				{:else}
					<p class="text-muted-foreground text-xs">
						{$LL.network.modem.simUnlock.pukLengthHint({ length: pukLength })}
					</p>
				{/if}
			</div>
		{:else}
			<p class="text-muted-foreground text-sm leading-relaxed">
				{$LL.network.modem.simUnlock.description()}
			</p>

			<div class="space-y-1.5">
				<Label class="text-muted-foreground text-xs" for="sim-pin">
					{$LL.network.modem.simUnlock.pinLabel()}
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
					placeholder={$LL.network.modem.simUnlock.pinPlaceholder()}
					type="password"
					bind:value={pin}
				/>
				{#if errorState === 'wrong-pin'}
					<p class="text-status-error text-sm" data-testid="sim-pin-error" role="alert">
						{remainingAttempts === undefined
							? $LL.network.modem.simUnlock.wrongPin()
							: $LL.network.modem.simUnlock.attemptsRemaining({ count: remainingAttempts })}
					</p>
				{:else}
					<p class="text-muted-foreground text-xs">
						{$LL.network.modem.simUnlock.lengthHint({ min: pinMin, max: pinMax })}
					</p>
				{/if}
			</div>
		{/if}
	</div>

	{#snippet actions()}
		<Button class="sm:min-w-24" onclick={() => (open = false)} variant="outline">
			{$LL.dialogs.close()}
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
					{$LL.network.modem.simUnlock.unlocking()}
				{:else}
					{$LL.network.modem.simUnlock.pukSubmit()}
				{/if}
			</Button>
		{:else if !pukRequired}
			<Button
				class="sm:min-w-24"
				data-testid="sim-pin-submit"
				disabled={!pinValid || submitting}
				onclick={handleSubmit}
			>
				{#if submitting}
					<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
					{$LL.network.modem.simUnlock.unlocking()}
				{:else}
					{$LL.network.modem.simUnlock.submit()}
				{/if}
			</Button>
		{/if}
	{/snippet}
</AppDialog>
