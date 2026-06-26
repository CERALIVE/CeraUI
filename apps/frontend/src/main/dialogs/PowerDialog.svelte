<!--
  PowerDialog.svelte — reboot / power-off the device (Task 27).

  Two destructive actions, each gated behind a nested confirmation step:
    • Reboot  → rpc.system.reboot()  → markRebooting() (Task-16 banner takes
                over the reconnect UX) → close.
    • Power off → rpc.system.poweroff() → close. We deliberately do NOT mark
                "rebooting" here: a powered-off device never returns, so the
                normal reconnecting/failed banner is the honest treatment.

  Both actions are blocked while the device is streaming or while a software
  update is running — this mirrors the backend guard and surfaces the reason
  inline so the operator knows why the buttons are disabled.

  This composes the shared AppDialog chrome; the confirmation is a second,
  nested AppDialog with `destructive` set so its primary button is red.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { UpdateProgress } from '@ceraui/rpc/schemas';
import { AlertTriangle, Power, PowerOff, RotateCcw } from '@lucide/svelte';

import { onDestroy } from 'svelte';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { getOperationPhase, osCommand } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { getIsConnected, getIsStreaming, getUpdating } from '$lib/rpc/subscriptions.svelte';
import { clearRebooting, getIsRebooting, markRebooting } from '$lib/stores/connection-ux.svelte';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
	/** Seconds the reboot reconnect window runs before offering recovery. */
	countdownSeconds?: number;
}

let { open = $bindable(false), countdownSeconds }: Props = $props();

// Explicit prop wins (unit tests); else an optional window override lets e2e
// shrink the reconnect window without waiting a real hardware reboot; else the
// hardware default. The override is never set in production.
function resolveCountdownSeconds(): number {
	if (typeof countdownSeconds === 'number') return countdownSeconds;
	const override =
		typeof window !== 'undefined'
			? (window as unknown as { __ceraRebootCountdownSeconds?: number })
					.__ceraRebootCountdownSeconds
			: undefined;
	return typeof override === 'number' && override > 0 ? override : 45;
}

// --- Backend guard, reflected in the UI ------------------------------------
const streaming = $derived(getIsStreaming());
const updating = $derived(getUpdating());
// In progress = literal true OR a progress object that hasn't resolved.
const isUpdating = $derived(
	updating === true ||
		(typeof updating === 'object' && updating !== null && (updating as UpdateProgress).result !== 0),
);
const blocked = $derived(streaming || isUpdating);
const blockedReason = $derived(
	streaming
		? $LL.settings.dialogs.blockedStreaming()
		: isUpdating
			? $LL.settings.dialogs.blockedUpdating()
			: '',
);

// --- Nested confirmation step ----------------------------------------------
type PendingAction = 'reboot' | 'poweroff';

let confirmOpen = $state(false);
let pending = $state<PendingAction | null>(null);
// Re-entry protection + in-flight state: reboot/poweroff each run through the
// keyed async-operation machine (osCommand), so `busy` is derived from whichever
// op is `pending` rather than a hand-rolled boolean. osCommand's own re-entry
// guard blocks a second dispatch while a key is in flight.
const busy = $derived(
	getOperationPhase('reboot') === 'pending' || getOperationPhase('poweroff') === 'pending',
);

const confirmLabel = $derived(
	pending === 'poweroff' ? $LL.advanced.powerOff() : $LL.advanced.reboot(),
);
const confirmBody = $derived(
	pending === 'poweroff'
		? $LL.settings.dialogs.powerOffConfirm()
		: $LL.settings.dialogs.rebootConfirm(),
);

function request(action: PendingAction) {
	if (blocked) return;
	pending = action;
	confirmOpen = true;
}

