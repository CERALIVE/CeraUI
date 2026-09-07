<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { FlaskConical } from '@lucide/svelte';
import LegacyEncoderStatus from '$lib/components/custom/LegacyEncoderStatus.svelte';
import type { EncoderLoadReading } from '$lib/streaming/encoder-load';
import { MEDIA_GROUP_LABELS, mediaLoadCoreCount } from '$lib/streaming/media-load';
import { cn } from '$lib/utils';

interface Props {
	readonly reading: EncoderLoadReading;
	readonly stale: boolean;
}
const { reading, stale }: Props = $props();
const groups = $derived(reading.blocks ?? []);
const legacyEncoder = $derived(!groups.some((group) => group.block === 'rkvenc'));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (This read-only scroll region needs keyboard focus; axe requires a focusable descendant of the dialog body.) -->
<div class="space-y-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
	role="region" aria-label={m['settings.mediaLoad.title']()} tabindex="0" data-testid="media-load-detail" data-stale={stale}>
	<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
		{#if groups.length}<span>{m['settings.mediaLoad.coreCount']({ count: mediaLoadCoreCount(groups) })}</span>{/if}
		{#if reading.simulated}
			<span class="inline-flex items-center gap-1"><FlaskConical class="size-3" aria-hidden={true} />{m['settings.deviceHealth.cores.simulated']()}</span>
		{/if}
		{#if stale}<span role="status">{m['settings.mediaLoad.stale']()}</span>{/if}
		<span>{m['settings.mediaLoad.sample']()}: <span class="font-mono" dir="ltr">{reading.updatedAt === null ? m['settings.mediaLoad.unknown']() : new Date(reading.updatedAt).toISOString()}</span></span>
	</div>
	{#if groups.some((group) => group.source === 'mpp-service')}
		<div class="space-y-2 border-b pb-4 text-xs leading-relaxed text-muted-foreground" data-testid="media-accounting-note">
			<p>{m['settings.mediaLoad.accounting']()}</p>
			<p>{m['settings.mediaLoad.ownershipNote']()}</p>
		</div>
	{/if}
	{#if legacyEncoder}
		<LegacyEncoderStatus {reading} compact showDecoders={groups.length === 0} />
		<p class="text-xs leading-relaxed text-muted-foreground">{m['settings.mediaLoad.legacy']()}</p>
		{#if reading.source}<p class="font-mono text-xs text-muted-foreground" dir="ltr">{reading.source}</p>{/if}
	{/if}
	{#each groups as group (group.block)}
		<section class="space-y-2" data-testid="media-detail-group" data-block={group.block}>
			<header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h3 class="text-sm font-semibold">{resolveMessageKey(MEDIA_GROUP_LABELS[group.block])}</h3>
				<span class="text-xs text-muted-foreground">{m['settings.mediaLoad.coreCount']({ count: group.cores.length })}</span>
			</header>
			<p class="font-mono text-xs text-muted-foreground" dir="ltr">{group.block} · {group.source}</p>
			<ul class="divide-border divide-y border-y">
				{#each group.cores as core (core.core)}
					<li class="space-y-3 py-3" data-testid="media-detail-core" data-core={core.core}>
						<p class="break-all font-mono text-xs" dir="ltr">{core.core}</p>
						<dl class="grid grid-cols-2 gap-x-5 gap-y-3 text-xs sm:grid-cols-[1fr_1fr_2fr]">
							<div class="min-w-0 space-y-1">
								<dt class="truncate text-muted-foreground">{m['settings.mediaLoad.load']()}</dt>
								<dd class={cn(core.load !== null && 'font-mono text-base tabular-nums whitespace-nowrap', stale && 'text-muted-foreground')} data-metric="load">
									{core.load === null ? m['settings.mediaLoad.unknown']() : `${core.load.toFixed(2)}%`}
								</dd>
							</div>
							<div class="min-w-0 space-y-1">
								<dt class="truncate text-muted-foreground">{m['settings.mediaLoad.utilization']()}</dt>
								<dd class={cn(core.utilization !== null && 'font-mono text-base tabular-nums whitespace-nowrap', stale && 'text-muted-foreground')} data-metric="utilization">
									{group.source === 'rkrga' ? m['settings.mediaLoad.notPublished']() : core.utilization === null ? m['settings.mediaLoad.unknown']() : `${core.utilization.toFixed(2)}%`}
								</dd>
							</div>
							<div class="col-span-2 space-y-1 sm:col-span-1">
								<dt class="text-muted-foreground">{m['settings.mediaLoad.sessions']()}</dt>
								<dd data-testid="media-core-sessions">
									{#if group.source === 'rkrga'}{m['settings.mediaLoad.notPublished']()}
									{:else if core.sessions === null}{m['settings.mediaLoad.unknown']()}
									{:else if core.sessions.length === 0}{m['settings.mediaLoad.noSessions']()}
									{:else}
										<ul class="flex flex-wrap gap-x-4 gap-y-1">
											{#each core.sessions as owner (`${owner.pid}:${owner.index}`)}
												<li class="font-mono tabular-nums" dir="ltr">{m['settings.mediaLoad.owner']({ pid: owner.pid, index: owner.index })}</li>
											{/each}
										</ul>
									{/if}
								</dd>
							</div>
						</dl>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</div>
