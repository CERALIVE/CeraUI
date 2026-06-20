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
import { toast } from 'svelte-sonner';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { rpc } from '$lib/rpc/client';
import { getIsStreaming, getUpdating } from '$lib/rpc/subscriptions.svelte';
import { markRebooting } from '$lib/stores/connection-ux.svelte';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

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
let busy = $state(false);

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

// Power/reboot deliberately stay OUT of the pending→confirm machine: the device
// going down IS the success signal (the DisconnectedBanner owns that UX). But the
// dispatch calls `rpc.system.*` DIRECTLY — not the SystemHelper wrappers, which
// discard the `{ success: false }` body — so a backend-refused op (streaming /
// updating guard) surfaces a calm toast and never advances to "rebooting"/close.
async function confirmAction() {
	const action = pending;
	if (!action || busy) return;
	busy = true;
	try {
		const result =
			action === 'reboot' ? await rpc.system.reboot() : await rpc.system.poweroff();
		if (!result.success) {
			toast.error($LL.network.os.operationFailed());
			return; // do NOT mark rebooting / close on a refused op
		}
		if (action === 'reboot') {
			// Hand the reconnect UX to the Task-16 banner; it auto-clears on
			// reconnect. Closing this dialog lets the banner own the screen.
			markRebooting();
		}
		open = false;
	} catch (error) {
		console.error(`Failed to ${action}:`, error);
		toast.error($LL.network.os.operationFailed());
	} finally {
		busy = false;
		pending = null;
	}
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
