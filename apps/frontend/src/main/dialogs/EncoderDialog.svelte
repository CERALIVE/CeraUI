<!--
  EncoderDialog.svelte — focused video-encoder configuration dialog.

  Rebuilt from the legacy `shared/EncoderCard.svelte` controlled form into a
  self-contained dialog that composes on the shared `AppDialog` chrome and the
  schema-derived `streamingConstraints` (no hardcoded numeric literals).

  Controls
  --------
  • Video source — pipeline metadata (`getPipelines()`) plus any UVC source a
    device advertises as `video/x-h265` (`getDevices()`).
  • Codec        — capability-derived (`getCapabilities()`); generic H.265 is
    offered WITH a software-encode warning badge, never hidden.
  • Resolution   — only when the selected pipeline supports the override.
  • Framerate    — only when the selected pipeline supports the override.
  • Bitrate      — Slider + number input clamped to the board's per-board window
    (`capabilities.encoder.bitrate_range`), falling back to the schema range only
    until the capability contract arrives.
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
import { Binary, Cpu, TriangleAlert } from '@lucide/svelte';
import { BITRATE_DEFAULT_MIN, type Pipeline } from '@ceraui/rpc/schemas';

import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import PreviewCanvas from '$lib/components/preview/PreviewCanvas.svelte';
import {
	bitrateBoundsFromCaps,
	deriveCodecOptions,
	deriveUvcH265Sources,
	framerateOptions,
	offeredEncoderCaps,
	platformCapsForHardware,
	resolutionOptions,
} from '$lib/components/streaming/ValidationAdapter';
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
import {
	getCapabilities,
	getConfig,
	getDevices,
	getIsStreaming,
	getPipelines,
} from '$lib/rpc/subscriptions.svelte';

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

const BITRATE_STEP = 50;

// ── Live data from the non-deprecated subscriptions surface ────────────────────
const pipelinesMessage = $derived(getPipelines());
const pipelines = $derived(pipelinesMessage?.pipelines);
const hardware = $derived(pipelinesMessage?.hardware);
const isStreaming = $derived(getIsStreaming());
const savedConfig = $derived(getConfig());

// ── Capability contract: per-board bitrate window, codec offers, UVC H.265 ─────
const capabilities = $derived(getCapabilities());
const devices = $derived(getDevices());
const platformCaps = $derived(capabilities?.platform ?? platformCapsForHardware(hardware));
// Bitrate clamps to the board's real window (encoder.bitrate_range), falling
// back to the schema-wide range only until the contract arrives.
const BITRATE = $derived(bitrateBoundsFromCaps(capabilities));
const codecOptions = $derived(deriveCodecOptions(platformCaps));
const uvcH265Sources = $derived(deriveUvcH265Sources(devices));
const h265SoftwareWarning = $derived(
	codecOptions.some((codec) => codec.value === 'h265' && codec.softwareWarning),
);

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
let localBitrate = $state<number>(BITRATE_DEFAULT_MIN);
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