// Power/reboot deliberately stay OUT of the field-sync (config-write) machine:
// the device going down IS the success signal (the DisconnectedBanner owns that
// UX). They DO route through the keyed async-operation machine via `osCommand`,
// which owns the re-entry guard + in-flight `pending` phase + the single
// failure-feedback toast. `confirmOnResolve` settles the op to `confirmed` the
// moment the `{ success: true }` reply flushes (the reply always returns before
// systemd takes the host down). A backend-refused op (streaming / updating guard)
// returns `{ success: false }`, which osCommand classifies as a failure — it
// toasts and we never advance to "rebooting"/close.
async function confirmAction() {
	const action = pending;
	if (!action) return;
	const result = await osCommand({
		key: action,
		target: action,
		rpc: () => (action === 'reboot' ? rpc.system.reboot() : rpc.system.poweroff()),
		confirmOnResolve: true,
		failMessage: () => $LL.network.os.operationFailed(),
	});
	pending = null;
	// undefined → re-entry no-op or a thrown RPC (osCommand already toasted);
	// success:false → refused op (osCommand already toasted). Either way, do NOT
	// mark rebooting or close.
	if (!result?.success) return;
	if (action === 'reboot') {
		// Hand the reconnect UX to the Task-16 banner (it auto-clears on
		// reconnect) AND run an in-dialog countdown so the operator sees the
		// reconnect window progress and gets a recovery path if it overruns.
		markRebooting();
		startRebootCountdown();
	} else {
		// Power off: the device never returns, so the honest treatment is to
		// close and let the normal reconnecting/failed banner take over.
		open = false;
	}
}

// --- Reboot countdown + failure recovery -----------------------------------
// A reboot that succeeds at the RPC level can still fail to take the device
// down (a blocked systemd job, a dev no-op). Then the socket never drops, the
// banner stays latched on "rebooting" forever, and the operator is stranded.
// So after the reconnect window elapses we check whether we are STILL reachable:
// if so the reboot never happened — clear the misleading banner and offer a calm
// retry; if the socket has dropped, the device is genuinely down and the banner
// owns the screen.
type RebootPhase = 'idle' | 'counting' | 'recovery';

let rebootPhase = $state<RebootPhase>('idle');
let remaining = $state(0);
let countdownTimer: ReturnType<typeof setInterval> | null = null;

function stopCountdown() {
	if (countdownTimer !== null) {
		clearInterval(countdownTimer);
		countdownTimer = null;
	}
}

function resetReboot() {
	stopCountdown();
	rebootPhase = 'idle';
	remaining = 0;
}

function startRebootCountdown() {
	stopCountdown();
	remaining = Math.max(1, Math.round(resolveCountdownSeconds()));
	rebootPhase = 'counting';
	countdownTimer = setInterval(() => {
		if (!open) {
			resetReboot();
			return;
		}
		remaining -= 1;
		if (remaining > 0) return;
		stopCountdown();
		if (getIsConnected()) {
			rebootPhase = 'recovery';
			clearRebooting();
		} else {
			open = false;
		}
	}, 1000);
}

// Success signal: a reconnect during the countdown clears the rebooting latch
// (reduceConnection on the fresh "connected"). The device is back — close and
// let the re-authenticated surface return; the banner has already cleared.
$effect(() => {
	if (rebootPhase === 'counting' && !getIsRebooting()) {
		resetReboot();
		open = false;
	}
});

// Closing the dialog (esc / overlay / X) mid-countdown must stop the timer.
$effect(() => {
	if (!open && rebootPhase !== 'idle') resetReboot();
});

onDestroy(stopCountdown);

function retryReboot() {
	if (blocked) return;
	resetReboot();
	pending = 'reboot';
	void confirmAction();
}

function dismissRecovery() {
	clearRebooting();
	open = false;
}
</script>

<AppDialog
	bind:open
	description={$LL.settings.index.powerDesc()}
	destructive
	hideFooter
	icon={Power}
	title={$LL.settings.index.power()}
