<!--
  EncoderDialog.svelte — focused video-encoder configuration dialog.

  Capability-first (no presets): the dialog exposes independent
  source / codec / bitrate / resolution / framerate selectors directly. There is
  no mode-preset catalog — every control is capability-gated on its own.

  Capability discipline
  ---------------------
  • Resolution / Framerate come from `offeredAxes` (platform ∩ selected source ∩
    Tier-2 device modes). Framerate is gated PER selected resolution, so a rate the
    device can't drive at that resolution renders disabled-with-reason. Every rung
    outside the offered set renders DISABLED with a reason tooltip — never hidden.
    H.265 is disabled-with-reason when the platform can't encode it.
  • All numeric bounds come from `streamingConstraints` / `bitrateBoundsFromCaps`
    (ValidationAdapter) — no inline literals.
  • The operator's codec choice (`localCodec`) is written to the draft's `codec`
    field → persisted as `video_codec` on save.

  Behaviour
  ---------
  • Errors render INLINE (aria-invalid + message below the field) — never toasts.
  • `normalizeValue` (StreamingUtils) clamps/steps the bitrate before commit.
  • On save the live bitrate is applied via `updateMaxBitrate` (no-op unless
    streaming); the full selection is written to the bound `config` draft LiveView
    owns, and `onSave` notifies LiveView so it can persist via setConfig (Task 14).
  • The compact `PreviewCanvas` stays mounted (#72) — it owns its own socket and
    tears down on dialog close.
  • RTL-safe (logical spacing), reduced-motion inherits AppDialog suppression, and
    the breakpoint switches Dialog ⇄ Sheet.
-->
<script module lang="ts">
import type { Framerate, Resolution, VideoCodec } from '@ceraui/rpc/schemas';

export interface EncoderConfig {
	source: string | undefined;
	resolution: Resolution | undefined;
	framerate: Framerate | undefined;
	bitrate: number | undefined;
	bitrateOverlay: boolean | undefined;
	// Egress video codec. `undefined` = "Auto (recommended)" → the engine's
	// platform default (never written to `video_codec`); `h264`/`h265` = the
	// operator's explicit choice. Optional so callers that don't set it (LiveView
	// seed) stay valid.
	codec?: VideoCodec;
}
</script>

<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Binary, Cpu, TriangleAlert } from '@lucide/svelte';
import { BITRATE_DEFAULT_MIN, type Pipeline } from '@ceraui/rpc/schemas';

import AppliesNextStart from '$lib/components/custom/AppliesNextStart.svelte';
import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import PreviewCanvas from '$lib/components/preview/PreviewCanvas.svelte';
import {
	axisCeiling,
	bitrateBoundsFromCaps,
	clampBitrateToBounds,
	deriveCodecOptions,
	deriveUvcH265Sources,
	framerateOptionsForResolution,
	offeredAxes,
	platformCapsForHardware,
	resolutionOptions,
	summarizeProbedCaps,
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
	getStatus,
} from '$lib/rpc/subscriptions.svelte';
import { appliesOnNextStart } from '$lib/streaming/appliesNextStart';
import { pipelineAvailability, pipelineViews } from '$lib/streaming/pipelineAvailability';

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
	// Network-ingest gateway status: gates rtmp/srt sources disabled-with-reason
	// through the shared pipelineAvailability rule (never a second inline check).
	const networkIngest = $derived(getStatus()?.network_ingest);

// ── Capability contract: per-board bitrate window, codec offers, UVC H.265 ─────
const capabilities = $derived(getCapabilities());
const devices = $derived(getDevices());
const platformCaps = $derived(capabilities?.platform ?? platformCapsForHardware(hardware));
// Bitrate clamps to the board's real window (encoder.bitrate_range), falling
// back to the schema-wide range only until the contract arrives.
const BITRATE = $derived(bitrateBoundsFromCaps(capabilities));
const codecOptions = $derived(deriveCodecOptions(platformCaps));
// Resolved engine default for "Auto": H.265 only when the platform both
// supports it AND has a hardware encoder; otherwise H.264.
const resolvedAutoCodec = $derived<VideoCodec>(
	platformCaps.supports_h265 && platformCaps.hardware_accelerated ? 'h265' : 'h264',
);
// H.265 availability (from the offered set) + its software-encode caveat.
const h265Option = $derived(codecOptions.find((codec) => codec.value === 'h265'));
const h265Supported = $derived(h265Option !== undefined);
const h265SoftwareOnly = $derived(h265Option?.softwareWarning ?? false);
const uvcH265Sources = $derived(deriveUvcH265Sources(devices));
// Probed hardware formats (resolution/framerate/media-type) surfaced inline.
const probedCaps = $derived(summarizeProbedCaps(devices));

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
// Operator's egress codec choice: `undefined` = "Auto (recommended)" (engine
// resolves the platform default), `h264`/`h265` = explicit. Persisted to the
// draft's `codec` → `video_codec`, and drives the segmented selector + preset
// matching.
let localCodec = $state<VideoCodec | undefined>(undefined);
// The segmented-selector active-state (Auto = undefined selection).
const codecIsAuto = $derived(localCodec === undefined);
const codecIsH264 = $derived(localCodec === 'h264');
const codecIsH265 = $derived(localCodec === 'h265');