// Capability-driven offered set (platform ∩ selected source) from intersectCaps.
// Drives per-option enable/disable so an incompatible resolution/framerate is
// shown disabled with a reason rather than hidden or all-or-nothing gated.
const offered = $derived(offeredEncoderCaps(hardware, localSource || undefined, selectedPipeline));
const resolutionChoices = $derived(resolutionOptions(offered));
const framerateChoices = $derived(framerateOptions(offered));
const resolutionSupported = $derived(offered.resolutions.includes(localResolution));
const framerateSupported = $derived(offered.framerates.includes(localFramerate));

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
	// Clamp to the board ceiling so an out-of-band entry (e.g. 50000 on a
	// 15000-cap board) snaps to the contract max instead of failing validation.
	localBitrate = Number.isFinite(raw) ? Math.min(BITRATE.max, raw) : localBitrate;
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
						{#each uvcH265Sources as uvc (uvc.inputId)}
							<Select.Item value={uvc.sourceKind}>
								<div class="flex flex-col py-1">
									<span class="font-medium">{getSourceLabel(uvc.sourceKind, t)}</span>
									<span class="text-muted-foreground text-xs">{uvc.displayName}</span>
								</div>
							</Select.Item>
						{/each}
					</Select.Group>
				</Select.Content>
			</Select.Root>
			{#if errors.source}
				<p class="text-destructive text-sm">{errors.source}</p>
			{/if}
			{#if uvcH265Sources.length > 0}
				<div class="flex flex-wrap items-center gap-1.5">
					{#each uvcH265Sources as uvc (uvc.inputId)}
						<span
							class="bg-primary/10 text-primary inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-xs"
							data-input-id={uvc.inputId}
							data-testid="source-uvc_h265"
						>
							{getSourceLabel(uvc.sourceKind, t)} · {uvc.displayName}
						</span>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Encoder codec: capability-derived. Generic H.265 is offered WITH the
		     software-encode warning, never hidden. -->
		<div class="space-y-2">
			<Label class="text-sm font-medium">{$LL.settings.videoCodec()}</Label>
			<div class="flex flex-wrap items-center gap-2" data-testid="encoder-codecs">
				{#each codecOptions as codec (codec.value)}
					<span
						class="bg-muted inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs"
						data-testid={`codec-${codec.value}`}
					>
						{codec.value === 'h265'
							? 'H.265'
							: codec.value === 'h264'
								? 'H.264'
								: codec.mediaType}
						{#if codec.softwareWarning}
							<span
								class="bg-status-warning/15 text-status-warning inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
								data-testid="h265-software-warning"
							>
								<TriangleAlert aria-hidden={true} class="size-3 shrink-0" />
								{$LL.settings.softwareEncodeWarning()}
							</span>
						{/if}
					</span>
				{/each}
			</div>
		</div>

		<!-- Live preview (#72): the same PreviewCanvas as the Live view, compact so
		     the dialog supplies the chrome. Active-encode-only — it owns its socket
		     + toggle and tears down on dialog close (unmount). -->
		<PreviewCanvas compact />

		<!-- Resolution: every rung is shown; rungs outside the capability-offered
		     set render disabled (aria-disabled + reason title), never hidden. -->
		{#if localSource}
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="encoder-resolution">
					{$LL.settings.encodingResolution()}
				</Label>
				<Select.Root
					onValueChange={(value) => (localResolution = value as Resolution)}
					type="single"
					value={localResolution}
				>
					<Select.Trigger
						id="encoder-resolution"
						aria-invalid={!resolutionSupported}
						class="w-full"
					>
						{localResolution
							? getResolutionLabel(localResolution)
							: $LL.settings.selectEncodingResolution()}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each resolutionChoices as option (option.value)}
								<Select.Item
									aria-disabled={option.supported ? undefined : 'true'}
									data-testid="resolution-option"
									disabled={!option.supported}
									label={getResolutionLabel(option.value)}
									title={option.reason}
									value={option.value}
								></Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</div>
		{/if}

		<!-- Framerate: same capability filtering as resolution — incompatible
		     rates render disabled with a reason, never hidden. -->
		{#if localSource}
			<div class="space-y-2">
				<Label class="text-sm font-medium" for="encoder-framerate">
					{$LL.settings.framerate()}
				</Label>
				<Select.Root
					onValueChange={(value) => (localFramerate = parseFloat(value) as Framerate)}
					type="single"
					value={String(localFramerate)}
				>
					<Select.Trigger
						id="encoder-framerate"
						aria-invalid={!framerateSupported}
						class="w-full"
					>
						{localFramerate ? getFramerateLabel(localFramerate) : $LL.settings.selectFramerate()}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each framerateChoices as option (option.value)}
								<Select.Item
									aria-disabled={option.supported ? undefined : 'true'}
									data-testid="framerate-option"
									disabled={!option.supported}
									label={getFramerateLabel(option.value)}
									title={option.reason}
									value={String(option.value)}
								></Select.Item>
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
			<LabeledSwitch
				checked={localOverlay}
				label={$LL.settings.enableBitrateOverlay()}
				onCheckedChange={(value) => (localOverlay = value)}
			/>
		</div>
	</div>
</AppDialog>
