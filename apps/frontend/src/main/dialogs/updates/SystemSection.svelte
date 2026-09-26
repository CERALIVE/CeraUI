<!--
  SystemSection.svelte — the system image half of the Updates dialog (Todo 41).

  Presentational: the dialog owns the device reads and the actions, this section
  renders them. Rendered only on an image whose capability file declares the OS
  agent (`updateCapabilityView().system`); on every other image the legacy notice
  says why it is absent instead.

  Three facts are kept apart on purpose: what the board is RUNNING (the stamped
  release version, or an honest sentence when the image carries none), what is
  STAGED for the next restart, and what the channel OFFERS but has not been
  staged yet. "Applies after restart" is a property of the orchestrator's live
  phase, never inferred from a staged receipt alone — a receipt also exists
  while the new slot is being verified after the restart it waited for.
-->
<script lang="ts">
import { formatBytes, formatPercent } from '@ceraui/i18n/formatters';
import { getLocale, m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type {
	UpdateDetails,
	UpdateOrchestratorWireState,
	UpdateSettings,
} from '@ceraui/rpc/schemas';
import { RefreshCw } from '@lucide/svelte';

import Badge from '$lib/components/custom/Badge.svelte';
import { Button } from '$lib/components/ui/button';
import { Progress } from '$lib/components/ui/progress';
import { systemImagePhase } from '$lib/updates/update-dialog-view';
import {
	appliesAfterRestart,
	etaMinutes,
	formatUpdateTime,
	phaseLabelKey,
	progressPercent,
} from '$lib/updates/update-view';

interface Props {
	wire: UpdateOrchestratorWireState | undefined;
	details: UpdateDetails | undefined;
	channel: UpdateSettings['channel'] | undefined;
	checking: boolean;
	installing: boolean;
	onCheck: () => void;
	onInstall: () => void;
}

let { wire, details, channel, checking, installing, onCheck, onInstall }: Props = $props();

const locale = $derived(getLocale());
const os = $derived(details?.os);
const activation = $derived(systemImagePhase(wire));
const staging = $derived(activation === 'os-staging');
const percent = $derived(staging ? progressPercent(wire) : undefined);
const eta = $derived(staging ? etaMinutes(wire?.progress?.etaSeconds) : undefined);
const lastChecked = $derived(formatUpdateTime(details?.checks.os.lastSuccessAt, locale));
const nextCheck = $derived(formatUpdateTime(details?.checks.os.nextAttemptAt, locale));
// Only a candidate the channel offered and the orchestrator is holding can be
// installed by hand; anywhere else the device would refuse the request.
const installable = $derived(activation === 'os-available' && os?.candidate != null);
</script>

<section aria-labelledby="updates-system-heading" class="space-y-2.5" data-testid="updates-system">
	<h3 class="text-sm font-semibold" id="updates-system-heading">{m['settings.updates.system.title']()}</h3>

	<dl class="divide-border divide-y overflow-hidden rounded-lg border text-sm">
		<div class="flex items-start justify-between gap-4 px-4 py-3" data-testid="update-system-current">
			<dt class="text-muted-foreground shrink-0">{m['settings.updates.system.current']()}</dt>
			<dd class="min-w-0 text-end">
				{#if os?.bootedVersion}
					<span class="font-mono text-xs" dir="ltr">{os.bootedVersion}</span>
				{:else}
					<span class="text-muted-foreground text-xs" data-testid="update-system-version-unknown">
						{m['settings.updates.system.versionUnknown']()}
					</span>
				{/if}
			</dd>
		</div>

		{#if channel}
			<div class="flex items-center justify-between gap-4 px-4 py-3" data-testid="update-system-channel">
				<dt class="text-muted-foreground">{m['settings.updates.channel.title']()}</dt>
				<dd>{channel === 'beta' ? m['settings.updates.channel.beta']() : m['settings.updates.channel.stable']()}</dd>
			</div>
		{/if}

		{#if activation}
			<div
				class="flex items-start justify-between gap-4 px-4 py-3"
				data-phase={activation}
				data-testid="update-system-status"
			>
				<dt class="text-muted-foreground shrink-0">{m['settings.updates.system.status']()}</dt>
				<dd class="min-w-0 flex-1 space-y-2">
					<span class="flex flex-wrap items-center justify-end gap-2">
						<span>{resolveMessageKey(phaseLabelKey(activation))}</span>
						{#if appliesAfterRestart(activation)}
							<Badge
								data-testid="update-system-applies-after-restart"
								label={m['settings.updates.system.appliesAfterRestart']()}
								variant="info"
							/>
						{/if}
					</span>
					{#if percent !== undefined}
						<Progress value={percent} />
						<span class="text-muted-foreground flex justify-between text-xs tabular-nums">
							<span>{formatPercent(locale)(percent)}</span>
							{#if eta !== undefined}
								<span>{m['settings.updates.eta']({ minutes: eta })}</span>
							{/if}
						</span>
					{/if}
				</dd>
			</div>
		{/if}
	</dl>

	<div class="space-y-1 px-1 text-sm">
		{#if os?.staged}
			<p data-testid="update-system-staged">
				{m['settings.updates.system.staged']({ version: os.staged.version })}
			</p>
		{/if}
		{#if os?.candidate}
			<p data-testid="update-system-candidate">
				{m['settings.updates.system.available']({
					version: os.candidate.version,
					size: formatBytes(locale)(os.candidate.sizeBytes),
				})}
			</p>
		{:else if !os?.staged}
			<p class="text-muted-foreground" data-testid="update-system-no-candidate">
				{m['settings.updates.system.noCandidate']()}
			</p>
		{/if}
		{#if lastChecked}
			<p class="text-muted-foreground text-xs">{m['general.updateLastChecked']({ time: lastChecked })}</p>
		{/if}
		{#if nextCheck}
			<p class="text-muted-foreground text-xs">{m['settings.updates.nextCheck']({ time: nextCheck })}</p>
		{/if}
	</div>

	<div class="flex flex-col gap-2 sm:flex-row">
		{#if installable}
			<Button
				aria-busy={installing}
				class="flex-1 gap-2"
				data-testid="update-system-install"
				disabled={installing}
				onclick={onInstall}
			>
				{installing ? m['network.os.applying']() : m['settings.updates.system.installNow']()}
			</Button>
		{/if}
		<Button
			aria-busy={checking}
			class="flex-1 gap-2"
			data-testid="update-system-check"
			disabled={checking}
			onclick={onCheck}
			variant="outline"
		>
			<RefreshCw class="size-4 {checking ? 'motion-safe:animate-spin' : ''}" />
			{checking ? m['general.checkingForUpdates']() : m['settings.updates.system.checkNow']()}
		</Button>
	</div>
</section>
