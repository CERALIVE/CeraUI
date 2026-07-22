<!--
  UpdatesDialog.svelte — software update review + install (Task 26).

  Shows the available package count and download size from live status. Install
  is a destructive action: it routes through a confirmation AppDialog before
  calling the system RPC (startUpdate). While an update is running, a progress
  indicator replaces the install action and the dialog cannot start another.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { AlertTriangle, Download, RefreshCw } from '@lucide/svelte';

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

async function doInstall() {
	await osCommand({
		key: 'update',
		rpc: () => rpc.system.startUpdate(),
		failMessage: () => $LL.network.os.operationFailed(),
		busyMessage: () => $LL.network.os.deviceBusy(),
	});
}

let checking = $state(false);
let checkTimeout: ReturnType<typeof setTimeout> | undefined;

async function doCheck() {
	if (checking || inProgress) return;
	checking = true;
	clearTimeout(checkTimeout);
	checkTimeout = setTimeout(() => {
		checking = false;
	}, 30_000);
	const res = await rpc.system.checkForUpdates();
	if (!res.success) {
		checking = false;
		clearTimeout(checkTimeout);
	}
}

// A transition OUT of `checking`/`failed` confirms the re-check ran.
$effect(() => {
	if (checking && updateState?.kind !== 'checking' && updateState?.kind !== 'failed') {
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
			{:else}
				<p class="text-lg font-semibold">{$LL.general.noUpdatesAvailable()}</p>
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
		{:else if failed}
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
		{:else if count > 0}
			<Button class="w-full gap-2" onclick={() => (confirmOpen = true)}>
				<Download class="size-4" />
				{$LL.general.updateButton()}
			</Button>
		{/if}

		{#if !inProgress && !starting && !failed}
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
