<!--
  CompositionCard.svelte — the PiP/PbP operator surface for the engine's two-leg
  `rgacompositor` session mode.

  VISIBILITY IS THE PARENT'S. This component renders whenever it is mounted;
  `IdleCockpit` and `LiveCockpit` mount it only while the engine's
  `get-capabilities.features` array carries the `composition` token, so an
  engine that cannot compose leaves ZERO nodes in the DOM rather than a disabled
  card — there is no capability being withheld to explain, so a greyed control
  would imply one that exists.

  It owns its `streaming.setConfig` write (the `SourceSection` precedent) and
  nothing else: the secondary picker is the SAME `sources.sources` list the
  source card renders, filtered to `origin === 'capture'` and to rows that are
  not already the primary.

  LIVE, the layout, the opacity and the second input change the running stream:
  the write carries `apply_now: true`, so the backend runs it as an apply-now
  transaction and keeps it only when the engine reports it applied. Until then
  the new value shows as the choice; a refused change puts the previous one
  back and says why. Turning composition on or off still waits for the next
  start, so the enable switch alone stays locked.
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
	StreamingSetConfigInput,
} from '@ceraui/rpc/schemas';
import {
	COMPOSITION_ALPHA_MAX,
	COMPOSITION_ALPHA_MIN,
	COMPOSITION_LAYOUT_DEFAULT,
	COMPOSITION_LAYOUTS,
} from '@ceraui/rpc/schemas';
import { Activity, Loader2, PictureInPicture2 } from '@lucide/svelte';

import * as Card from '$lib/components/ui/card';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { Slider } from '$lib/components/ui/slider';
import { Switch } from '$lib/components/ui/switch';
import { rpc } from '$lib/rpc';
import { getConfigChange } from '$lib/rpc/subscriptions.svelte';
import { configChangeReport } from '$lib/streaming/configChangeCopy';
import { isConfigChangeInFlight } from '$lib/streaming/configChangePhase';

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

// A live change the engine has not answered yet. It shows as the choice; once
// the answer lands it is dropped, so an applied change reads from the config
// echo and a refused one falls back to the persisted, still-running values.
let pending = $state<CompositionConfig | undefined>(undefined);
let liveRefusal = $state<string | undefined>(undefined);
// Live, the opacity previews while it moves and is sent as one change on
// release. The slider reports a commit for every key press, so a keyboard
// adjustment stays open while any adjusting key is held and ends when the
// last one comes up or focus leaves; other keys neither commit nor end it.
// Held keys are tracked by the physical key (event.code): a keyup can report a
// different key than its keydown (Shift turns Numpad4's ArrowLeft into "4").
let draggedAlpha = $state<number | undefined>(undefined);
const ADJUSTING_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
let heldKeys: string[] = [];

const shown = $derived(pending ?? persisted);

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
const secondaryId = $derived(shown?.secondary_input_id);
const layout = $derived<CompositionLayout>(
	shown?.layout ?? COMPOSITION_LAYOUT_DEFAULT,
);
const alpha = $derived(shown?.alpha ?? DEFAULT_ALPHA);

const secondaryName = $derived(
	candidates.find((s) => s.id === secondaryId)?.displayName ?? secondaryId,
);

const refusal = $derived(
	captureCause !== undefined && COMPOSITION_CAUSES.has(captureCause)
		? captureCause
		: undefined,
);

// Adding or removing the second leg rebuilds the engine graph, so turning
// composition on or off only takes effect at the next start: the enable switch
// locks while live. The layout, the opacity and the second input do not.
const locked = $derived(isStreaming);

let saving = $state(false);
// Any apply-now change in flight, this card's or another surface's, holds the
// controls: the engine runs one change at a time.
const applying = $derived(
	isStreaming && isConfigChangeInFlight(getConfigChange()),
);
const busy = $derived(saving || applying);

function layoutLabel(value: CompositionLayout): string {
	return resolveMessageKey(`live.composition.layoutName.${value}`);
}

async function write(next: CompositionConfig | null): Promise<void> {
	if (saving) return;
	saving = true;
	try {
		await rpc.streaming.setConfig({ composition: next });
	} finally {
		saving = false;
	}
}

async function applyLive(next: CompositionConfig): Promise<void> {
	if (busy) return;
	saving = true;
	pending = next;
	liveRefusal = undefined;
	// The encoder save's shape (`buildEncoderSetConfig`): the apply-now
	// directive rides the setConfig input without being a config field.
	const input: StreamingSetConfigInput = { composition: next, apply_now: true };
	try {
		const result = await rpc.streaming.setConfig(input);
		const change = result.configChange;
		if (change !== undefined && change.result !== 'applied') {
			liveRefusal = configChangeReport(change, m).message;
		} else if (!result.success) {
			liveRefusal = m['notifications.saveFailed']();
		}
	} catch {
		liveRefusal = m['notifications.saveFailed']();
	} finally {
		pending = undefined;
		saving = false;
	}
}

