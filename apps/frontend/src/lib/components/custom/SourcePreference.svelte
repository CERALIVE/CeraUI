<!--
  SourcePreference.svelte — operator-ordered source preference + fallback state (Task 11).

  A presentational surface over the video capture sources: each source shows its
  live fallback state (active / lost / failed-over), and the operator reorders
  them with up/down controls (no drag — kiosk/touch/RTL safe). The order is the
  operator's switch-back preference; a non-blocking toast announces a sticky
  auto-failover when the engine leaves a lost preferred source.

  Presentational: devices, order, activeInput and the derived failover are props;
  reordering and persistence are the parent's job (`onReorder`). Every visual is
  CSS-driven (badges static, sync glyph via FieldSyncIndicator) so the e-ink
  freeze stills it without special handling.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { CaptureDevice } from '@ceraui/rpc/schemas';
import { ChevronDown, ChevronUp, RadioTower, TriangleAlert, Zap } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import FieldSyncIndicator from '$lib/components/custom/FieldSyncIndicator.svelte';
import { Button } from '$lib/components/ui/button';
import {
	type FailoverEvent,
	type SourceState,
	deriveSourceState,
	failoverKey,
	orderByPreference,
} from '$lib/streaming/source-preference';

interface Props {
	devices?: CaptureDevice[];
	activeInput?: string | undefined;
	order?: string[];
	failover?: FailoverEvent | null;
	syncField?: string;
	onReorder?: (id: string, direction: 'up' | 'down') => void;
}

let {
	devices = [],
	activeInput,
	order = [],
	failover = null,
	syncField = 'source_preference',
	onReorder,
}: Props = $props();

const ordered = $derived(orderByPreference(devices, order));

function nameOf(id: string): string {
	return devices.find((device) => device.input_id === id)?.display_name ?? id;
}

function capsLabel(device: CaptureDevice): string {
	if (!device.caps?.length) return '';
	return device.caps
		.slice(0, 2)
		.map((cap) => {
			const res = cap.width && cap.height ? `${cap.width}\u00d7${cap.height}` : '';
			const fps = cap.framerate ? `@${cap.framerate}` : '';
			return [res, fps].filter(Boolean).join(' ');
		})
		.filter(Boolean)
		.join(' \u00b7 ');
}

// Fire exactly one non-blocking toast per distinct sticky-failover transition.
// Guard-before-write keeps the self-referential effect from looping.
let lastFailoverKey = $state<string | null>(null);
$effect(() => {
	if (!failover) return;
	const key = failoverKey(failover);
	if (key === lastFailoverKey) return;
	lastFailoverKey = key;
	const description = `${$LL.live.sourcePreference.failover.reasonSourceLost({
		name: nameOf(failover.from),
		to: nameOf(failover.to),
	})} ${$LL.live.sourcePreference.failover.sticky()}`;
	toast.warning($LL.live.sourcePreference.failover.title(), { description });
});

const badge: Record<
	Exclude<SourceState, 'idle'>,
	{ class: string; label: () => string }
> = $derived({
	active: {
		class: 'bg-status-success/15 text-status-success',
		label: () => $LL.live.sourcePreference.states.active(),
	},
	lost: {
		class: 'bg-status-warning/15 text-status-warning',
		label: () => $LL.live.sourcePreference.states.lost(),
	},
	'failed-over': {
		class: 'bg-status-error/15 text-status-error',
		label: () => $LL.live.sourcePreference.states.failedOver(),
	},
});
</script>

<div class="space-y-3" data-testid="source-preference">
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<RadioTower aria-hidden={true} class="text-primary size-4 shrink-0" />
			<span class="text-sm font-medium">{$LL.live.sourcePreference.title()}</span>
		</div>
		<FieldSyncIndicator
			appliedLabel={$LL.live.sourcePreference.sync.applied()}
			applyingLabel={$LL.live.sourcePreference.sync.applying()}
			failedLabel={$LL.live.sourcePreference.sync.failed()}
			field={syncField}
		/>
	</div>

	<p class="text-muted-foreground text-xs">{$LL.live.sourcePreference.description()}</p>

	{#if ordered.length === 0}
		<div class="bg-muted/40 rounded-lg border px-4 py-6 text-center">
			<p class="text-muted-foreground text-sm">{$LL.live.sourcePreference.empty()}</p>
		</div>
	{:else}
		<ul class="space-y-2">
			{#each ordered as device, index (device.input_id)}
				{@const state = deriveSourceState(
					device.input_id,
					activeInput,
					device.lost === true,
					failover,
				)}
				{@const caps = capsLabel(device)}
				<li
					class={`flex items-center gap-3 rounded-lg border p-3 ${
						state === 'lost'
							? 'border-status-warning/40 bg-status-warning/5'
							: state === 'failed-over'
								? 'border-status-error/40 bg-status-error/5'
								: state === 'active'
									? 'border-status-success/40 bg-status-success/5'
									: 'bg-card'
					}`}
					data-input-id={device.input_id}
					data-state={state}
				>
					<span
						class="text-muted-foreground w-5 shrink-0 text-center font-mono text-xs tabular-nums"
						aria-label={$LL.live.sourcePreference.rankLabel({ rank: index + 1 })}
					>
						{index + 1}
					</span>

					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<span class="truncate text-sm font-medium">{device.display_name}</span>
							{#if state !== 'idle'}
								<span
									class={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badge[state].class}`}
									data-state-badge={state}
								>
									{#if state === 'active'}
										<Zap aria-hidden={true} class="size-3" />
									{:else}
										<TriangleAlert aria-hidden={true} class="size-3" />
									{/if}
									{badge[state].label()}
								</span>
							{/if}
						</div>
						{#if caps}
							<p class="text-muted-foreground mt-0.5 truncate font-mono text-xs">{caps}</p>
						{/if}
						{#if state === 'lost'}
							<p class="text-status-warning mt-1 text-xs">
								{$LL.live.sourcePreference.lostHint()}
							</p>
						{:else if state === 'failed-over'}
							<p class="text-status-error mt-1 text-xs">
								{$LL.live.sourcePreference.failedOverHint()}
							</p>
						{/if}
					</div>

					<div class="flex shrink-0 flex-col gap-1">
						<Button
							aria-label={$LL.live.sourcePreference.moveUp({ name: device.display_name })}
							class="size-11"
							data-move-up={device.input_id}
							disabled={index === 0}
							onclick={() => onReorder?.(device.input_id, 'up')}
							size="icon"
							variant="outline"
						>
							<ChevronUp aria-hidden={true} class="size-4" />
						</Button>
						<Button
							aria-label={$LL.live.sourcePreference.moveDown({ name: device.display_name })}
							class="size-11"
							data-move-down={device.input_id}
							disabled={index === ordered.length - 1}
							onclick={() => onReorder?.(device.input_id, 'down')}
							size="icon"
							variant="outline"
						>
							<ChevronDown aria-hidden={true} class="size-4" />
						</Button>
					</div>
				</li>
			{/each}
		</ul>

		<p class="text-muted-foreground border-t pt-3 text-xs">
			{$LL.live.sourcePreference.stickyNote()}
		</p>
	{/if}
</div>
