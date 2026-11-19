<!--
  StorageCleanup.svelte: the cleanup actions, destructive ones last. Deleting
  older files reports which boots remain instead of promising they are gone.
  Older log cleanup, Clear all logs and Clear event history ask first, opening on Cancel.
  A refusal or failure is an inline band whose Retry asks again. A success that removed stored history
  tells the other System Logs regions through the history bus.
-->
<script lang="ts">
import { formatBytes } from '@ceraui/i18n/formatters';
import { getLocale } from '@ceraui/i18n/svelte';
import type { LogStorage } from '@ceraui/rpc/schemas';

import SimpleAlertDialog from '$lib/components/custom/simple-alert-dialog.svelte';
import { Button, buttonVariants } from '$lib/components/ui/button';
import { notifyHistoryChanged } from '$lib/device-logs/history-bus';
import { m } from '$lib/device-logs/storage-messages';
import {
	type ActionFailure,
	type ActionReply,
	deleteOlderReply,
	fromSuccess,
	type OkReply,
	settleAction,
	storageReply,
} from '$lib/device-logs/storage-outcome';
import { keepWhole, LINE_BREAKS } from '$lib/device-logs/storage-readout';
import { rpc } from '$lib/rpc/client';
import { cn } from '$lib/utils';

import RecoveryBand from './RecoveryBand.svelte';

interface Props {
	storage: LogStorage;
	onrefresh: () => Promise<void>;
}

let { storage = $bindable(), onrefresh }: Props = $props();

type Action = 'deleteOlder' | 'deleteLegacy' | 'clearAll' | 'clearEvents';

// Long localized labels wrap inside the column; the shared Button base never wraps.
const WRAP = 'h-auto max-w-full whitespace-normal py-1 text-start';
// The dialog's own trigger is a default button; its primary text colour would survive the outline merge.
const TRIGGER = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'text-foreground', WRAP);
// Room for a long localized confirm label beside Cancel; the shared dialog's footer never wraps.
const CONFIRM_WIDTH = 'data-[size=default]:sm:max-w-lg';
// The shared dialog's footer buttons never wrap; a long localized label wraps inside its own button.
const CONFIRM_BUTTONS =
	'[&_[data-slot=alert-dialog-footer]>button]:h-auto [&_[data-slot=alert-dialog-footer]>button]:min-h-[max(2.5rem,var(--touch-target-min))] [&_[data-slot=alert-dialog-footer]>button]:whitespace-normal [&_[data-slot=alert-dialog-footer]>button]:text-center';

const locale = $derived(getLocale());
const uid = $props.id();

/** Focus Cancel when a clear confirmation opens. */
function openOnCancel(id: string) {
	return {
		id,
		// The dialog's own open focus is turned off; Cancel takes focus instead.
		onOpenAutoFocus: (event: Event) => {
			event.preventDefault();
			document
				.getElementById(id)
				?.querySelector<HTMLElement>('[data-slot="alert-dialog-cancel"]')
				?.focus({ preventScroll: true });
		},
	};
}

let running = $state<Action>();
let boots = $state<{ before: number; after: number }>();
let failure = $state<{ action: Action; reason: ActionFailure }>();
let confirmDeleteOlder = $state(false);
let confirmClearAll = $state(false);
let confirmClearEvents = $state(false);

async function run<R extends ActionReply>(
	action: Action,
	call: () => Promise<unknown>,
	read: (reply: unknown) => R,
	done: (reply: OkReply<R>) => unknown,
): Promise<void> {
	if (running !== undefined) return;
	running = action;
	boots = undefined;
	failure = undefined;
	try {
		const reply = await settleAction(call, read);
		if (typeof reply === 'string') failure = { action, reason: reply };
		else await done(reply);
	} finally {
		running = undefined;
	}
}

const deleteOlder = () =>
	run('deleteOlder', () => rpc.logs.deleteOlderFiles(), deleteOlderReply, (reply) => {
		storage = reply.storage;
		boots = { before: reply.bootsBefore, after: reply.bootsAfter };
		notifyHistoryChanged();
	});
const deleteLegacy = () =>
	run('deleteLegacy', () => rpc.logs.deleteLegacyDebug(), storageReply, (reply) => {
		storage = reply.storage;
	});
const clearAll = () =>
	run('clearAll', () => rpc.logs.clearAll(), storageReply, (reply) => {
		storage = reply.storage;
		notifyHistoryChanged();
	});
const clearEvents = () =>
	run('clearEvents', () => rpc.events.clear(), fromSuccess, () => {
		notifyHistoryChanged();
		return onrefresh();
	});

