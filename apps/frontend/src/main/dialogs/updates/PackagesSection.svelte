<!--
  PackagesSection.svelte — the legacy package update controls (Task 26),
  extracted from UpdatesDialog; the summary is `PackagesSummary.svelte`.

  Install is destructive: it routes through a confirmation AppDialog before
  calling `system.startUpdate`. While an update runs, a progress indicator
  replaces the install action; the full-screen overlay (Layout, off
  `status.updating`) carries the real percentage.

  Every conclusion is the device's (round-3 review C, C3-4): the start runs
  through the same action machine as the orchestrator controls (action
  `packages`). A `{ success: false }` reply is "didn't start" with the device's
  reason; a lost reply is "Outcome not confirmed" until a CHANGE of the update
  state settles it; a start the device ACCEPTED and then never reported
  progress for says exactly that, and never that nothing was installed.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { AlertTriangle, Download, RefreshCw } from '@lucide/svelte';
import { untrack } from 'svelte';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { Progress } from '$lib/components/ui/progress';
import { confirmOperation, getOperationPhase } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { NotSentError } from '$lib/rpc/rpc-error';
import { getUpdateState } from '$lib/rpc/subscriptions.svelte';
import { actionableCountOf, availableOf, checkedAtOf } from '$lib/updates/legacy-packages';
import type { UpdateSurface } from '$lib/updates/update-surface.svelte';

import ActionOutcomeBand from './ActionOutcomeBand.svelte';
import PackagesSummary from './PackagesSummary.svelte';

interface Props {
	surface: Pick<UpdateSurface, 'packagesOutcome' | 'installPackages' | 'observeLegacy'>;
	/** The next scheduled package check, already formatted. */
	nextCheck: string | undefined;
}

let { surface, nextCheck }: Props = $props();

const updateState = $derived(getUpdateState());
const actionableCount = $derived(actionableCountOf(availableOf(updateState)));
const failed = $derived(updateState?.kind === 'failed');
const succeeded = $derived(updateState?.kind === 'success');
const preflightFailed = $derived(updateState?.kind === 'update_preflight_failed');
const lastCheckedAt = $derived(checkedAtOf(updateState));
const inProgress = $derived(updateState?.kind === 'downloading' || updateState?.kind === 'installing');
const progressValue = $derived.by(() => {
	const p = updateState?.kind === 'downloading' || updateState?.kind === 'installing' ? updateState.progress : undefined;
	if (!p?.total || p.total <= 0) return undefined;
	const done = (p.downloading ?? 0) + (p.unpacking ?? 0) + (p.setting_up ?? 0);
	return Math.min(100, Math.max(0, Math.round((100 * done) / (3 * p.total))));
});

let confirmOpen = $state(false);

// `update` covers the start-dispatch window: pending from the dispatch until the
// first in-progress state confirms it, or the valve lapses.
const starting = $derived(getOperationPhase('update') === 'pending');

// Every legacy state the device pushes is evidence; only a CHANGE counts.
$effect(() => {
	const kind = updateState?.kind;
	untrack(() => surface.observeLegacy(kind));
});

const outcome = $derived(surface.packagesOutcome);
// A newer update state supersedes the last start's band.
const superseded = $derived(inProgress || failed || succeeded || preflightFailed);

// "Accepted, never reported progress" needs an ACCEPTED reply (the derived
// below): the valve also lapses while a reply is still on the wire, which
// proves nothing. The lapse is latched per call, because its phase decays a
// few seconds later.
let stalledCall = $state<number | undefined>();
$effect(() => {
	if (outcome !== undefined && getOperationPhase('update') === 'timed_out') stalledCall = outcome.call;
});
const stalled = $derived(!superseded && outcome?.state === 'accepted' && outcome.call === stalledCall);
const refused = $derived(!superseded && outcome?.state === 'refused' ? outcome : undefined);
const unconfirmed = $derived(!superseded && outcome?.state === 'unconfirmed' ? outcome : undefined);

function startRefusalCopy(reason: string | undefined): string {
	switch (reason) {
		case 'updates_disabled':
			return m["general.updateReasonDisabled"]();
		case 'streaming':
			return m["general.updateReasonStreamingUnconfirmed"]();
		case 'already_updating':
			return m["general.updateReasonAlreadyUpdating"]();
		case 'check_unavailable':
			return m["general.updateReasonCheckUnavailable"]();
		case 'not_connected':
			return m["settings.updates.refusal.notConnected"]();
		default:
			return m["general.updateReasonUnknown"]();
	}
}

// A fast preflight refusal can replace progress before the browser paints it.
$effect(() => {
	if (getOperationPhase('update') !== 'pending') return;
	if (inProgress || preflightFailed) confirmOperation('update');
});

// A check the device declined to run at all — separate from `check_failed`,
// which is a check that ran and could not reach a verdict.
let checkRefusal = $state<string | undefined>();

const checkRefusalMessage = $derived.by(() => {
	if (checkRefusal === undefined) return undefined;
	switch (checkRefusal) {
		case 'updates_disabled':
			return m["general.updateReasonDisabled"]();
		case 'check_unavailable':
			return m["general.updateCheckReasonBusy"]();
		case 'not_connected':
			return m["settings.updates.refusal.notConnected"]();
		default:
			return m["general.updateReasonUnknown"]();
	}
});

let checking = $state(false);
let checkTimeout: ReturnType<typeof setTimeout> | undefined;
let checkedAtOnDispatch = $state<number | undefined>();

