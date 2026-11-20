<!--
  Clear all logs and Clear event history ask first, opening on Cancel.
  A refusal or failure is an inline band whose Retry asks again. A success that removed stored history
  tells the other System Logs regions through the history bus.
-->
<script lang="ts">
import { formatBytes } from '@ceraui/i18n/formatters';
import { getLocale } from '@ceraui/i18n/svelte';
import type { LogClearAllOutput, LogStorage } from '@ceraui/rpc/schemas';

import SimpleAlertDialog from '$lib/components/custom/simple-alert-dialog.svelte';
import { Button, buttonVariants } from '$lib/components/ui/button';
import { notifyHistoryChanged } from '$lib/device-logs/history-bus';
import { m } from '$lib/device-logs/storage-messages';
import {
	type ActionFailure,
	type ActionReply,
	clearAllReply,
	fromSuccess,
	type OkReply,
	settleAction,
	storageReply,
} from '$lib/device-logs/storage-outcome';
import { keepWhole, LINE_BREAKS } from '$lib/device-logs/storage-readout';
import { rpc } from '$lib/rpc/client';
import { cn } from '$lib/utils';

import ParamText from './ParamText.svelte';
import RecoveryBand from './RecoveryBand.svelte';

interface Props {
	storage: LogStorage;
	onrefresh: () => Promise<void>;
}

let { storage = $bindable(), onrefresh }: Props = $props();

type Action = 'deleteLegacy' | 'clearAll' | 'clearEvents';

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
let cleanup = $state<OkReply<LogClearAllOutput>>();
let failure = $state<{ action: Action; reason: ActionFailure }>();
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
	cleanup = undefined;
	failure = undefined;
	try {
		const reply = await settleAction(call, read);
		if (typeof reply === 'string') failure = { action, reason: reply };
		else await done(reply);
	} finally {
		running = undefined;
	}
}

const deleteLegacy = () =>
	run('deleteLegacy', () => rpc.logs.deleteLegacyDebug(), storageReply, (reply) => {
		storage = reply.storage;
	});
const clearAll = () =>
	run('clearAll', () => rpc.logs.clearAll(), clearAllReply, (reply) => {
		storage = reply.storage;
		cleanup = reply;
		notifyHistoryChanged();
	});
const clearEvents = () =>
	run('clearEvents', () => rpc.events.clear(), fromSuccess, () => {
		notifyHistoryChanged();
		return onrefresh();
	});

const RETRY: Record<Action, () => unknown> = {
	deleteLegacy,
	clearAll: () => (confirmClearAll = true),
	clearEvents: () => (confirmClearEvents = true),
};
</script>

<div class="flex flex-col gap-4 border-t pt-5" data-testid="storage-cleanup">
	{#if storage.legacyDebugBytes === null || storage.legacyDebugBytes > 0}
		<Button
			aria-busy={running === 'deleteLegacy'}
			class="self-start {WRAP}"
			data-testid="storage-delete-legacy"
			disabled={running !== undefined}
			onclick={deleteLegacy}
			size="sm"
			variant="outline"
		>
			{#if storage.legacyDebugBytes === null}
				{m['systemLogs.storage.deleteLegacyUnknown']()}
			{:else}
				<ParamText
					format={(size) => m['systemLogs.storage.deleteLegacy']({ size })}
					value={keepWhole(formatBytes(locale)(storage.legacyDebugBytes))}
				/>
			{/if}
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
	<div class="text-sm" data-testid="storage-cleanup-status" role="status">
		{#if cleanup}
			<p>{m['systemLogs.storage.clearAllResult']({ before: cleanup.bootsBefore, after: cleanup.bootsAfter })}</p>
		{/if}
	</div>
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
