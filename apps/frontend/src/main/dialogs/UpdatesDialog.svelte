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
// allow: SIZE_OK — this legacy dialog couples dispatch confirmation to its rendered update state; keep the lifecycle fix local.
import { m } from '@ceraui/i18n/svelte';
import type { UpdatePackage, UpdatePreflightReason } from '@ceraui/rpc/schemas';
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

// Todo-14 classification. `packages` here is a SIBLING of `identity.packages` —
// that `string[]` stays the dismissal-key source and is untouched.
const classified = $derived<readonly UpdatePackage[]>(available?.packages ?? []);

// A package the device positively will NOT install: it said so outright, or it
// named the layer that ships with the next OS image, or apt held it back. All
// three are positive evidence; an entry carrying none of them was never
// classified, and banding it would be a claim nothing measured.
function isWithheld(pkg: UpdatePackage): boolean {
	return pkg.actionable === false || pkg.layer === 'platform' || pkg.kept_back === true;
}

const withheld = $derived(classified.filter(isWithheld));
const actionableNames = $derived(
	classified.filter((pkg) => !isWithheld(pkg)).map((pkg) => pkg.name),
);
const listedPackages = $derived(classified.length > 0 ? actionableNames : packages);

// `actionable_count` is the device's own verdict and the ONLY gate on Install:
// offering the control for a platform-layer or kept-back set is a button whose
// one possible outcome is a refusal. It is optional purely so a producer that
// classified nothing keeps parsing, so ABSENCE means "not classified" — never
// "zero installable" — and a backend predating the classification keeps the
// button it has always had.
const actionableCount = $derived.by(() => {
	if (available === undefined) return 0;
	if (available.actionable_count !== undefined) return available.actionable_count;
	return classified.length > 0 ? actionableNames.length : count;
});

const failed = $derived(updateState?.kind === 'failed' ? updateState : undefined);
const succeeded = $derived(updateState?.kind === 'success');
const preflightFailed = $derived(
	updateState?.kind === 'update_preflight_failed' ? updateState : undefined,
);
const cleanupWarning = $derived(
	updateState?.kind === 'success' ? updateState.cleanup_warning : undefined,
);
const PREFLIGHT_REASON_COPY = {
	insufficient_space: () => m["settings.updates.update_preflight_failed.insufficient_space"](),
	apt_config_failed: () => m["settings.updates.update_preflight_failed.apt_config_failed"](),
	archive_path_invalid: () => m["settings.updates.update_preflight_failed.archive_path_invalid"](),
	probe_failed: () => m["settings.updates.update_preflight_failed.probe_failed"](),
	probe_no_uri_rows: () => m["settings.updates.update_preflight_failed.probe_no_uri_rows"](),
	probe_uri_size_malformed: () => m["settings.updates.update_preflight_failed.probe_uri_size_malformed"](),
	probe_delta_malformed: () => m["settings.updates.update_preflight_failed.probe_delta_malformed"](),
	stat_failed: () => m["settings.updates.update_preflight_failed.stat_failed"](),
	statfs_failed: () => m["settings.updates.update_preflight_failed.statfs_failed"](),
	value_out_of_range: () => m["settings.updates.update_preflight_failed.value_out_of_range"](),
	pre_clean_failed: () => m["settings.updates.update_preflight_failed.pre_clean_failed"](),
} satisfies Readonly<Record<UpdatePreflightReason, () => string>>;
const preflightMessage = $derived(
	preflightFailed === undefined ? undefined : PREFLIGHT_REASON_COPY[preflightFailed.preflight_reason](),
);
const checkFailed = $derived(
	updateState?.kind === 'check_failed' ? updateState : undefined,
);
const lastCheckedAt = $derived(
	updateState && 'checked_at' in updateState ? updateState.checked_at : undefined,
);
const lastCheckedLabel = $derived(
	lastCheckedAt === undefined ? '' : new Date(lastCheckedAt).toLocaleTimeString(),
);
const reachability = $derived(
	updateState && 'reachability' in updateState ? updateState.reachability : undefined,
);

