<!--
  EncoderDialog.svelte — focused video-encoder configuration dialog.

  Rebuilt from the legacy `shared/EncoderCard.svelte` controlled form into a
  self-contained dialog that composes on the shared `AppDialog` chrome and the
  schema-derived `streamingConstraints` (no hardcoded numeric literals).

  Controls
  --------
  • Video source — chosen from the pipeline metadata (`getPipelines()`).
  • Resolution   — only when the selected pipeline supports the override.
  • Framerate    — only when the selected pipeline supports the override.
  • Bitrate      — Slider seeded across the practical UI band
    (`streamingConstraints.bitrate.defaultMin..defaultMax`) plus a precise
    number input; validated against the canonical hardware window
    (`streamingConstraints.bitrate.min..max`).
  • Bitrate overlay — on/off Switch.

  Behaviour
  ---------
  • Errors render INLINE (aria-invalid + message below the field) — never toasts.
  • The save button stays disabled while any field is invalid, so the inline
    error is visible without a failed submit.
  • `normalizeValue` (StreamingUtils) clamps/steps the bitrate before commit.
  • On save the live bitrate is applied immediately via `updateMaxBitrate`
    (a no-op unless streaming); the full encoder selection is written back to the
    bound `config` draft that LiveView owns, and `onSave` notifies LiveView so it
    can persist the selection via `rpc.streaming.setConfig` (Task 14).
  • RTL-safe (logical spacing, no physical margins), reduced-motion inherits the
    AppDialog suppression, and the breakpoint switches Dialog ⇄ Sheet.
-->
<script module lang="ts">
import type { Framerate, Resolution } from '@ceraui/rpc/schemas';

export interface EncoderConfig {
	source: string | undefined;
	resolution: Resolution | undefined;
	framerate: Framerate | undefined;
	bitrate: number | undefined;
	bitrateOverlay: boolean | undefined;
}
</script>

<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Binary, Cpu } from '@lucide/svelte';
import { AVAILABLE_FRAMERATES, AVAILABLE_RESOLUTIONS, type Pipeline } from '@ceraui/rpc/schemas';

import AsyncSwitch from '$lib/components/custom/async-switch.svelte';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { streamingConstraints } from '$lib/components/streaming/ValidationAdapter';
import { getOverrideGate } from '$lib/streaming/encoderConfig';
import { normalizeValue, updateMaxBitrate } from '$lib/components/streaming/StreamingUtils';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { Slider } from '$lib/components/ui/slider';
import {
	getFramerateLabel,
	getHardwareLabel,
	getResolutionLabel,
	getSourceLabel,
} from '$lib/helpers/PipelineHelper';
import { getConfig, getIsStreaming, getPipelines } from '$lib/rpc/subscriptions.svelte';

interface Props {
	open?: boolean;
	config?: EncoderConfig;
	/**
	 * Commit handler — receives the assembled encoder draft when Save is pressed,
	 * so LiveView can persist it via `rpc.streaming.setConfig` (Task 14). Mirrors
	 * the Audio/Server dialog persistence pattern.
	 */
	onSave?: (config: EncoderConfig) => void;
}

let { open = $bindable(false), config = $bindable(), onSave }: Props = $props();

// ── Schema-derived bounds (single source of truth, zero literals) ──────────────
const BITRATE = streamingConstraints.bitrate;
const BITRATE_STEP = 50;

// ── Live data from the non-deprecated subscriptions surface ────────────────────
const pipelinesMessage = $derived(getPipelines());
const pipelines = $derived(pipelinesMessage?.pipelines);
const hardware = $derived(pipelinesMessage?.hardware);
const isStreaming = $derived(getIsStreaming());
const savedConfig = $derived(getConfig());

// ── i18n key resolver (mirrors the legacy EncoderCard helper) ──────────────────
const t = (key: string): string => {
	const parts = key.split('.');
	let result: unknown = $LL;
	for (const part of parts) {
		if (result && typeof result === 'object' && part in result) {
			result = (result as Record<string, unknown>)[part];
		} else {
			return key;
		}
	}
	return typeof result === 'function' ? (result as () => string)() : key;
};

// ── Editable working copy (seeded when the dialog opens) ───────────────────────
let localSource = $state('');
let localResolution = $state<Resolution>('1080p');
let localFramerate = $state<Framerate>(30);
let localBitrate = $state<number>(BITRATE.defaultMin);
let localOverlay = $state(false);

