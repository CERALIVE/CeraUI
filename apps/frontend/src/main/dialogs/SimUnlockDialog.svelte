<!--
  SimUnlockDialog.svelte — SIM PIN unlock prompt for a PIN-locked modem.

  Auto-opened by NetworkView when a modem reports `sim_lock.required === 'sim-pin'`.
  Submits the PIN exactly once via the Task 22 `modems.unlockSim` RPC and maps the
  terminal state back to the UI:
    success      → toast + close
    wrong-pin    → inline error with remaining attempts (no resubmit)
    puk-required → PUK-locked state; the PIN field is hidden (a PIN cannot help)

  The PIN is never resubmitted automatically — a blind retry walks the SIM toward
  an irreversible PUK lockout, so each attempt is an explicit user action.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { Modem, SimUnlockOutput } from '@ceraui/rpc/schemas';
import { KeyRound, Loader2, ShieldAlert } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { networkConstraints } from '$lib/components/streaming/ValidationAdapter';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { unlockSimPin } from '$lib/helpers/NetworkHelper';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
	modem: Modem;
	deviceId: string | number;
}

let { open = $bindable(false), modem, deviceId }: Props = $props();

const pinMin = networkConstraints.modem.simPin.min;
const pinMax = networkConstraints.modem.simPin.max;
const pinPattern = new RegExp(`^\\d{${pinMin},${pinMax}}$`);

let pin = $state('');
let submitting = $state(false);
let errorState = $state<SimUnlockOutput['state'] | null>(null);
let remainingAttempts = $state<number | undefined>(undefined);

const pukRequired = $derived(
	errorState === 'puk-required' ||
		modem.sim_lock?.required === 'sim-puk' ||
		modem.sim_lock?.required === 'sim-puk2',
);
const pinValid = $derived(pinPattern.test(pin));
const dialogTitle = $derived(
	pukRequired ? $LL.network.modem.simUnlock.pukTitle() : $LL.network.modem.simUnlock.title(),
);

// Re-seed from the live modem each time the dialog opens.
let prevOpen = false;
$effect(() => {
	if (open && !prevOpen) {
		pin = '';
		submitting = false;
		errorState = null;
		remainingAttempts = modem.sim_lock?.remainingAttempts;
	}
	prevOpen = open;
});

async function handleSubmit() {
	if (!pinValid || submitting || pukRequired) return;
	submitting = true;
	try {
		const result = await unlockSimPin(String(deviceId), pin);
		switch (result.state) {
			case 'success':
				toast.success($LL.network.modem.simUnlock.success());
				open = false;
				break;
			case 'wrong-pin':
				errorState = 'wrong-pin';
				({ remainingAttempts } = result);
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
				errorState = 'error';
				toast.error($LL.network.modem.simUnlock.error());
		}
	} catch {
		errorState = 'error';
		toast.error($LL.network.modem.simUnlock.error());
	} finally {
		submitting = false;
	}
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter') {
		event.preventDefault();
		handleSubmit();
	}
}
</script>

<AppDialog icon={pukRequired ? ShieldAlert : KeyRound} title={dialogTitle} bind:open>
	<div class="space-y-4">
		{#if pukRequired}
			<!-- ── PUK-locked state: a PIN can no longer unlock this SIM ─────────── -->
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
					onkeydown={handleKeydown}
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
		{#if !pukRequired}
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
