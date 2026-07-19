<!--
  UpdatesDialog.svelte — software update review + install (Task 26).

  Shows the available package count and download size from live status. Install
  is a destructive action: it routes through a confirmation AppDialog before
  calling the system RPC (startUpdate). While an update is running, a progress
  indicator replaces the install action and the dialog cannot start another.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { UpdateProgress } from '@ceraui/rpc/schemas';
import { Download, RefreshCw } from '@lucide/svelte';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { Progress } from '$lib/components/ui/progress';
import {
	confirmOperation,
	getOperationPhase,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { getAvailableUpdates, getUpdating } from '$lib/rpc/subscriptions.svelte';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

// `available_updates` is `false`/`null` (no updates / not yet checked) or the
// package summary object; narrow to the object so falsy sentinels read as zero.
const updates = $derived(getAvailableUpdates());
const updateInfo = $derived(
	updates && typeof updates === 'object' ? updates : undefined,
);
const count = $derived(updateInfo?.package_count ?? 0);
const size = $derived(updateInfo?.download_size ?? '');

const updating = $derived(getUpdating());
// In progress = literal true OR a progress object that hasn't resolved (result !== 0).
const isUpdating = $derived(
	updating === true ||
		(typeof updating === 'object' && updating !== null && updating.result !== 0),
);

// Best-effort percentage when a structured progress object is present.
const progressValue = $derived.by(() => {
	if (typeof updating !== 'object' || updating === null) return undefined;
	const p = updating as UpdateProgress;
	if (!p.total || p.total <= 0) return undefined;
	const done = (p.downloading ?? 0) + (p.unpacking ?? 0) + (p.setting_up ?? 0);
	return Math.min(100, Math.max(0, Math.round((100 * done) / (3 * p.total))));
});

let confirmOpen = $state(false);

// `update` op covers ONLY the brief start-dispatch window: it stays `pending`
// from the startUpdate dispatch until the first `updating` broadcast confirms it
// (or a `{ success: false }`/reject fails it with a calm toast). The progress UI
// below keeps reading the broadcast directly — it is NOT under this op's TTL.
const starting = $derived(getOperationPhase('update') === 'pending');

async function doInstall() {
	await osCommand({
		key: 'update',
		rpc: () => rpc.system.startUpdate(),
		failMessage: () => $LL.network.os.operationFailed(),
		busyMessage: () => $LL.network.os.deviceBusy(),
		// NO confirmOnResolve — the first `updating` broadcast confirms the start.
	});
}

let checking = $state(false);
let checkTimeout: ReturnType<typeof setTimeout> | undefined;
let checkBaseline: typeof updates = undefined;

async function doCheck() {
	if (checking || isUpdating) return;
	checking = true;
	checkBaseline = updates;
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

// A fresh available_updates broadcast (new object ref) confirms the check ran.
$effect(() => {
	if (checking && updates !== checkBaseline) {
		checking = false;
		clearTimeout(checkTimeout);
	}
});

$effect(() => () => clearTimeout(checkTimeout));

// Confirm the start-dispatch op once the first `updating` broadcast lands.
$effect(() => {
	if (getOperationPhase('update') !== 'pending') return;
	if (isUpdating) confirmOperation('update');
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
		<!-- Availability summary -->
		<div class="bg-muted/40 rounded-lg border p-4">
			{#if count > 0}
				<p class="text-2xl font-bold">
					{count}
					{count === 1 ? $LL.general.package() : $LL.general.packages()}
				</p>
				{#if size}
					<p class="text-muted-foreground mt-0.5 text-sm">{size}</p>
				{/if}
			{:else}
				<p class="text-lg font-semibold">{$LL.general.noUpdatesAvailable()}</p>
			{/if}
		</div>

		{#if isUpdating}
			<!-- In-progress (reads the live broadcast, not the start-dispatch op) -->
			<div class="space-y-2" aria-live="polite">
				<div class="flex items-center gap-2 text-sm font-medium">
					<RefreshCw class="text-primary size-4 motion-safe:animate-spin" />
					{$LL.settings.dialogs.updating()}
				</div>
				<Progress value={progressValue ?? 100} />
			</div>
		{:else if starting}
			<!-- Brief start-dispatch window before the first `updating` broadcast -->
			<div class="flex items-center gap-2 text-sm font-medium" aria-live="polite">
				<RefreshCw class="text-primary size-4 motion-safe:animate-spin" />
				{$LL.network.os.applying()}
			</div>
		{:else if count > 0}
			<!-- Install action (opens destructive confirmation) -->
			<Button class="w-full gap-2" onclick={() => (confirmOpen = true)}>
				<Download class="size-4" />
				{$LL.general.updateButton()}
			</Button>
		{/if}

		{#if !isUpdating && !starting}
			<!-- Manual re-check: re-runs the discovery pipeline on the device -->
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