function stopChecking(): void {
	checking = false;
	clearTimeout(checkTimeout);
}

async function doCheck() {
	if (checking || inProgress) return;
	checkRefusal = undefined;
	checkedAtOnDispatch = lastCheckedAt;
	checking = true;
	clearTimeout(checkTimeout);
	checkTimeout = setTimeout(() => {
		checking = false;
	}, 30_000);
	let res: { success: boolean; error?: string };
	try {
		res = await rpc.system.checkForUpdates();
	} catch (error) {
		// Only a request never sent proves the check did not run; a lost reply
		// leaves the spinner to the device's completed-check stamp.
		if (error instanceof NotSentError) {
			stopChecking();
			checkRefusal = 'not_connected';
		}
		return;
	}
	if (!res.success) {
		stopChecking();
		checkRefusal = res.error ?? 'unknown';
	}
}

// The device confirms a COMPLETED check by stamping a new `checked_at`:
// `available` outranks `checking`, so a device that already knows about an
// update never publishes a `checking` frame at all.
$effect(() => {
	if (!checking) return;
	if (lastCheckedAt !== undefined && lastCheckedAt !== checkedAtOnDispatch) stopChecking();
});

$effect(() => () => clearTimeout(checkTimeout));
</script>

<section aria-labelledby="updates-packages-heading" class="space-y-5" data-testid="updates-packages">
	<h3 class="text-sm font-semibold" id="updates-packages-heading">{m['settings.updates.packages.title']()}</h3>
	<PackagesSummary {nextCheck} {updateState} />

	{#if inProgress}
		<div class="space-y-2" aria-live="polite">
			<div class="flex items-center gap-2 text-sm font-medium">
				<RefreshCw class="text-primary size-4 motion-safe:animate-spin" />
				{m["settings.dialogs.updating"]()}
			</div>
			<!-- An unknown total is indeterminate progress, never a finished bar. -->
			<Progress value={progressValue ?? null} />
		</div>
	{:else if starting}
		<div class="flex items-center gap-2 text-sm font-medium" aria-live="polite">
			<RefreshCw class="text-primary size-4 motion-safe:animate-spin" />
			{m["network.os.applying"]()}
		</div>
	{:else}
		<!-- A start the device refused, or accepted and then never reported, leaves
		     a standing explanation; a start nobody can confirm says so. -->
		{#if refused || stalled}
			<div
				class="border-status-warning/60 bg-status-warning/10 flex items-start gap-2 rounded-lg border p-3"
				data-testid="update-start-refused"
				role="status"
			>
				<AlertTriangle class="text-status-warning mt-0.5 size-4 shrink-0" />
				<div class="min-w-0 space-y-0.5">
					<p class="text-sm font-medium break-words">
						{stalled ? m["general.updateAcceptedNoProgress"]() : m["general.updateStartRefused"]()}
					</p>
					{#if refused}
						<p class="text-muted-foreground text-sm break-words" data-testid="update-start-refused-reason">
							{startRefusalCopy(refused.reason)}
						</p>
					{/if}
				</div>
			</div>
		{:else if unconfirmed}
			<ActionOutcomeBand
				cause={unconfirmed.cause}
				label={m["general.updateButton"]()}
				refusal={undefined}
				unconfirmed="packages"
			/>
		{/if}

		{#if checkRefusal}
			<div
				class="border-status-warning/60 bg-status-warning/10 flex items-start gap-2 rounded-lg border p-3"
				data-testid="update-check-refused"
				role="status"
			>
				<AlertTriangle class="text-status-warning mt-0.5 size-4 shrink-0" />
				<div class="min-w-0 space-y-0.5">
					<p class="text-sm font-medium">{m["general.updateCheckRefused"]()}</p>
					{#if checkRefusalMessage}
						<p class="text-muted-foreground text-sm break-words" data-testid="update-check-refused-reason">
							{checkRefusalMessage}
						</p>
					{/if}
				</div>
			</div>
		{/if}

		{#if failed || preflightFailed}
			<Button
				aria-busy={checking}
				class="w-full gap-2"
				data-testid="update-retry"
				disabled={checking}
				onclick={doCheck}
				variant="outline"
			>
				<RefreshCw class="size-4 {checking ? 'motion-safe:animate-spin' : ''}" />
				{m["general.retryUpdateCheck"]()}
			</Button>
		{:else}
			{#if actionableCount > 0}
				<Button class="w-full gap-2" data-testid="update-install" onclick={() => (confirmOpen = true)}>
					<Download class="size-4" />
					{m["general.updateButton"]()}
					<span aria-hidden="true" class="opacity-50">·</span>
					<span>
						{actionableCount}
						{actionableCount === 1 ? m["general.package"]() : m["general.packages"]()}
					</span>
				</Button>
			{/if}
			<Button aria-busy={checking} class="w-full gap-2" disabled={checking} onclick={doCheck} variant="outline">
				<RefreshCw class="size-4 {checking ? 'motion-safe:animate-spin' : ''}" />
				{checking ? m["general.checkingForUpdates"]() : m["general.checkForUpdates"]()}
			</Button>
		{/if}
	{/if}
</section>

<!-- Destructive confirmation: installing interrupts streaming and reboots services. -->
<AppDialog
	bind:open={confirmOpen}
	destructive
	onPrimary={() => void surface.installPackages()}
	primaryLabel={m["general.updateButton"]()}
	title={m["general.areYouSure"]()}
>
	<p class="text-muted-foreground text-sm leading-relaxed">{m["general.updateConfirmation"]()}</p>
</AppDialog>