const RETRY: Record<Action, () => unknown> = {
	deleteOlder: () => (confirmDeleteOlder = true),
	deleteLegacy,
	clearAll: () => (confirmClearAll = true),
	clearEvents: () => (confirmClearEvents = true),
};
</script>

<div class="flex flex-col gap-4 border-t pt-5" data-testid="storage-cleanup">
	<div class="flex flex-col items-start gap-1.5">
		<SimpleAlertDialog
			class="{CONFIRM_WIDTH} {CONFIRM_BUTTONS} {LINE_BREAKS}"
			bind:open={confirmDeleteOlder}
			buttonClasses={TRIGGER}
			buttonText={m['systemLogs.storage.deleteOlder']()}
			confirmButtonText={m['systemLogs.storage.deleteOlder']()}
			confirmVariant="destructive"
			contentProps={openOnCancel(`${uid}-delete-older`)}
			disabledConfirmButton={running !== undefined}
			extraButtonClasses="min-h-(--touch-target-min)"
			triggerProps={{ 'aria-busy': running === 'deleteOlder', 'data-testid': 'storage-delete-older', disabled: running !== undefined }}
			onconfirm={deleteOlder}
		>
			{#snippet dialogTitle()}
				{m['systemLogs.storage.deleteOlder']()}
			{/snippet}
			{#snippet description()}
				{m['systemLogs.storage.deleteOlderBody']()}
			{/snippet}
		</SimpleAlertDialog>
		<p class="text-muted-foreground text-xs">{m['systemLogs.storage.deleteOlderHint']()}</p>
	</div>
	{#if storage.legacyDebugBytes > 0}
		<Button
			aria-busy={running === 'deleteLegacy'}
			class="self-start {WRAP}"
			data-testid="storage-delete-legacy"
			disabled={running !== undefined}
			onclick={deleteLegacy}
			size="sm"
			variant="outline"
		>
			{m['systemLogs.storage.deleteLegacy']({ size: keepWhole(formatBytes(locale)(storage.legacyDebugBytes)) })}
		</Button>
	{/if}
	<div class="flex flex-wrap gap-2">
		<SimpleAlertDialog
			class="{CONFIRM_WIDTH} {CONFIRM_BUTTONS} {LINE_BREAKS}"
			bind:open={confirmClearAll}
			buttonClasses={TRIGGER}
			buttonText={m['systemLogs.storage.clearAll']()}
			confirmButtonText={m['systemLogs.storage.clearAllConfirm']()}
			confirmVariant="destructive"
			contentProps={openOnCancel(`${uid}-clear-all`)}
			disabledConfirmButton={running !== undefined}
			extraButtonClasses="min-h-(--touch-target-min)"
			onconfirm={clearAll}
		>
			{#snippet dialogTitle()}
				{m['systemLogs.storage.clearAllTitle']()}
			{/snippet}
			{#snippet description()}
				{m['systemLogs.storage.clearAllBody']()}
			{/snippet}
		</SimpleAlertDialog>
		<SimpleAlertDialog
			class="{CONFIRM_WIDTH} {CONFIRM_BUTTONS} {LINE_BREAKS}"
			bind:open={confirmClearEvents}
			buttonClasses={TRIGGER}
			buttonText={m['systemLogs.storage.clearEvents']()}
			confirmButtonText={m['systemLogs.storage.clearEventsConfirm']()}
			confirmVariant="destructive"
			contentProps={openOnCancel(`${uid}-clear-events`)}
			disabledConfirmButton={running !== undefined}
			extraButtonClasses="min-h-(--touch-target-min)"
			onconfirm={clearEvents}
		>
			{#snippet dialogTitle()}
				{m['systemLogs.storage.clearEventsTitle']()}
			{/snippet}
			{#snippet description()}
				{m['systemLogs.storage.clearEventsBody']()}
			{/snippet}
		</SimpleAlertDialog>
	</div>
	<p class="text-sm" data-testid="storage-cleanup-status" role="status">
		{#if boots}
			{m['systemLogs.storage.deleteOlderResult']({ before: boots.before, after: boots.after })}
		{/if}
	</p>
	{#if failure}
		<RecoveryBand
			message={failure.reason === 'refused'
				? m['systemLogs.storage.updateInProgress']()
				: m['systemLogs.storage.actionFailed']()}
			onretry={RETRY[failure.action]}
			testid="storage-cleanup-failed"
		/>
	{/if}
</div>
