<!--
  CompositionCard.svelte — the PiP/PbP operator surface for the engine's two-leg
  `rgacompositor` session mode.

  VISIBILITY IS THE PARENT'S. This component renders whenever it is mounted;
  `IdleCockpit` mounts it only while the engine's `get-capabilities.features`
  array carries the `composition` token, so an engine that cannot compose leaves
  ZERO nodes in the DOM rather than a disabled card — there is no capability
  being withheld to explain, so a greyed control would imply one that exists.

  It owns its `streaming.setConfig` write (the `SourceSection` precedent) and
  nothing else: the secondary picker is the SAME `sources.sources` list the
  source card renders, filtered to `origin === 'capture'` and to rows that are
  not already the primary.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type {
	CaptureStreamSource,
	CompositionConfig,
	CompositionLayout,
	ConfigMessage,
	SourcesMessage,
	StartFailureCaptureCause,
} from '@ceraui/rpc/schemas';
import {
	COMPOSITION_ALPHA_MAX,
	COMPOSITION_ALPHA_MIN,
	COMPOSITION_LAYOUT_DEFAULT,
	COMPOSITION_LAYOUTS,
} from '@ceraui/rpc/schemas';
import { Activity, PictureInPicture2 } from '@lucide/svelte';

import * as Card from '$lib/components/ui/card';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { Slider } from '$lib/components/ui/slider';
import { Switch } from '$lib/components/ui/switch';
import { rpc } from '$lib/rpc';

interface Props {
	sources: SourcesMessage | undefined;
	config: ConfigMessage | undefined;
	isStreaming: boolean;
	/**
	 * The engine's typed capture verdict from the last start attempt. Only the
	 * two composition causes are rendered here; every other cause belongs to the
	 * source card, which owns the primary leg.
	 */
	captureCause?: StartFailureCaptureCause | undefined;
}

const { sources, config, isStreaming, captureCause }: Props = $props();

const ALPHA_STEP = 0.05;
const DEFAULT_ALPHA = 1;

const COMPOSITION_CAUSES = new Set<StartFailureCaptureCause>([
	'composition-unsupported',
	'secondary-unavailable',
]);

const persisted = $derived(config?.composition);

// A secondary leg must be a real capture device that is present and is not the
// primary — a coarse/virtual/network row has no second node to open.
const candidates = $derived(
	(sources?.sources ?? []).filter(
		(s): s is CaptureStreamSource =>
			s.origin === 'capture' &&
			s.lost !== true &&
			s.available !== false &&
			s.id !== config?.source,
	),
);

const enabled = $derived(persisted !== undefined);
const secondaryId = $derived(persisted?.secondary_input_id);
const layout = $derived<CompositionLayout>(
	persisted?.layout ?? COMPOSITION_LAYOUT_DEFAULT,
);
const alpha = $derived(persisted?.alpha ?? DEFAULT_ALPHA);

const secondaryName = $derived(
	candidates.find((s) => s.id === secondaryId)?.displayName ?? secondaryId,
);

const refusal = $derived(
	captureCause !== undefined && COMPOSITION_CAUSES.has(captureCause)
		? captureCause
		: undefined,
);

// The composition is baked into the engine graph at build time, so it can only
// ever take effect at the next start — the controls lock while live rather than
// pretending a change applies now.
const locked = $derived(isStreaming);

let saving = $state(false);

function layoutLabel(value: CompositionLayout): string {
	return resolveMessageKey(`live.composition.layoutName.${value}`);
}

async function write(next: CompositionConfig | null): Promise<void> {
	if (locked || saving) return;
	saving = true;
	try {
		await rpc.streaming.setConfig({ composition: next });
	} finally {
		saving = false;
	}
}

function toggle(on: boolean): void {
	if (!on) {
		void write(null);
		return;
	}
	const first = candidates[0];
	if (first === undefined) return;
	void write({ secondary_input_id: first.id, layout, alpha });
}

function patch(fields: Partial<CompositionConfig>): void {
	if (secondaryId === undefined) return;
	void write({
		secondary_input_id: secondaryId,
		layout,
		alpha,
		...fields,
	});
}
</script>

