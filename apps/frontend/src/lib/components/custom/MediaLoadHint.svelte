<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { ChevronRight, FlaskConical } from '@lucide/svelte';
import type { Snippet } from 'svelte';
import { Button } from '$lib/components/ui/button';
import { deriveEncoderActivity, type EncoderLoadReading } from '$lib/streaming/encoder-load';
import { MEDIA_GROUP_LABELS, mediaCoreHintLabel, mediaLoadCoreCount } from '$lib/streaming/media-load';
import { cn } from '$lib/utils';
import LegacyEncoderStatus from './LegacyEncoderStatus.svelte';

interface Props {
	readonly reading: EncoderLoadReading;
	readonly density: 'panel' | 'inline';
	readonly compact: boolean;
	readonly headerAside?: Snippet;
	readonly stale: boolean;
	readonly onDetails: () => void;
}

const { reading, density, compact, headerAside, stale, onDetails }: Props = $props();
const groups = $derived(reading.blocks ?? []);
const count = $derived(mediaLoadCoreCount(groups));
const legacyEncoder = $derived(!groups.some((group) => group.block === 'rkvenc'));
const activity = $derived(deriveEncoderActivity(reading));
</script>

<!--
	`@container` sits on the GRID, never on this root: `container-type: inline-size`
	applies inline-size CONTAINMENT, so a contained element reports ZERO intrinsic
	width to its parent. On the root it zeroed the whole widget, header row included,
	and any content-sized parent starved it — in the Live cockpit's `flex-wrap`
	telemetry strip the cell collapsed to the 58px of its own "ENCODER" caption, the
	query then measured that 58px, and 19px columns garbled the headers into each
	other and split every reading into per-character lines. Scoped to the grid, the
	header row's max-content becomes this widget's content-derived floor.
-->
<div class={cn('min-w-0 space-y-1.5', density === 'panel' && !compact && 'bg-card rounded-xl border p-3.5')}
	data-testid="media-load-hint" data-core-count={count} data-stale={stale} data-density={density}>
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
		<p class="text-sm font-semibold">{m['settings.mediaLoad.title']()}</p>
		{#if !legacyEncoder}
			<span class={cn('text-xs', activity === 'encoding' && !stale ? 'text-primary' : 'text-muted-foreground')}
				data-testid="encoder-status-headline" data-activity={activity}>
				{activity === 'encoding' ? m['settings.deviceHealth.cores.headlineEncoding']() : activity === 'idle' ? m['settings.deviceHealth.cores.headlineIdle']() : m['settings.deviceHealth.cores.headlineUnreported']()}
			</span>
		{/if}
		<span class="text-muted-foreground text-xs">{m['settings.mediaLoad.coreCount']({ count })}</span>
		{#if reading.simulated}
			<span class="text-muted-foreground inline-flex items-center gap-1 text-xs" data-testid="encoder-cores-simulated">
				<FlaskConical class="size-3" aria-hidden={true} />{m['settings.deviceHealth.cores.simulated']()}
			</span>
		{/if}
		{#if stale}<span class="text-muted-foreground text-xs">{m['settings.mediaLoad.stale']()}</span>{/if}
		{@render headerAside?.()}
		<Button variant="ghost" size="sm" class="ms-auto" aria-haspopup="dialog" onclick={onDetails} data-testid="open-media-load-dialog">
			{m['settings.mediaLoad.details']()}<ChevronRight class="size-4 rtl:rotate-180" aria-hidden={true} />
		</Button>
	</div>
	{#if legacyEncoder}<LegacyEncoderStatus {reading} density="inline" compact />{/if}
	<div class="@container min-w-0">
		<!-- The four-up rung is `@4xl`, not `@3xl`: at 768px each of four columns holds
		     183px, which is under the width a full `fdbd0000` identity plus both
		     readings needs, so it bought a fourth column by ellipsing every row label. -->
		<div class="grid min-w-0 gap-x-4 gap-y-3 @xl:grid-cols-2 @4xl:grid-cols-4">
		{#each groups as group (group.block)}
			<section class="min-w-0" data-testid="media-load-group" data-block={group.block} data-core-count={group.cores.length}>
				<div class="mb-1 flex items-baseline justify-between gap-2 text-xs">
					<h4 class="font-medium">{group.block === 'rga' ? 'RGA' : resolveMessageKey(MEDIA_GROUP_LABELS[group.block])}</h4>
					<span class="text-muted-foreground">{m['settings.mediaLoad.coreCount']({ count: group.cores.length })}</span>
				</div>
				<!--
					`table-auto` + `whitespace-nowrap` readings, and the IDENTITY column is the
					only one that yields (`w-full max-w-0 truncate`). A reading is the thing this
					table exists to state, so it is never the part that breaks: under the previous
					`table-fixed` thirds a squeezed column wrapped `87.75%` down four lines as
					`87`/`.7`/`5%` and let a nowrap-less `Utilization` header bleed across `Load`.
					Nowrap columns cannot fall below their own header, so no header can overflow
					its cell, and the wrapper scrolls rather than letting anything overlap.
				-->
				<div class="min-w-0 overflow-x-auto border-t pt-1">
					<table class="w-full table-auto text-xs" aria-label={resolveMessageKey(MEDIA_GROUP_LABELS[group.block])}>
						<thead class="text-muted-foreground"><tr>
							<th scope="col" class="w-full max-w-0 text-start font-normal"><span class="sr-only">{resolveMessageKey(MEDIA_GROUP_LABELS[group.block])}</span></th>
							<th scope="col" class="ps-2 text-end font-normal whitespace-nowrap">{m['settings.mediaLoad.load']()}</th>
							{#if group.source !== 'rkrga'}<th scope="col" class="ps-2 text-end font-normal whitespace-nowrap">{m['settings.mediaLoad.utilization']()}</th>{/if}
						</tr></thead>
						<tbody>
						{#each group.cores as core (core.core)}
							<tr data-media-core={core.core}>
								<th scope="row" class="text-muted-foreground w-full max-w-0 truncate py-0.5 pe-2 text-start font-mono font-normal" title={core.core}><bdi>{mediaCoreHintLabel(core.core)}</bdi></th>
								<td class={cn('ps-2 text-end whitespace-nowrap', core.load !== null ? 'font-mono tabular-nums' : 'text-muted-foreground', (stale || core.load === 0) && 'text-muted-foreground', !stale && core.load !== null && core.load > 0 && 'text-primary')} data-metric="load">
									{core.load === null ? m['settings.mediaLoad.unknown']() : `${core.load.toFixed(2)}%`}
								</td>
								{#if group.source !== 'rkrga'}
								<td class={cn('ps-2 text-end whitespace-nowrap', core.utilization !== null ? 'font-mono tabular-nums' : 'text-muted-foreground', (stale || core.utilization === 0) && 'text-muted-foreground')} data-metric="utilization">
									{core.utilization === null ? m['settings.mediaLoad.unknown']() : `${core.utilization.toFixed(2)}%`}
								</td>
								{/if}
							</tr>
						{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/each}
		</div>
	</div>
</div>
