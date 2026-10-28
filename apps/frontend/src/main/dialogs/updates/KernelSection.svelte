<script lang="ts">
import { formatBytes, formatPercent } from '@ceraui/i18n/formatters';
import { getLocale, m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { UpdateDetails, UpdateOrchestratorWireState } from '@ceraui/rpc/schemas';
import { RefreshCw } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { Progress } from '$lib/components/ui/progress';
import { kernelInstallable, kernelReasonKey, kernelUpdatePhase } from '$lib/updates/kernel-update-view';
import { etaMinutes, isUpdateBusy, phaseLabelKey, progressPercent } from '$lib/updates/update-view';

interface Props {
	wire: UpdateOrchestratorWireState | undefined;
	kernel: UpdateDetails['kernel'];
	ready: boolean;
	checking: boolean;
	installing: boolean;
	onCheck: () => void;
	onInstall: () => void;
}

let { wire, kernel, ready, checking, installing, onCheck, onInstall }: Props = $props();

const locale = $derived(getLocale());
const phase = $derived(kernelUpdatePhase(wire, kernel));
const recordPhase = $derived(kernelUpdatePhase(undefined, kernel));
const working = $derived(phase === 'kernel-downloading' || phase === 'kernel-staging');
const busy = $derived(isUpdateBusy(wire) || phase === 'kernel-staged' || phase === 'kernel-verifying');
const installable = $derived(ready && kernelInstallable(wire, kernel));
const version = $derived(working
	? kernel?.candidate?.version ?? (recordPhase === phase ? kernel?.version : undefined)
	: kernel?.version ?? kernel?.candidate?.version);
const percent = $derived(working && wire?.phase === phase ? progressPercent(wire) : undefined);
const eta = $derived(percent !== undefined ? etaMinutes(wire?.progress?.etaSeconds) : undefined);
const reason = $derived(wire && wire.phase === phase
	? wire.failure_reason ?? (recordPhase === phase ? kernel?.reason : null)
	: kernel?.reason);
const showReason = $derived(reason != null || phase === 'kernel-rolled-back' || phase === 'kernel-failed');
</script>

<section
	aria-labelledby="updates-kernel-heading"
	class="space-y-2.5"
	data-phase={phase ?? 'unknown'}
	data-testid="updates-kernel"
>
	<h3 class="text-sm font-semibold" id="updates-kernel-heading">{m['settings.updates.kernel.title']()}</h3>

	<dl class="divide-border divide-y overflow-hidden rounded-lg border text-sm">
		<div class="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:justify-between sm:gap-4">
			<dt class="text-muted-foreground">{m['settings.updates.system.status']()}</dt>
			<dd aria-live="polite" class="min-w-0 flex-1 space-y-2 sm:text-end">
				<p class="font-medium" data-testid="update-kernel-status">
					{phase ? resolveMessageKey(phaseLabelKey(phase)) : m['settings.updates.kernel.unknown']()}
				</p>
			{#if phase === 'kernel-staged'}
				<p class="text-muted-foreground" data-testid="update-kernel-restart">
					{m['settings.updates.kernel.appliesAfterRestart']()}
				</p>
			{/if}
			{#if showReason}
				<p class="text-muted-foreground" data-testid="update-kernel-reason">
					{resolveMessageKey(kernelReasonKey(reason))}
				</p>
			{/if}
			{#if percent !== undefined}
				<div class="space-y-2">
					<Progress value={percent} />
					<span class="text-muted-foreground flex justify-between text-xs tabular-nums">
						<span>{formatPercent(locale)(percent)}</span>
						{#if eta !== undefined}
							<span>{m['settings.updates.eta']({ minutes: eta })}</span>
						{/if}
					</span>
				</div>
			{/if}
			</dd>
		</div>
		<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3" data-testid="update-kernel-current">
			<dt class="text-muted-foreground">{m['settings.updates.system.current']()}</dt>
			<dd class="min-w-0 break-all text-end font-mono text-xs" dir="ltr">
				{kernel?.booted?.version ?? m['settings.updates.system.versionUnknown']()}
			</dd>
		</div>
		{#if version}
			<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
				<dt class="text-muted-foreground">{m['settings.updates.kernel.updateVersion']()}</dt>
				<dd class="min-w-0 break-all text-end font-mono text-xs" data-testid="update-kernel-version" dir="ltr">{version}</dd>
			</div>
		{/if}
	</dl>

	{#if kernel?.candidate}
		<p class="px-1 text-sm" data-testid="update-kernel-candidate">
			{m['settings.updates.system.available']({
				version: kernel.candidate.version,
				size: formatBytes(locale)(kernel.candidate.sizeBytes),
			})}
		</p>
	{/if}

	<div class="flex flex-col gap-2 sm:flex-row">
		<Button
			aria-busy={installing}
			class="h-auto flex-1 whitespace-normal py-1"
			data-testid="update-kernel-install"
			disabled={installing || !installable}
			onclick={onInstall}
		>
			{installing ? m['network.os.applying']() : m['settings.updates.kernel.installNow']()}
		</Button>
		<Button
			aria-busy={checking}
			class="flex-1 gap-2"
			data-testid="update-kernel-check"
			disabled={!ready || checking || installing || busy}
			onclick={onCheck}
			variant="outline"
		>
			<RefreshCw aria-hidden="true" class="size-4 {checking ? 'motion-safe:animate-spin' : ''}" />
			{checking ? m['general.checkingForUpdates']() : m['settings.updates.system.checkNow']()}
		</Button>
	</div>
</section>
