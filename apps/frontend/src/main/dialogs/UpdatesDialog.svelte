<!--
  UpdatesDialog.svelte — software updates (Task 26, Todo 41).

  The legacy Packages section (`updates/PackagesSection.svelte`) reviews and
  installs packages from the ONE update state machine. Todo 41 adds the update
  orchestrator's surfaces around it: System, Slots, Automation, Cellular and
  Connection, read through ONE `createUpdateSurface()` on every open, plus the
  legacy notice, the credentials band and a current-activity line from the live
  `update_orchestrator` push. Which sections render is the image's capability
  file's answer (`updateCapabilityView`), never a guess. There is no
  certificate-expiry countdown, because nothing on the wire carries the
  certificate's expiry date.

  Every conclusion the dialog draws is the device's evidence, never a reply's
  absence or a clock (round-3 review C): action outcomes come from the action
  machine, "no newer system image" from a check this dialog saw complete
  (`surface.osNothingNewer`), and a settings save whose reply was lost is "not
  confirmed" (`SettingsSaveBand`).
-->
<script lang="ts">
import { formatPercent } from '@ceraui/i18n/formatters';
import { getLocale, m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { Info, RefreshCw, RotateCw, ShieldAlert } from '@lucide/svelte';
import { untrack } from 'svelte';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { Progress } from '$lib/components/ui/progress';
import { Skeleton } from '$lib/components/ui/skeleton';
import { getUpdateOrchestratorState } from '$lib/rpc/subscriptions.svelte';
import { transportCredentialsRejected } from '$lib/updates/update-bands';
import { followDeviceState } from '$lib/updates/update-device-follow.svelte';
import { dialogActivityPhase } from '$lib/updates/update-dialog-view';
import { createUpdateSurface } from '$lib/updates/update-surface.svelte';
import {
	etaMinutes,
	formatUpdateTime,
	phaseLabelKey,
	progressPercent,
	updateCapabilityView,
} from '$lib/updates/update-view';

import ActionOutcomeList from './updates/ActionOutcomeList.svelte';
import AutomationSection from './updates/AutomationSection.svelte';
import ConnectionSection from './updates/ConnectionSection.svelte';
import PackagesSection from './updates/PackagesSection.svelte';
import SettingsSaveBand from './updates/SettingsSaveBand.svelte';
import SlotsSection from './updates/SlotsSection.svelte';
import SystemSection from './updates/SystemSection.svelte';
import UpdateCellularSection from './updates/UpdateCellularSection.svelte';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const surface = createUpdateSurface();
const locale = $derived(getLocale());
const orchestrator = $derived(getUpdateOrchestratorState());
const view = $derived(updateCapabilityView(surface.capabilities));
const settings = $derived(surface.settings);
const details = $derived(surface.details);

// Read on every OPEN: the dialog stays mounted, and every one of these facts
// can change between two openings. The read and the reset write only the
// surface's own state, which nothing in this effect reads.
$effect(() => {
	if (open) untrack(() => void surface.load());
	else untrack(() => surface.reset());
});

// A moved phase, or a session restored after a dropped link, re-pulls what an
// open dialog shows (`update-device-follow.svelte.ts`).
followDeviceState(surface, () => ({ open, phase: orchestrator?.phase }));

// "Legacy" is only claimed once the device has ANSWERED with its capabilities;
// a read that failed is the details band's to report, not a statement about
// the image.
const legacyNotice = $derived(surface.loaded && surface.capabilities !== undefined && view.legacy);
const credentialsRejected = $derived(transportCredentialsRejected(details));
const activityPhase = $derived(dialogActivityPhase(orchestrator, view.system));
const activityPercent = $derived(activityPhase ? progressPercent(orchestrator) : undefined);
const activityEta = $derived(activityPhase ? etaMinutes(orchestrator?.progress?.etaSeconds) : undefined);
const nextPackageCheck = $derived(formatUpdateTime(details?.checks.packages.nextAttemptAt, locale));
</script>

<AppDialog
	bind:open
	description={m["settings.index.updatesDesc"]()}
	hideFooter
	icon={RefreshCw}
	title={m["settings.index.updates"]()}
>
	<div class="space-y-7">
		{#if credentialsRejected}
			<div
				class="border-status-warning/60 bg-status-warning/10 flex items-start gap-2.5 rounded-lg border p-3"
				data-testid="update-credentials-rejected"
				role="status"
			>
				<ShieldAlert aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
				<div class="min-w-0 space-y-0.5">
					<p class="text-sm font-medium">{m['settings.updates.credentials.rejectedTitle']()}</p>
					<p class="text-muted-foreground text-sm">{m['settings.updates.credentials.rejectedBody']()}</p>
				</div>
			</div>
		{/if}

		{#if legacyNotice}
			<div
				class="border-border bg-muted/40 flex items-start gap-2.5 rounded-lg border p-3"
				data-testid="update-legacy-notice"
				role="status"
			>
				<Info aria-hidden="true" class="text-muted-foreground mt-0.5 size-4 shrink-0" />
				<div class="min-w-0 space-y-0.5">
					<p class="text-sm font-medium">{m['settings.updates.legacy.title']()}</p>
					<p class="text-muted-foreground text-sm">{m['settings.updates.legacy.body']()}</p>
				</div>
			</div>
		{/if}

		{#if surface.detailsFailed}
			<div
				class="border-status-warning/40 bg-status-warning/10 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm"
				data-testid="update-details-failed"
				role="status"
			>
				<span class="min-w-0">{m['settings.updates.detailsFailed']()}</span>
				<Button onclick={() => void surface.load()} size="sm" variant="outline">
					<RotateCw aria-hidden="true" class="size-3.5" />
					{m['settings.updates.retryDetails']()}
				</Button>
			</div>
		{/if}

		<ActionOutcomeList bands={surface.bands} />

		{#if activityPhase}
			<div class="space-y-2" aria-live="polite" data-phase={activityPhase} data-testid="update-activity">
				<p class="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
					<span class="text-muted-foreground">{m['settings.updates.activity.title']()}</span>
					<span class="font-medium">{resolveMessageKey(phaseLabelKey(activityPhase))}</span>
				</p>
				{#if activityPercent !== undefined}
					<Progress value={activityPercent} />
					<p class="text-muted-foreground flex justify-between text-xs tabular-nums">
						<span>{formatPercent(locale)(activityPercent)}</span>
						{#if activityEta !== undefined}
							<span>{m['settings.updates.eta']({ minutes: activityEta })}</span>
						{/if}
					</p>
				{/if}
			</div>
		{/if}

		<PackagesSection nextCheck={nextPackageCheck} {surface} />

		{#if !surface.loaded}
			<div aria-busy="true" class="space-y-3" data-testid="update-details-loading" role="status">
				<span class="sr-only">{m['settings.updates.loading']()}</span>
				<Skeleton class="h-4 w-32" />
				<Skeleton class="h-20 w-full rounded-lg" />
			</div>
		{:else}
			{#if view.system}
				<SystemSection
					channel={settings?.channel}
					checking={surface.pending('check')}
					{details}
					installing={surface.pending('install')}
					nothingNewer={surface.osNothingNewer(orchestrator?.phase)}
					onCheck={() => void surface.checkNow()}
					onInstall={() => void surface.installNow()}
					wire={orchestrator}
				/>
			{/if}

			{#if view.slots}
				<SlotsSection slots={details === undefined ? undefined : details.slots} />
			{/if}

			<SettingsSaveBand outcome={surface.saveOutcome} />

			{#if settings}
				<AutomationSection
					onSave={surface.save}
					saving={surface.saving}
					{settings}
					system={view.system}
				/>
				<UpdateCellularSection
					approving={surface.pending('cellular')}
					onApprove={(id) => void surface.approveCellular(id)}
					onSave={surface.save}
					pending={details?.pendingCellular}
					saving={surface.saving}
					{settings}
					system={view.system}
				/>
			{:else if surface.settingsFailed}
				<div
					class="border-status-warning/40 bg-status-warning/10 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm"
					data-testid="update-settings-failed"
					role="status"
				>
					<span class="min-w-0">{m['settings.updates.settingsLoadFailed']()}</span>
					<Button onclick={() => void surface.load()} size="sm" variant="outline">
						<RotateCw aria-hidden="true" class="size-3.5" />
						{m['settings.updates.retryDetails']()}
					</Button>
				</div>
			{/if}

			{#if details}
				<ConnectionSection transport={details.transport} />
			{/if}
		{/if}
	</div>
</AppDialog>