// Whether the last bitrate commit was snapped into the board window (drives the
// inline "adjusted to the supported range" notice).
let bitrateClamped = $state(false);

// Seed snapshot captured on open: edits are measured against these so a
// restart-required field changed mid-stream can be badged "applies on next start".
let seededSource = $state('');
let seededResolution = $state<Resolution>('1080p');
let seededFramerate = $state<Framerate>(30);

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
		localCodec = config?.codec;
		seededSource = localSource;
		seededResolution = localResolution;
		seededFramerate = localFramerate;
		bitrateClamped = false;
		seeded = true;
	} else if (!open) {
		seeded = false;
	}
});

	const selectedPipeline = $derived<Pipeline | undefined>(
		localSource && pipelines ? pipelines[localSource] : undefined,
	);

	// Per-source gateway verdict (shared rule): tags the selected source and every
	// picker option available / disabled-with-reason when its rtmp/srt gateway is down.
	const selectedAvailability = $derived(pipelineAvailability(selectedPipeline, networkIngest));
	const sourceViews = $derived(pipelineViews(pipelines, networkIngest));

// Restart-required edits made mid-stream → "applies on next start" badges. The
// edit test is against the open-time seed so an untouched field stays quiet.
const sourceAppliesNextStart = $derived(
	appliesOnNextStart('pipeline', isStreaming, localSource !== seededSource),
);
const resolutionAppliesNextStart = $derived(
	appliesOnNextStart('resolution', isStreaming, localResolution !== seededResolution),
);
const framerateAppliesNextStart = $derived(
	appliesOnNextStart('framerate', isStreaming, localFramerate !== seededFramerate),
);

// Capability-gated axes: platform ∩ selected source ∩ Tier-2 device modes. When
// the engine broadcasts per-device modes, Resolution/Framerate reflect the active
// (or kind-matched) capture hardware; otherwise this is the coarse offering. Every
// incompatible rung is shown disabled with a reason — never hidden (house rule).
const deviceModes = $derived(capabilities?.device_modes);
const selectedVideoInput = $derived(savedConfig?.selected_video_input);
const axes = $derived(
	offeredAxes(
		hardware,
		localSource || undefined,
		selectedPipeline,
		deviceModes,
		selectedVideoInput,
	),
);
const offered = $derived(axes.offered);
const resolutionChoices = $derived(resolutionOptions(offered));
// Framerate options are gated per selected resolution: a rate the device+mode
// can't drive at localResolution renders disabled-with-reason, never hidden.
const framerateChoices = $derived(framerateOptionsForResolution(axes, localResolution));
const resolutionSupported = $derived(offered.resolutions.includes(localResolution));
const framerateSupported = $derived(
	framerateChoices.find((option) => option.value === localFramerate)?.supported ?? false,
);
// Current-vs-device-max summary (replaces preset highlighting): the active source's
// real ceiling given platform ∩ source ∩ device modes.
const ceiling = $derived(axisCeiling(axes));