// Seed the working copy from the bound draft first, falling back to the saved
// device config. Re-seed on every open so a cancelled edit is fully discarded.
let seeded = $state(false);
$effect(() => {
	if (open && !seeded) {
		localSource = config?.source ?? savedConfig?.pipeline ?? '';
		localResolution = config?.resolution ?? '1080p';
		localFramerate = config?.framerate ?? 30;
		const seedBitrate = config?.bitrate ?? savedConfig?.max_br ?? BITRATE.defaultMin;
		localBitrate = Number.isFinite(seedBitrate) ? seedBitrate : BITRATE.defaultMin;
		localOverlay = config?.bitrateOverlay ?? savedConfig?.bitrate_overlay ?? false;
		seeded = true;
	} else if (!open) {
		seeded = false;
	}
});

const selectedPipeline = $derived<Pipeline | undefined>(
	localSource && pipelines ? pipelines[localSource] : undefined,
);

// Capability gate (single source of truth, shared with buildEncoderSetConfig):
// a pipeline that does not advertise an override has its control disabled +
// marked invalid so the operator can never push an unsupported override.
const overrideGate = $derived(getOverrideGate(selectedPipeline));

// Slider can only address the practical band; the number input owns out-of-band
// (but still valid) values, so the slider is rendered controlled + clamped.
const sliderValue = $derived(
	Math.min(BITRATE.defaultMax, Math.max(BITRATE.defaultMin, localBitrate)),
);

// ── Inline validation (schema-derived bounds, no duplicated literals) ──────────
const errors = $derived.by(() => {
	const e: Record<string, string> = {};
	if (!localSource) {
		e.source = $LL.validation.required();
	}
	if (
		!Number.isFinite(localBitrate) ||
		localBitrate < BITRATE.min ||
		localBitrate > BITRATE.max
	) {
		e.bitrate = $LL.validation.bitrateRange();
	}
	return e;
});
const isValid = $derived(Object.keys(errors).length === 0);

function commitBitrate(raw: number) {
	localBitrate = Number.isFinite(raw) ? raw : localBitrate;
}

function handleSave() {
	if (!isValid) return;
	const normalized = normalizeValue(localBitrate, BITRATE.min, BITRATE.max, BITRATE_STEP);
	localBitrate = normalized;

	// Persist the full encoder selection into the draft LiveView owns + feeds the
	// start flow. Resolution/framerate stay capability-gated at the source.
	const next: EncoderConfig = {
		source: localSource || undefined,
		resolution: selectedPipeline?.supportsResolutionOverride ? localResolution : undefined,
		framerate: selectedPipeline?.supportsFramerateOverride ? localFramerate : undefined,
		bitrate: normalized,
		bitrateOverlay: localOverlay,
	};
	config = next;

	// Apply the new bitrate live; no-op unless currently streaming.
	updateMaxBitrate(normalized, isStreaming);

	// Notify LiveView so it can persist the selection via rpc.streaming.setConfig.
	onSave?.(next);

	open = false;
}
</script>

<AppDialog
	bind:open
	closeOnPrimary={false}
	icon={Binary}
	onPrimary={handleSave}
	primaryDisabled={!isValid}
	primaryLabel={$LL.dialogs.save()}
	title={$LL.settings.encoderSettings()}