function toggle(on: boolean): void {
	if (locked) return;
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
	const next = { secondary_input_id: secondaryId, layout, alpha, ...fields };
	if (isStreaming) void applyLive(next);
	else void write(next);
}

function previewAlpha(value: number): void {
	if (isStreaming) draggedAlpha = value;
	else patch({ alpha: value });
}

function releaseAlpha(): void {
	if (!isStreaming || draggedAlpha === undefined) return;
	const value = draggedAlpha;
	draggedAlpha = undefined;
	if (value !== alpha) patch({ alpha: value });
}

function commitAlpha(): void {
	if (heldKeys.length === 0) releaseAlpha();
}

function pressedKey(event: KeyboardEvent): string {
	return event.code || event.key;
}

function holdKey(event: KeyboardEvent): void {
	const pressed = pressedKey(event);
	if (ADJUSTING_KEYS.includes(event.key) && !heldKeys.includes(pressed)) {
		heldKeys = [...heldKeys, pressed];
	}
}

function releaseKey(event: KeyboardEvent): void {
	const pressed = pressedKey(event);
	if (!heldKeys.includes(pressed)) return;
	heldKeys = heldKeys.filter((key) => key !== pressed);
	if (heldKeys.length === 0) releaseAlpha();
}

function endAdjustment(): void {
	heldKeys = [];
	releaseAlpha();
}
</script>

<Card.Root data-testid="composition-card">
	<Card.Content class="space-y-5 p-4 sm:p-6">
		<div class="flex items-start justify-between gap-3">
			<div class="min-w-0 space-y-1">
				<div class="flex items-center gap-1.5">
					<PictureInPicture2 aria-hidden={true} class="text-primary size-4 shrink-0" />
					<span class="text-sm font-semibold">{m["live.composition.title"]()}</span>
					{#if isStreaming && busy}
						<Loader2
							aria-hidden={true}
							class="text-status-info size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
						/>
					{/if}
				</div>
				<p class="text-muted-foreground text-xs">
					{m["live.composition.description"]()}
				</p>
				{#if locked}
					<p
						class="text-muted-foreground text-xs"
						data-testid="composition-locked"
						id="composition-locked"
					>
						{m["live.composition.lockedWhileStreaming"]()}
					</p>
				{/if}
			</div>
			<Switch
				aria-describedby={locked ? 'composition-locked' : undefined}
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

		{#if enabled}
			<div aria-busy={busy} class="space-y-2" data-testid="composition-secondary">
				<Label class="text-sm font-medium" for="composition-secondary-trigger">
					{m["live.composition.secondary"]()}
				</Label>
				<Select.Root
					disabled={busy}
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
					aria-busy={busy}
					aria-label={m["live.composition.layout"]()}
					data-testid="composition-layout-selector"
					role="radiogroup"
				>
					{#each COMPOSITION_LAYOUTS as option (option)}
						{const active = $derived(option === layout)}
						<!-- biome-ignore lint/a11y/useSemanticElements: Layout choices use button click actions and explicit save/lock gates; native radios change their activation contract. -->
						<button
							type="button"
							aria-checked={active}
							class="flex min-h-[44px] items-center justify-center rounded-md px-2 py-2 text-center text-xs font-medium transition-colors {active
								? 'bg-primary/10 text-primary ring-primary ring-1'
								: 'text-muted-foreground hover:bg-primary/5'}"
							data-active={active}
							data-testid={`composition-layout-${option}`}
							disabled={busy}
							onclick={() => patch({ layout: option })}
							role="radio"
						>
							{layoutLabel(option)}
						</button>
					{/each}
				</div>
			</div>

			<!-- The opacity control and the live outcome region share one block, so
			     the empty region never adds the card's section gap. -->
			<div>
				<div
					aria-busy={busy}
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
							{(draggedAlpha ?? alpha).toFixed(2)}
						</span>
					</div>
					<Slider
						id="composition-alpha"
						aria-label={m["live.composition.alpha"]()}
						disabled={busy}
						max={COMPOSITION_ALPHA_MAX}
						min={COMPOSITION_ALPHA_MIN}
						onfocusout={endAdjustment}
						onkeydowncapture={holdKey}
						onkeyup={releaseKey}
						onpointerdowncapture={() => {
							heldKeys = [];
						}}
						onValueChange={(value) => previewAlpha(value as number)}
						onValueCommit={commitAlpha}
						step={ALPHA_STEP}
						type="single"
						value={alpha}
					/>
				</div>

				<!-- The live outcome region is mounted, empty, for the whole session, so
				     a refused change is announced the moment it lands; it sits below the
				     controls so a late answer never moves what is under the operator's
				     finger. -->
				{#if isStreaming}
					<div aria-live="assertive" role="alert">
						{#if liveRefusal !== undefined}
							<div
								class="border-status-warning/50 bg-status-warning/10 mt-5 flex items-start gap-3 rounded-lg border p-3"
							>
								<Activity aria-hidden={true} class="text-status-warning mt-0.5 size-4 shrink-0" />
								<p class="text-foreground min-w-0 text-xs">{liveRefusal}</p>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</Card.Content>
</Card.Root>