<Card.Root data-testid="composition-card">
	<Card.Content class="space-y-5 p-4 sm:p-6">
		<div class="flex items-start justify-between gap-3">
			<div class="min-w-0 space-y-1">
				<div class="flex items-center gap-1.5">
					<PictureInPicture2 aria-hidden={true} class="text-primary size-4 shrink-0" />
					<span class="text-sm font-semibold">{m["live.composition.title"]()}</span>
				</div>
				<p class="text-muted-foreground text-xs">
					{m["live.composition.description"]()}
				</p>
			</div>
			<Switch
				aria-label={m["live.composition.enable"]()}
				checked={enabled}
				data-testid="composition-enable"
				disabled={locked || saving || (!enabled && candidates.length === 0)}
				onCheckedChange={toggle}
			/>
		</div>

		<!-- Typed refusal band. Same honest-band pattern as SourceSection's
		     degraded leg: `role="status"`, the calm amber warning register, a
		     machine-readable code attribute, and copy keyed per CAUSE — the class
		     alone names no operator action. -->
		{#if refusal !== undefined}
			<div
				class="border-status-warning/50 bg-status-warning/10 flex items-start gap-3 rounded-lg border p-3"
				data-degraded-code={refusal}
				data-testid="composition-refusal-banner"
				role="status"
			>
				<Activity aria-hidden={true} class="text-status-warning mt-0.5 size-4 shrink-0" />
				<p class="text-muted-foreground min-w-0 text-xs">
					{resolveMessageKey(
						`live.startFailure.class.capture_source_unavailable.${refusal}`,
					)}
				</p>
			</div>
		{/if}

		{#if candidates.length === 0 && !enabled}
			<p class="text-muted-foreground text-xs" data-testid="composition-no-secondary">
				{m["live.composition.secondaryNone"]()}
			</p>
		{/if}

		{#if locked}
			<p class="text-muted-foreground text-xs" data-testid="composition-locked">
				{m["live.composition.lockedWhileStreaming"]()}
			</p>
		{/if}

		{#if enabled}
			<div class="space-y-2" data-testid="composition-secondary">
				<Label class="text-sm font-medium" for="composition-secondary-trigger">
					{m["live.composition.secondary"]()}
				</Label>
				<Select.Root
					disabled={locked || saving}
					onValueChange={(value) => patch({ secondary_input_id: value })}
					type="single"
					value={secondaryId}
				>
					<Select.Trigger id="composition-secondary-trigger" class="w-full">
						{secondaryName ?? m["live.composition.secondary"]()}
					</Select.Trigger>
					<Select.Content>
						{#each candidates as candidate (candidate.id)}
							<Select.Item
								data-testid={`composition-secondary-${candidate.id}`}
								value={candidate.id}
							>
								{candidate.displayName}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="space-y-2">
				<Label class="text-sm font-medium">{m["live.composition.layout"]()}</Label>
				<div
					class="bg-card/40 grid grid-cols-2 gap-1.5 rounded-lg border p-1 sm:grid-cols-3"
					aria-label={m["live.composition.layout"]()}
					data-testid="composition-layout-selector"
					role="radiogroup"
				>
					{#each COMPOSITION_LAYOUTS as option (option)}
						{@const active = option === layout}
						<button
							type="button"
							aria-checked={active}
							class="flex min-h-[44px] items-center justify-center rounded-md px-2 py-2 text-center text-xs font-medium transition-colors {active
								? 'bg-primary/10 text-primary ring-primary ring-1'
								: 'text-muted-foreground hover:bg-primary/5'}"
							data-active={active}
							data-testid={`composition-layout-${option}`}
							disabled={locked || saving}
							onclick={() => patch({ layout: option })}
							role="radio"
						>
							{layoutLabel(option)}
						</button>
					{/each}
				</div>
			</div>

			<div
				class="bg-muted/40 space-y-3 rounded-lg border p-4"
				data-testid="composition-alpha-control"
			>
				<div class="flex items-center justify-between gap-2">
					<Label class="text-sm font-medium" for="composition-alpha">
						{m["live.composition.alpha"]()}
					</Label>
					<span
						class="bg-primary/10 text-primary rounded-md px-2 py-1 font-mono text-xs"
						data-testid="composition-alpha-value"
					>
						{alpha.toFixed(2)}
					</span>
				</div>
				<Slider
					id="composition-alpha"
					aria-label={m["live.composition.alpha"]()}
					disabled={locked || saving}
					max={COMPOSITION_ALPHA_MAX}
					min={COMPOSITION_ALPHA_MIN}
					onValueChange={(value) => patch({ alpha: value as number })}
					step={ALPHA_STEP}
					type="single"
					value={alpha}
				/>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