// One muted line, and only when the answer is not the ordinary healthy one:
// `any` means both families worked, which is worth no sentence at all. A captive
// portal outranks the family verdict — it explains WHY neither family reached a
// repository, which `used: 'none'` alone cannot.
const reachabilityMessage = $derived.by(() => {
	if (reachability === undefined) return undefined;
	if (reachability.ipv4 === 'captive' || reachability.ipv6 === 'captive') {
		return m["settings.updates.reachability.captivePortal"]();
	}
	if (reachability.used === 'ipv4') return m["settings.updates.reachability.ipv4Only"]();
	if (reachability.used === 'ipv6') return m["settings.updates.reachability.ipv6Only"]();
	return undefined;
});

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
			return m["general.updateReasonDisabled"]();
		case 'streaming':
			return m["general.updateReasonStreaming"]();
		case 'already_updating':
			return m["general.updateReasonAlreadyUpdating"]();
		case 'check_unavailable':
			return m["general.updateReasonCheckUnavailable"]();
		default:
			return m["general.updateReasonUnknown"]();
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
			return m["general.updateReasonDisabled"]();
		case 'check_unavailable':
			return m["general.updateCheckReasonBusy"]();
		default:
			return m["general.updateReasonUnknown"]();
	}
});

// `failed.reason` is a free-form wire string, and on a real device it is often
// an apt stderr line — unactionable for an operator with no console, and exactly
// the shape `operator-copy-no-internals` exists to keep off screen. A known
// machine token resolves to keyed copy; anything else resolves to ONE honest
// sentence pointing at the in-app log viewer, and the raw value goes to the
// console and nowhere else.
const FAILED_REASON_COPY: Record<string, () => string> = {
	updates_disabled: () => m["general.updateReasonDisabled"](),
	streaming: () => m["general.updateReasonStreaming"](),
	already_updating: () => m["general.updateReasonAlreadyUpdating"](),
	check_unavailable: () => m["general.updateReasonCheckUnavailable"](),
	refresh_failed: () => m["general.updateCheckReasonRefreshFailed"](),
	discovery_failed: () => m["general.updateCheckReasonDiscoveryFailed"](),
	repos_unreachable: () => m["settings.updates.checkFailed.repos_unreachable"](),
	captive_portal: () => m["settings.updates.checkFailed.captive_portal"](),
};

const failureMessage = $derived(
	failed === undefined
		? undefined
		: (FAILED_REASON_COPY[failed.reason]?.() ??
				m["settings.updates.failedReasonGeneric"]()),
);

$effect(() => {
	const reason = failed?.reason;
	if (reason !== undefined && FAILED_REASON_COPY[reason] === undefined) {
		console.warn('Unmapped software-update failure reason:', reason);
	}
});