// Single coherent bitrate range: slider AND number input share the SAME board
// window (BITRATE.min‥max). The slider is rendered controlled + clamped so an
// out-of-band seed never detaches the thumb from the committed value.
const sliderValue = $derived(clampBitrateToBounds(localBitrate, BITRATE));

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
	// Keep the current value while the field is mid-edit (empty input → NaN).
	if (!Number.isFinite(raw)) return;
	// One clamp shared by the slider and the number input so both snap an
	// out-of-band entry (e.g. 50000 on a 15000-cap board) to the same board window.
	const clamped = clampBitrateToBounds(raw, BITRATE);
	bitrateClamped = clamped !== raw;
	localBitrate = clamped;
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
		codec: localCodec,
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
	primaryDisabled={!isValid || !selectedAvailability.available}
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
			<div class="flex items-center justify-between gap-2">
				<Label class="text-sm font-medium" for="encoder-source">{$LL.settings.inputMode()}</Label>
				<AppliesNextStart
					show={sourceAppliesNextStart}
					label={$LL.live.encoder.appliesNextStart()}
					data-testid="source-applies-next-start"
				/>
			</div>
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
						{#each sourceViews as view (view.id)}
							<Select.Item
								value={view.id}
								data-source-id={view.id}
								data-available={view.availability.available}
								disabled={!view.availability.available}
								title={view.availability.available ? undefined : t(view.availability.reason)}
							>
								<div class="flex flex-col py-1">
									<span class="flex items-center gap-1.5 font-medium">
										{getSourceLabel(view.id, t)}
										{#if !view.availability.available}
											<TriangleAlert
												aria-hidden={true}
												class="text-status-warning size-3.5 shrink-0"
											/>
										{/if}
									</span>
									<span class="text-muted-foreground text-xs">{view.pipeline.description}</span>
									{#if !view.availability.available}
										<span class="text-status-warning text-xs" data-testid="source-gateway-reason">
											{t(view.availability.reason)}
										</span>
									{/if}
								</div>
							</Select.Item>
						{/each}
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
			{#if !selectedAvailability.available}
				<div
					class="border-status-warning/40 bg-status-warning/10 flex items-start gap-2 rounded-md border p-2.5"
					data-testid="source-gateway-blocked"
					role="status"
				>
					<TriangleAlert
						aria-hidden={true}
						class="text-status-warning mt-0.5 size-4 shrink-0"
					/>
					<span class="text-status-warning text-xs">{t(selectedAvailability.reason)}</span>
				</div>
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

			<!-- Probed capabilities: the formats each connected device advertises,
			     shown so the operator picks against real hardware caps. -->
			{#if probedCaps.length > 0}
				<div class="bg-muted/30 space-y-1.5 rounded-md border p-2.5" data-testid="probed-caps">
					<span class="text-muted-foreground text-xs font-medium">
						{$LL.live.encoder.probedCaps()}
					</span>
					{#each probedCaps as device (device.inputId)}
						<div class="space-y-1" data-input-id={device.inputId}>
							<span class="text-foreground text-xs">{device.displayName}</span>
							<div class="flex flex-wrap items-center gap-1">
								{#each device.caps as cap, i (i)}
									<span
										class="bg-card/60 text-muted-foreground text-micro rounded px-1.5 py-0.5 font-mono"
									>
										{cap}
									</span>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Live preview (#72): the same PreviewCanvas as the Live view, compact so
		     the dialog supplies the chrome. Active-encode-only — it owns its socket
		     + toggle and tears down on dialog close (unmount). -->
		<PreviewCanvas compact />

		<!-- Encoder codec: a first-class, capability-gated selector (replaces the
		     old display-only chips). Auto resolves the engine default; H.265 is
		     disabled-with-reason when the platform can't encode it — never hidden. -->
		<div class="space-y-2">
			<Label class="text-sm font-medium">{$LL.settings.videoCodec()}</Label>
			<div
				class="bg-card/40 grid grid-cols-3 gap-1.5 rounded-lg border p-1"
				aria-label={$LL.settings.videoCodec()}
				data-testid="encoder-codec-selector"
				role="radiogroup"
			>
				<button
					type="button"
					aria-checked={codecIsAuto}
					class="flex min-h-[44px] items-center justify-center rounded-md px-2 py-2 text-xs font-medium transition-colors {codecIsAuto
						? 'bg-primary/10 text-primary ring-primary ring-1'
						: 'text-muted-foreground hover:bg-primary/5'}"
					data-active={codecIsAuto}
					data-testid="codec-auto"
					onclick={() => (localCodec = undefined)}
					role="radio"
				>
					{$LL.live.encoder.codecAuto()}
				</button>
				<button
					type="button"
					aria-checked={codecIsH264}
					class="flex min-h-[44px] items-center justify-center rounded-md px-2 py-2 font-mono text-xs font-medium transition-colors {codecIsH264
						? 'bg-primary/10 text-primary ring-primary ring-1'
						: 'text-muted-foreground hover:bg-primary/5'}"
					data-active={codecIsH264}
					data-testid="codec-h264"
					onclick={() => (localCodec = 'h264')}
					role="radio"
				>
					H.264
				</button>
				<button
					type="button"
					aria-checked={codecIsH265}
					aria-disabled={h265Supported ? undefined : 'true'}
					class="flex min-h-[44px] items-center justify-center rounded-md px-2 py-2 font-mono text-xs font-medium transition-colors {codecIsH265
						? 'bg-primary/10 text-primary ring-primary ring-1'
						: h265Supported
							? 'text-muted-foreground hover:bg-primary/5'
							: 'text-muted-foreground/50 cursor-not-allowed'}"
					data-active={codecIsH265}
					data-supported={h265Supported}
					data-testid="codec-h265"
					disabled={!h265Supported}
					onclick={() => (localCodec = 'h265')}
					role="radio"
					title={h265Supported ? undefined : $LL.live.encoder.codecH265Unavailable()}
				>
					H.265
				</button>
			</div>
			{#if codecIsAuto}
				<p class="text-muted-foreground text-xs" data-testid="codec-auto-resolved">
					{resolvedAutoCodec === 'h265'
						? $LL.live.encoder.codecAutoResolvedH265()
						: $LL.live.encoder.codecAutoResolvedH264()}
				</p>
			{/if}
			{#if codecIsH265 && h265SoftwareOnly}
				<p class="text-status-warning text-xs" data-testid="codec-h265-software">
					{$LL.settings.softwareEncodeWarning()}
				</p>
			{/if}
		</div>

		<!-- Bitrate LEADS (first-class, out of Advanced): slider + number input share
		     ONE board window (BITRATE.min‥max) and ONE clamp, so the two controls can
		     never diverge. -->
		<div class="bg-muted/40 space-y-3 rounded-lg border p-4" data-testid="encoder-bitrate-control">
			<div class="flex items-center justify-between gap-2">
				<Label class="text-sm font-medium" for="encoder-bitrate">{$LL.settings.bitrate()}</Label>
				<span class="bg-primary/10 text-primary rounded-md px-2 py-1 font-mono text-xs">
					{Number.isFinite(localBitrate) ? localBitrate : BITRATE.defaultMin}
				</span>
			</div>
			<Slider
				aria-label={$LL.settings.bitrate()}
				max={BITRATE.max}
				min={BITRATE.min}
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
			<p class="text-muted-foreground text-xs" data-testid="bitrate-range-hint">
				{$LL.live.encoder.bitrateRangeHint()}: {BITRATE.min}–{BITRATE.max}
				{$LL.units.kbps()}
			</p>
			{#if bitrateClamped}
				<p class="text-status-warning text-xs" data-testid="bitrate-clamped">
					{$LL.live.encoder.bitrateClamped()}
				</p>
			{/if}
			{#if errors.bitrate}
				<p class="text-destructive text-sm" id="encoder-bitrate-error">{errors.bitrate}</p>
			{/if}
			{#if isStreaming}
				<p class="text-muted-foreground bg-muted rounded-md p-2 text-xs">
					{$LL.settings.changeBitrateNotice()}
				</p>
			{/if}
		</div>

		<!-- Capability-gated Resolution + Framerate axes (offeredAxes): platform ∩
		     source ∩ Tier-2 device modes. A single current-vs-device-max summary line
		     replaces the old preset highlighting. -->
		<div class="space-y-5">
				{#if localSource}
					<div
						class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
						data-testid="axis-summary"
					>
						<span class="font-medium">{$LL.live.encoder.axisSelected()}:</span>
						<span class="text-foreground font-mono" data-testid="axis-current">
							{getResolutionLabel(localResolution)} · {getFramerateLabel(localFramerate)}
						</span>
						<span aria-hidden={true}>·</span>
						<span>{$LL.live.encoder.axisDeviceMax()}:</span>
						<span class="text-foreground font-mono" data-testid="axis-device-max">
							{ceiling.resolution ? getResolutionLabel(ceiling.resolution) : '\u2014'} · {ceiling.framerate
								? getFramerateLabel(ceiling.framerate)
								: '\u2014'}
						</span>
					</div>
				{/if}

				<!-- Resolution: every rung is shown; rungs outside the capability-offered
				     set render disabled (aria-disabled + reason title), never hidden. -->
				{#if localSource}
					<div class="space-y-2">
						<div class="flex items-center justify-between gap-2">
							<Label class="text-sm font-medium" for="encoder-resolution">
								{$LL.settings.encodingResolution()}
							</Label>
							<AppliesNextStart
								show={resolutionAppliesNextStart}
								label={$LL.live.encoder.appliesNextStart()}
								data-testid="resolution-applies-next-start"
							/>
						</div>
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
											title={option.reason ? t(option.reason) : undefined}
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
						<div class="flex items-center justify-between gap-2">
							<Label class="text-sm font-medium" for="encoder-framerate">
								{$LL.settings.framerate()}
							</Label>
							<AppliesNextStart
								show={framerateAppliesNextStart}
								label={$LL.live.encoder.appliesNextStart()}
								data-testid="framerate-applies-next-start"
							/>
						</div>
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
											title={option.reason ? t(option.reason) : undefined}
											value={String(option.value)}
										></Select.Item>
									{/each}
								</Select.Group>
							</Select.Content>
						</Select.Root>
					</div>
				{/if}

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
	</div>
</AppDialog>
