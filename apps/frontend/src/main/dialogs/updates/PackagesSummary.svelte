<!--
  PackagesSummary.svelte — what the ONE update state machine says about the
  device's packages (Task 26, Todo 14, Todo 24), extracted from UpdatesDialog.

  Every sentence is the device's own state: an outcome (preflight refusal,
  failure, success), the classified available set, a check that could not
  reach a verdict, or "System is up to date", which needs `idle` WITH a
  `checked_at` stamp (a completed discovery found nothing; round-3 sweep C9).
  A check running says so; anything else says the device has not reported a
  completed check yet, never "up to date". Platform-layer and kept-back
  packages are stated, never offered.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { UpdatePreflightReason, UpdateState } from '@ceraui/rpc/schemas';
import { AlertTriangle, CheckCircle2 } from '@lucide/svelte';

import { checkedAtOf, isWithheld } from '$lib/updates/legacy-packages';
import { actionablePackageOrigins } from '$lib/updates/update-dialog-view';

interface Props {
	updateState: UpdateState | undefined;
	/** The next scheduled package check, already formatted. */
	nextCheck: string | undefined;
}

let { updateState, nextCheck }: Props = $props();

const available = $derived(updateState?.kind === 'available' ? updateState : undefined);
const count = $derived(available?.package_count ?? 0);
const size = $derived(available?.download_size ?? '');
const version = $derived(available?.identity.version ?? '');
const classified = $derived(available?.packages ?? []);
const withheld = $derived(classified.filter(isWithheld));
const listedPackages = $derived(
	classified.length > 0
		? classified.filter((pkg) => !isWithheld(pkg)).map((pkg) => pkg.name)
		: (available?.identity.packages ?? []),
);
const packageOrigins = $derived(actionablePackageOrigins(classified));

const failed = $derived(updateState?.kind === 'failed' ? updateState : undefined);
const succeeded = $derived(updateState?.kind === 'success');
const preflightFailed = $derived(updateState?.kind === 'update_preflight_failed' ? updateState : undefined);
const cleanupWarning = $derived(updateState?.kind === 'success' ? updateState.cleanup_warning : undefined);
const checkFailed = $derived(updateState?.kind === 'check_failed' ? updateState : undefined);
const inProgress = $derived(updateState?.kind === 'downloading' || updateState?.kind === 'installing');
const lastCheckedAt = $derived(checkedAtOf(updateState));
const lastCheckedLabel = $derived(lastCheckedAt === undefined ? '' : new Date(lastCheckedAt).toLocaleTimeString());
const upToDate = $derived(updateState?.kind === 'idle' && lastCheckedAt !== undefined);
const reachability = $derived(updateState && 'reachability' in updateState ? updateState.reachability : undefined);

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

// One muted line, and only when the answer is not the ordinary healthy one. A
// captive portal outranks the family verdict: it explains WHY neither reached.
const reachabilityMessage = $derived.by(() => {
	if (reachability === undefined) return undefined;
	if (reachability.ipv4 === 'captive' || reachability.ipv6 === 'captive') {
		return m["settings.updates.reachability.captivePortal"]();
	}
	if (reachability.used === 'ipv4') return m["settings.updates.reachability.ipv4Only"]();
	if (reachability.used === 'ipv6') return m["settings.updates.reachability.ipv6Only"]();
	return undefined;
});

// `failed.reason` is free-form (often an apt stderr line): a known token
// resolves to keyed copy, anything else to ONE honest sentence pointing at the
// in-app log viewer; the raw value goes to the console and nowhere else.
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
	failed === undefined ? undefined : (FAILED_REASON_COPY[failed.reason]?.() ?? m["settings.updates.failedReasonGeneric"]()),
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
</script>

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
				<p class="text-destructive text-lg font-semibold">{m["general.updateFailed"]()}</p>
				<p class="text-muted-foreground mt-1 text-sm break-words" data-testid="update-failed-reason">
					{failureMessage}
				</p>
			</div>
		</div>
	{:else if succeeded}
		<div class="flex items-start gap-2" data-testid="update-succeeded">
			<CheckCircle2 class="text-status-success mt-0.5 size-5 shrink-0" />
			<div class="min-w-0">
				<p class="text-status-success text-lg font-semibold">{m["general.updateComplete"]()}</p>
				<p class="text-muted-foreground mt-1 text-sm">{m["general.updateInstalledDetail"]()}</p>
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
			<p class="text-muted-foreground mt-1 font-mono text-xs" data-testid="update-version">{version}</p>
		{/if}
		{#if listedPackages.length > 0}
			<p class="text-muted-foreground mt-1 text-xs break-words" data-testid="update-packages">
				{listedPackages.join(', ')}
			</p>
		{/if}
		{#if packageOrigins.length > 0}
			<p class="text-muted-foreground mt-1 text-xs break-words" data-testid="update-package-origins">
				{m['settings.updates.packages.origins']({ origins: packageOrigins.join(', ') })}
			</p>
		{/if}
	{:else if checkFailed}
		<div class="flex items-start gap-2" data-testid="update-check-failed">
			<AlertTriangle class="text-status-warning mt-0.5 size-5 shrink-0" />
			<div class="min-w-0">
				<p class="text-status-warning text-lg font-semibold">{m["general.updateCheckFailed"]()}</p>
				{#if checkFailureMessage}
					<p class="text-muted-foreground mt-1 text-sm break-words" data-testid="update-check-failed-reason">
						{checkFailureMessage}
					</p>
				{/if}
			</div>
		</div>
	{:else if upToDate}
		<p class="text-lg font-semibold">{m["general.noUpdatesAvailable"]()}</p>
		<!-- Without this the operator cannot tell a successful check that found
		     nothing from a button that did nothing at all. -->
		<p class="text-muted-foreground mt-1 text-sm" data-testid="update-last-checked">
			{m["general.updateLastChecked"]({ time: lastCheckedLabel })}
		</p>
	{:else if updateState?.kind === 'checking' || inProgress}
		<p class="text-lg font-semibold" data-testid="update-status-busy">
			{inProgress ? m["settings.dialogs.updating"]() : m["general.checkingForUpdates"]()}
		</p>
	{:else}
		<p class="text-muted-foreground text-sm break-words" data-testid="update-status-unknown" role="status">
			{m['settings.updates.packages.notChecked']()}
		</p>
	{/if}

	{#if nextCheck}
		<p class="text-muted-foreground mt-1 text-xs" data-testid="update-next-check">
			{m['settings.updates.nextCheck']({ time: nextCheck })}
		</p>
	{/if}

	{#if reachabilityMessage}
		<p class="border-border/60 text-muted-foreground mt-3 border-t pt-2 text-xs" data-testid="update-reachability">
			{reachabilityMessage}
		</p>
	{/if}
</div>

<!-- Platform-layer and kept-back packages: stated, never offered. -->
{#if withheld.length > 0}
	<div class="bg-muted/20 rounded-lg border border-dashed p-3" data-testid="update-platform-band" role="status">
		<p class="text-sm font-medium">{m["settings.updates.layer.platformBand"]()}</p>
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
