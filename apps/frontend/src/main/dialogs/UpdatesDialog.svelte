<!--
  UpdatesDialog.svelte — software update review + install (Task 26).

  Shows the available package count and download size from live status. Install
  is a destructive action: it routes through a confirmation AppDialog before
  calling the system RPC (startUpdate). While an update is running, a progress
  indicator replaces the install action and the dialog cannot start another —
  the full-screen `updating-overlay` (mounted globally in Layout.svelte off
  `status.updating`) carries the real percentage, phase and step counts.

  Every start attempt ends in a state the operator can read: the device either
  reports progress, refuses with a named reason, or is called out for having
  accepted the start and then reported nothing at all. It never just stops
  showing a spinner.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/i18n-svelte5';
import { AlertTriangle, CheckCircle2, Download, RefreshCw } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { Progress } from '$lib/components/ui/progress';
import {
	confirmOperation,
	getOperationPhase,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { getUpdateState } from '$lib/rpc/subscriptions.svelte';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

// The ONE update state machine (Todo 24). The dialog and the notification both
// derive from this, so an `available` state already carries the version + summary
// — no manual re-check is needed to render it.
const updateState = $derived(getUpdateState());

const available = $derived(
	updateState?.kind === 'available' ? updateState : undefined,
);
const count = $derived(available?.package_count ?? 0);
const size = $derived(available?.download_size ?? '');
const version = $derived(available?.identity.version ?? '');
const packages = $derived(available?.identity.packages ?? []);

const failed = $derived(updateState?.kind === 'failed' ? updateState : undefined);
const succeeded = $derived(updateState?.kind === 'success');
const checkFailed = $derived(
	updateState?.kind === 'check_failed' ? updateState : undefined,
);
const lastCheckedAt = $derived(
	updateState && 'checked_at' in updateState ? updateState.checked_at : undefined,
);
const lastCheckedLabel = $derived(
	lastCheckedAt === undefined ? '' : new Date(lastCheckedAt).toLocaleTimeString(),
);
const inProgress = $derived(
	updateState?.kind === 'downloading' || updateState?.kind === 'installing',
);
const progress = $derived(
	updateState?.kind === 'downloading' || updateState?.kind === 'installing'
		? updateState.progress
		: undefined,
);

const progressValue = $derived.by(() => {
	const p = progress;
	if (!p?.total || p.total <= 0) return undefined;
	const done = (p.downloading ?? 0) + (p.unpacking ?? 0) + (p.setting_up ?? 0);
	return Math.min(100, Math.max(0, Math.round((100 * done) / (3 * p.total))));
});

let confirmOpen = $state(false);

// `update` op covers ONLY the brief start-dispatch window: it stays `pending`
// from the startUpdate dispatch until the first in-progress state confirms it.
const starting = $derived(getOperationPhase('update') === 'pending');

// The outcome of the last start attempt, latched HERE rather than read off the
// async-op phase: that phase decays to idle after ASYNC_OP_TERMINAL_LINGER_MS,
// which is precisely how a refused or unacknowledged update used to disappear
// with no explanation at all.
type StartOutcome = { kind: 'refused'; reason: string } | { kind: 'stalled' };
let startOutcome = $state<StartOutcome | undefined>();

const refusalMessage = $derived.by(() => {
	if (startOutcome?.kind !== 'refused') return undefined;
	switch (startOutcome.reason) {
		case 'updates_disabled':
			return $LL.general.updateReasonDisabled();
		case 'streaming':
			return $LL.general.updateReasonStreaming();
		case 'already_updating':
			return $LL.general.updateReasonAlreadyUpdating();
		case 'check_unavailable':
			return $LL.general.updateReasonCheckUnavailable();
		default:
			return $LL.general.updateReasonUnknown();
	}
});

async function doInstall() {
	startOutcome = undefined;
	// `silent` because the refusal is rendered as a durable inline band with the
	// device's actual reason — a transient generic toast is what made this
	// failure read as "nothing happened".
	const res = await osCommand({
		key: 'update',
		rpc: () => rpc.system.startUpdate(),
		silent: true,
	});
	if (!res?.success) {
		startOutcome = { kind: 'refused', reason: res?.error ?? 'unknown' };
	}
}

// A check the device declined to run at all — separate from `check_failed`,
// which is a check that ran and could not reach a verdict.
let checkRefusal = $state<string | undefined>();

const checkRefusalMessage = $derived.by(() => {
	if (checkRefusal === undefined) return undefined;
	switch (checkRefusal) {
		case 'updates_disabled':
			return $LL.general.updateReasonDisabled();
		case 'check_unavailable':
			return $LL.general.updateCheckReasonBusy();
		default:
			return $LL.general.updateReasonUnknown();
	}
});

const checkFailureMessage = $derived.by(() => {
	switch (checkFailed?.reason) {
		case 'refresh_failed':
			return $LL.general.updateCheckReasonRefreshFailed();
		case 'discovery_failed':
			return $LL.general.updateCheckReasonDiscoveryFailed();
		default:
			return undefined;
	}
});

let checking = $state(false);
let checkTimeout: ReturnType<typeof setTimeout> | undefined;
let checkedAtOnDispatch = $state<number | undefined>();

async function doCheck() {
	if (checking || inProgress) return;
	checkRefusal = undefined;
	checkedAtOnDispatch = lastCheckedAt;
	checking = true;
	clearTimeout(checkTimeout);
	checkTimeout = setTimeout(() => {
		checking = false;
	}, 30_000);
	const res = await rpc.system.checkForUpdates();
	if (!res.success) {
		checking = false;
		clearTimeout(checkTimeout);
		checkRefusal = res.error ?? 'unknown';
	}
}

// The device confirms a COMPLETED check by stamping a new `checked_at`. Latching
// on that rather than on a transition out of `checking` is what keeps the spinner
// alive: `available` outranks `checking` in the state machine, so a device that
// already knows about an update never publishes a `checking` frame at all — and
// the previous rule then cancelled the spinner on the very next flush, before the
// RPC had even been dispatched.
$effect(() => {
	if (!checking) return;
	if (lastCheckedAt !== undefined && lastCheckedAt !== checkedAtOnDispatch) {
		checking = false;
		clearTimeout(checkTimeout);
	}
});

$effect(() => () => clearTimeout(checkTimeout));

// Confirm the start-dispatch op once the first in-progress state lands.
$effect(() => {
	if (getOperationPhase('update') !== 'pending') return;
	if (inProgress) confirmOperation('update');
});

// The device accepted the start but never reported a single progress frame.
// Say so — the operator must never be left to infer it from a vanished spinner.
$effect(() => {
	if (getOperationPhase('update') === 'timed_out') {
		startOutcome = { kind: 'stalled' };
	}
});

// A real update (or a fresh terminal state) supersedes the last start outcome.
$effect(() => {
	if (inProgress || failed || succeeded) startOutcome = undefined;
});
</script>

<AppDialog
	bind:open
	description={$LL.settings.index.updatesDesc()}
	hideFooter
	icon={RefreshCw}
	title={$LL.settings.index.updates()}
>
	<div class="space-y-5">
		<!-- Availability summary — the version is already present in the `available`
		     state, so it renders without any manual re-check. -->
		<div class="bg-muted/40 rounded-lg border p-4" data-testid="update-summary">
			{#if failed}
				<div class="flex items-start gap-2" data-testid="update-failed">
					<AlertTriangle class="text-destructive mt-0.5 size-5 shrink-0" />
					<div class="min-w-0">
						<p class="text-destructive text-lg font-semibold">
							{$LL.general.updateFailed()}
						</p>
						<p class="text-muted-foreground mt-1 text-sm break-words" data-testid="update-failed-reason">
							{failed.reason}
						</p>
					</div>
				</div>
			{:else if succeeded}
				<div class="flex items-start gap-2" data-testid="update-succeeded">
					<CheckCircle2 class="text-status-success mt-0.5 size-5 shrink-0" />
					<div class="min-w-0">
						<p class="text-status-success text-lg font-semibold">
							{$LL.general.updateComplete()}
						</p>
						<p class="text-muted-foreground mt-1 text-sm">
							{$LL.general.updateCompleteDetail()}
						</p>
					</div>
				</div>
			{:else if count > 0}
				<p class="text-2xl font-bold">
					{count}
					{count === 1 ? $LL.general.package() : $LL.general.packages()}
				</p>
				{#if size}
					<p class="text-muted-foreground mt-0.5 text-sm">{size}</p>
				{/if}
				{#if version}
					<p class="text-muted-foreground mt-1 font-mono text-xs" data-testid="update-version">
						{version}
					</p>
				{/if}
				{#if packages.length > 0}
					<p class="text-muted-foreground mt-1 text-xs break-words" data-testid="update-packages">
						{packages.join(', ')}
					</p>
				{/if}
			{:else if checkFailed}
				<div class="flex items-start gap-2" data-testid="update-check-failed">
					<AlertTriangle class="text-status-warning mt-0.5 size-5 shrink-0" />
					<div class="min-w-0">
						<p class="text-status-warning text-lg font-semibold">
							{$LL.general.updateCheckFailed()}
						</p>
						{#if checkFailureMessage}
							<p
								class="text-muted-foreground mt-1 text-sm break-words"
								data-testid="update-check-failed-reason"
							>
								{checkFailureMessage}
							</p>
						{/if}
					</div>
				</div>
			{:else}
				<p class="text-lg font-semibold">{$LL.general.noUpdatesAvailable()}</p>
				<!-- Without this the operator cannot tell a successful check that found
				     nothing from a button that did nothing at all. -->
				{#if lastCheckedLabel}
					<p class="text-muted-foreground mt-1 text-sm" data-testid="update-last-checked">
						{$LL.general.updateLastChecked({ time: lastCheckedLabel })}
					</p>
				{/if}
			{/if}
		</div>

		{#if inProgress}
			<div class="space-y-2" aria-live="polite">
				<div class="flex items-center gap-2 text-sm font-medium">
					<RefreshCw class="text-primary size-4 motion-safe:animate-spin" />
					{$LL.settings.dialogs.updating()}
				</div>
				<Progress value={progressValue ?? 100} />
			</div>
		{:else if starting}
			<div class="flex items-center gap-2 text-sm font-medium" aria-live="polite">
				<RefreshCw class="text-primary size-4 motion-safe:animate-spin" />
				{$LL.network.os.applying()}
			</div>
		{:else}
			<!-- A start that was refused, or accepted and then never reported, must
			     leave a standing explanation — not just stop showing a spinner. -->
			{#if startOutcome}
				<div
					class="border-status-warning/60 bg-status-warning/10 flex items-start gap-2 rounded-lg border p-3"
					data-testid="update-start-refused"
					role="status"
				>
					<AlertTriangle class="text-status-warning mt-0.5 size-4 shrink-0" />
					<div class="min-w-0 space-y-0.5">
						<p class="text-sm font-medium">
							{startOutcome.kind === 'stalled'
								? $LL.general.updateNoProgress()
								: $LL.general.updateStartRefused()}
						</p>
						{#if refusalMessage}
							<p
								class="text-muted-foreground text-sm break-words"
								data-testid="update-start-refused-reason"
							>
								{refusalMessage}
							</p>
						{/if}
					</div>
				</div>
			{/if}

			{#if checkRefusal}
				<div
					class="border-status-warning/60 bg-status-warning/10 flex items-start gap-2 rounded-lg border p-3"
					data-testid="update-check-refused"
					role="status"
				>
					<AlertTriangle class="text-status-warning mt-0.5 size-4 shrink-0" />
					<div class="min-w-0 space-y-0.5">
						<p class="text-sm font-medium">{$LL.general.updateCheckRefused()}</p>
						{#if checkRefusalMessage}
							<p
								class="text-muted-foreground text-sm break-words"
								data-testid="update-check-refused-reason"
							>
								{checkRefusalMessage}
							</p>
						{/if}
					</div>
				</div>
			{/if}

			{#if failed}
				<Button
					aria-busy={checking}
					class="w-full gap-2"
					disabled={checking}
					onclick={doCheck}
					variant="outline"
					data-testid="update-retry"
				>
					<RefreshCw class="size-4 {checking ? 'motion-safe:animate-spin' : ''}" />
					{$LL.general.retryUpdateCheck()}
				</Button>
			{:else}
				{#if count > 0}
					<Button class="w-full gap-2" onclick={() => (confirmOpen = true)}>
						<Download class="size-4" />
						{$LL.general.updateButton()}
					</Button>
				{/if}
				<Button
					aria-busy={checking}
					class="w-full gap-2"
					disabled={checking}
					onclick={doCheck}
					variant="outline"
				>
					<RefreshCw class="size-4 {checking ? 'motion-safe:animate-spin' : ''}" />
					{checking ? $LL.general.checkingForUpdates() : $LL.general.checkForUpdates()}
				</Button>
			{/if}
		{/if}
	</div>
</AppDialog>

<!-- Destructive confirmation: installing interrupts streaming and reboots services. -->
<AppDialog
	bind:open={confirmOpen}
	destructive
	onPrimary={doInstall}
	primaryLabel={$LL.general.updateButton()}
	title={$LL.general.areYouSure()}
>
	<p class="text-muted-foreground text-sm leading-relaxed">{$LL.general.updateConfirmation()}</p>
</AppDialog>