>
	<div class="space-y-5">
		{#if rebootPhase === 'counting'}
			<div
				aria-live="polite"
				class="flex flex-col items-center gap-4 py-6 text-center"
				data-reboot-phase="counting"
				role="status"
			>
				<span class="bg-secondary text-foreground grid size-12 shrink-0 place-items-center rounded-xl">
					<RotateCcw class="size-6 motion-safe:animate-spin" />
				</span>
				<div class="space-y-1">
					<h3 class="text-sm font-semibold">{$LL.settings.dialogs.rebootCountdownTitle()}</h3>
					<p class="text-muted-foreground text-xs">{$LL.settings.dialogs.rebootCountdownDescription()}</p>
				</div>
				<p class="font-mono text-2xl tabular-nums" data-reboot-countdown>
					{$LL.settings.dialogs.rebootCountdownRemaining({ seconds: remaining })}
				</p>
			</div>
		{:else if rebootPhase === 'recovery'}
			<div class="space-y-4" data-reboot-phase="recovery">
				<div
					aria-live="polite"
					class="border-status-warning/30 bg-status-warning/10 text-foreground flex items-start gap-3 rounded-lg border px-4 py-3"
					role="status"
				>
					<AlertTriangle class="text-status-warning mt-0.5 size-4 shrink-0" />
					<div class="space-y-1">
						<p class="text-sm font-medium">{$LL.settings.dialogs.rebootRecoveryTitle()}</p>
						<p class="text-muted-foreground text-xs">{$LL.settings.dialogs.rebootRecoveryDescription()}</p>
					</div>
				</div>
				<div class="flex flex-col gap-2 sm:flex-row">
					<Button class="min-h-11 w-full gap-2" onclick={retryReboot} variant="outline">
						<RotateCcw class="size-4" />
						{$LL.settings.dialogs.rebootRecoveryRetry()}
					</Button>
					<Button class="min-h-11 w-full" onclick={dismissRecovery} variant="ghost">
						{$LL.settings.dialogs.rebootRecoveryDismiss()}
					</Button>
				</div>
			</div>
		{:else}
		{#if blocked}
			<!-- Why the actions are unavailable right now. -->
			<div
				class="border-destructive/30 bg-destructive/10 text-destructive flex items-start gap-3 rounded-lg border px-4 py-3"
				role="alert"
			>
				<AlertTriangle class="mt-0.5 size-4 shrink-0" />
				<p class="text-sm font-medium">{blockedReason}</p>
			</div>
		{/if}

		<!-- Reboot -->
		<div class="flex items-start gap-4 rounded-xl border p-4">
			<span class="bg-secondary text-foreground grid size-10 shrink-0 place-items-center rounded-lg">
				<RotateCcw class="size-5" />
			</span>
			<div class="min-w-0 flex-1 space-y-3">
				<div class="space-y-1">
					<h3 class="text-sm font-semibold">{$LL.advanced.reboot()}</h3>
					<p class="text-muted-foreground text-xs">{$LL.advanced.rebootDescription()}</p>
				</div>
				<Button
					class="w-full gap-2"
					disabled={blocked}
					onclick={() => request('reboot')}
					variant="outline"
				>
					<RotateCcw class="size-4" />
					{$LL.advanced.reboot()}
				</Button>
			</div>
		</div>

		<!-- Power off -->
		<div
			class={cn(
				'flex items-start gap-4 rounded-xl border p-4',
				'border-destructive/30',
			)}
		>
			<span class="bg-destructive/10 text-destructive grid size-10 shrink-0 place-items-center rounded-lg">
				<PowerOff class="size-5" />
			</span>
			<div class="min-w-0 flex-1 space-y-3">
				<div class="space-y-1">
					<h3 class="text-sm font-semibold">{$LL.advanced.powerOff()}</h3>
					<p class="text-muted-foreground text-xs">{$LL.advanced.powerOffDescription()}</p>
				</div>
				<Button
					class="w-full gap-2"
					disabled={blocked}
					onclick={() => request('poweroff')}
					variant="destructive"
				>
					<PowerOff class="size-4" />
					{$LL.advanced.powerOff()}
				</Button>
			</div>
		</div>
		{/if}
	</div>
</AppDialog>

<!-- Nested destructive confirmation: this is the point of no return. -->
<AppDialog
	bind:open={confirmOpen}
	destructive
	onPrimary={confirmAction}
	primaryDisabled={busy}
	primaryLabel={confirmLabel}
	title={$LL.dialogs.areYouSure()}
>
	<p class="text-muted-foreground text-sm leading-relaxed">{confirmBody}</p>
</AppDialog>