>
	<div class="space-y-5">
		{#if hardware}
			<div class="text-muted-foreground flex items-center gap-2 text-xs">
				<Cpu aria-hidden={true} class="size-3.5 shrink-0" />
				<span>{getHardwareLabel(hardware, t)}</span>
			</div>
		{/if}

		<!-- Video source -->
		<div class="space-y-2">
			<Label class="text-sm font-medium" for="encoder-source">{$LL.settings.inputMode()}</Label>
			<Select.Root
				onValueChange={(value) => (localSource = value)}
				type="single"
				value={localSource}
			>
				<Select.Trigger
					id="encoder-source"
					aria-invalid={Boolean(errors.source)}
					class="w-full"
				>
					{localSource ? getSourceLabel(localSource, t) : $LL.settings.selectInputMode()}
				</Select.Trigger>
				<Select.Content>
					<Select.Group>
						{#if pipelines}
							{#each Object.entries(pipelines) as [sourceId, pipeline] (sourceId)}
								<Select.Item value={sourceId}>
									<div class="flex flex-col py-1">
										<span class="font-medium">{getSourceLabel(sourceId, t)}</span>
										<span class="text-muted-foreground text-xs">{pipeline.description}</span>
									</div>
								</Select.Item>
							{/each}
						{/if}
					</Select.Group>
				</Select.Content>
			</Select.Root>
			{#if errors.source}
				<p class="text-destructive text-sm">{errors.source}</p>
			{/if}
		</div>

		<!-- Resolution (pipeline capability-gated: disabled + invalid when unsupported) -->
		{#if localSource}
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="encoder-resolution">
					{$LL.settings.encodingResolution()}
				</Label>
				<Select.Root
					disabled={!overrideGate.resolution}
					onValueChange={(value) => (localResolution = value as Resolution)}
					type="single"
					value={localResolution}
				>
					<Select.Trigger
						id="encoder-resolution"
						aria-invalid={!overrideGate.resolution}
						class="w-full"
					>
						{#if overrideGate.resolution}
							{localResolution
								? getResolutionLabel(localResolution)
								: $LL.settings.selectEncodingResolution()}
						{:else}
							{$LL.general.notAvailable()}
						{/if}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each AVAILABLE_RESOLUTIONS as resolution (resolution)}
								<Select.Item label={getResolutionLabel(resolution)} value={resolution}></Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</div>
		{/if}

		<!-- Framerate (pipeline capability-gated: disabled + invalid when unsupported) -->
		{#if localSource}
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="encoder-framerate">
					{$LL.settings.framerate()}
				</Label>
				<Select.Root
					disabled={!overrideGate.framerate}
					onValueChange={(value) => (localFramerate = parseFloat(value) as Framerate)}
					type="single"
					value={String(localFramerate)}
				>
					<Select.Trigger
						id="encoder-framerate"
						aria-invalid={!overrideGate.framerate}
						class="w-full"
					>
						{#if overrideGate.framerate}
							{localFramerate ? getFramerateLabel(localFramerate) : $LL.settings.selectFramerate()}
						{:else}
							{$LL.general.notAvailable()}
						{/if}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each AVAILABLE_FRAMERATES as framerate (framerate)}
								<Select.Item label={getFramerateLabel(framerate)} value={String(framerate)}></Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</div>
		{/if}

		<!-- Bitrate: slider (practical band) + precise number input -->
		<div class="bg-muted/40 space-y-3 rounded-lg border p-4">
			<div class="flex items-center justify-between gap-2">
				<Label class="text-sm font-medium" for="encoder-bitrate">{$LL.settings.bitrate()}</Label>
				<span class="bg-primary/10 text-primary rounded-md px-2 py-1 font-mono text-xs">
					{Number.isFinite(localBitrate) ? localBitrate : BITRATE.defaultMin}
				</span>
			</div>
			<Slider
				aria-label={$LL.settings.bitrate()}
				max={BITRATE.defaultMax}
				min={BITRATE.defaultMin}
				onValueChange={(value) => commitBitrate(value as number)}
				step={BITRATE_STEP}
				type="single"
				value={sliderValue}
			/>
			<Input
				id="encoder-bitrate"
				aria-describedby={errors.bitrate ? 'encoder-bitrate-error' : undefined}
				aria-invalid={Boolean(errors.bitrate)}
				class="text-center font-mono"
				max={BITRATE.max}
				min={BITRATE.min}
				oninput={(e) => commitBitrate(parseInt(e.currentTarget.value, 10))}
				step={BITRATE_STEP}
				type="number"
				value={Number.isFinite(localBitrate) ? localBitrate : BITRATE.defaultMin}
			/>
			{#if errors.bitrate}
				<p class="text-destructive text-sm" id="encoder-bitrate-error">{errors.bitrate}</p>
			{/if}
			{#if isStreaming}
				<p class="text-muted-foreground bg-muted rounded-md p-2 text-xs">
					{$LL.settings.changeBitrateNotice()}
				</p>
			{/if}
		</div>

		<!-- Bitrate overlay toggle -->
		<div class="flex items-center justify-between gap-3 rounded-lg border p-3">
			<Label class="flex-1 cursor-pointer text-sm" for="encoder-overlay">
				{$LL.settings.enableBitrateOverlay()}
			</Label>
			<AsyncSwitch
				id="encoder-overlay"
				checked={localOverlay}
				data-testid="bitrate-overlay-switch"
				onCheckedChange={(value) => {
					localOverlay = value;
					return Promise.resolve();
				}}
			/>
		</div>
	</div>
</AppDialog>