const checkFailureMessage = $derived.by(() => {
	switch (checkFailed?.reason) {
		case 'refresh_failed':
			return m["general.updateCheckReasonRefreshFailed"]();
		case 'discovery_failed':
			return m["general.updateCheckReasonDiscoveryFailed"]();
		case 'repos_unreachable':
			return m["settings.updates.checkFailed.repos_unreachable"]();
		case 'captive_portal':
			return m["settings.updates.checkFailed.captive_portal"]();
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

// A fast preflight refusal can replace progress before the browser paints it.
$effect(() => {
	if (getOperationPhase('update') !== 'pending') return;
	if (inProgress || preflightFailed) confirmOperation('update');
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
	if (inProgress || failed || succeeded || preflightFailed) startOutcome = undefined;
});
</script>

<AppDialog
	bind:open
	description={m["settings.index.updatesDesc"]()}
	hideFooter
	icon={RefreshCw}
	title={m["settings.index.updates"]()}
>
	<div class="space-y-5">
		<!-- Availability summary — the version is already present in the `available`
		     state, so it renders without any manual re-check. -->
		<div class="bg-muted/40 rounded-lg border p-4" data-testid="update-summary">
			{#if preflightFailed}
				<div class="flex items-start gap-2" data-testid="update-preflight-failed" role="alert">
					<AlertTriangle class="text-status-warning mt-0.5 size-5 shrink-0" />
					<div class="min-w-0">
						<p class="text-lg font-semibold">{m["settings.updates.preflightFailedTitle"]()}</p>
						<p class="text-muted-foreground mt-1 text-sm break-words" data-testid="update-preflight-reason">
							{preflightMessage}
						</p>
					</div>
				</div>
			{:else if failed}
				<div class="flex items-start gap-2" data-testid="update-failed">
					<AlertTriangle class="text-destructive mt-0.5 size-5 shrink-0" />
					<div class="min-w-0">
						<p class="text-destructive text-lg font-semibold">
							{m["general.updateFailed"]()}
						</p>
						<p class="text-muted-foreground mt-1 text-sm break-words" data-testid="update-failed-reason">
							{failureMessage}
						</p>
					</div>
				</div>
			{:else if succeeded}
				<div class="flex items-start gap-2" data-testid="update-succeeded">
					<CheckCircle2 class="text-status-success mt-0.5 size-5 shrink-0" />
					<div class="min-w-0">
						<p class="text-status-success text-lg font-semibold">
							{m["general.updateComplete"]()}
						</p>
						<p class="text-muted-foreground mt-1 text-sm">
							{m["general.updateCompleteDetail"]()}
						</p>
						{#if cleanupWarning}
							<p class="text-muted-foreground mt-2 text-sm break-words" data-testid="update-cleanup-warning" role="status">
								{m["settings.updates.cleanup_warning.post_clean_failed"]()}
							</p>
						{/if}
					</div>
				</div>
			{:else if count > 0}
				<p class="text-2xl font-bold">
					{count}
					{count === 1 ? m["general.package"]() : m["general.packages"]()}
				</p>
				{#if size}
					<p class="text-muted-foreground mt-0.5 text-sm">{size}</p>
				{/if}
				{#if version}
					<p class="text-muted-foreground mt-1 font-mono text-xs" data-testid="update-version">
						{version}
					</p>
				{/if}
				{#if listedPackages.length > 0}
					<p class="text-muted-foreground mt-1 text-xs break-words" data-testid="update-packages">
						{listedPackages.join(', ')}
					</p>
				{/if}
			{:else if checkFailed}
				<div class="flex items-start gap-2" data-testid="update-check-failed">
					<AlertTriangle class="text-status-warning mt-0.5 size-5 shrink-0" />
					<div class="min-w-0">
						<p class="text-status-warning text-lg font-semibold">
							{m["general.updateCheckFailed"]()}
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
				<p class="text-lg font-semibold">{m["general.noUpdatesAvailable"]()}</p>
				<!-- Without this the operator cannot tell a successful check that found
				     nothing from a button that did nothing at all. -->
				{#if lastCheckedLabel}
					<p class="text-muted-foreground mt-1 text-sm" data-testid="update-last-checked">
						{m["general.updateLastChecked"]({ time: lastCheckedLabel })}
					</p>
				{/if}
			{/if}

			{#if reachabilityMessage}
				<p
					class="border-border/60 text-muted-foreground mt-3 border-t pt-2 text-xs"
					data-testid="update-reachability"
				>
					{reachabilityMessage}
				</p>
			{/if}
		</div>

		<!-- Platform-layer and kept-back packages: stated, never offered. The device
		     refuses to install either, so this band carries NO action control. -->
		{#if withheld.length > 0}
			<div
				class="bg-muted/20 rounded-lg border border-dashed p-3"
				data-testid="update-platform-band"
				role="status"
			>
				<p class="text-sm font-medium">
					{m["settings.updates.layer.platformBand"]()}
				</p>
				<ul class="mt-1.5 space-y-1">
					{#each withheld as pkg (pkg.name)}
						<li class="text-muted-foreground text-xs break-words">
							<span class="text-foreground/80 font-mono">{pkg.name}</span>
							{#if pkg.kept_back}
								<span>— {m["settings.updates.layer.keptBack"]()}</span>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if inProgress}
			<div class="space-y-2" aria-live="polite">
				<div class="flex items-center gap-2 text-sm font-medium">
					<RefreshCw class="text-primary size-4 motion-safe:animate-spin" />
					{m["settings.dialogs.updating"]()}
				</div>
				<Progress value={progressValue ?? 100} />
			</div>
		{:else if starting}
			<div class="flex items-center gap-2 text-sm font-medium" aria-live="polite">
				<RefreshCw class="text-primary size-4 motion-safe:animate-spin" />
				{m["network.os.applying"]()}
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
								? m["general.updateNoProgress"]()
								: m["general.updateStartRefused"]()}
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
						<p class="text-sm font-medium">{m["general.updateCheckRefused"]()}</p>
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

			{#if failed || preflightFailed}
				<Button
					aria-busy={checking}
					class="w-full gap-2"
					disabled={checking}
					onclick={doCheck}
					variant="outline"
					data-testid="update-retry"
				>
					<RefreshCw class="size-4 {checking ? 'motion-safe:animate-spin' : ''}" />
					{m["general.retryUpdateCheck"]()}
				</Button>
			{:else}
				{#if actionableCount > 0}
					<Button
						class="w-full gap-2"
						data-testid="update-install"
						onclick={() => (confirmOpen = true)}
					>
						<Download class="size-4" />
						{m["general.updateButton"]()}
						<span aria-hidden="true" class="opacity-50">·</span>
						<span>
							{actionableCount}
							{actionableCount === 1 ? m["general.package"]() : m["general.packages"]()}
						</span>
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
					{checking ? m["general.checkingForUpdates"]() : m["general.checkForUpdates"]()}
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
	primaryLabel={m["general.updateButton"]()}
	title={m["general.areYouSure"]()}
>
	<p class="text-muted-foreground text-sm leading-relaxed">{m["general.updateConfirmation"]()}</p>
</AppDialog>
