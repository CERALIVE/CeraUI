<!--
  EncoderDialog.svelte — focused video-encoder configuration dialog.

  Mode-presets lead (Task 7): the shared mode-preset catalog
  (`@ceraui/rpc` CANONICAL_PRESETS) is the primary surface — a grid of tuned
  resolution/framerate/codec profiles. Selecting one seeds the editable encoder
  draft through the pure `modePresets` mapper and drives the Task-5 field-sync
  state machine so the apply reads applying → applied (or failed). The granular
  resolution / framerate / codec / bitrate controls remain, in full, under an
  "Advanced / Custom" expander; editing any preset-defined field there returns
  the surface to "Custom" (no active preset) automatically.

  Capability discipline
  ---------------------
  • A preset whose resolution/framerate/codec is NOT in the offered set
    (`presetMatchesOffered`) renders DISABLED with a reason tooltip — never
    hidden. Same rule the resolution/framerate option lists already follow.
  • All numeric bounds come from `streamingConstraints` / `bitrateBoundsFromCaps`
    (ValidationAdapter) — no inline literals.

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
import {
	CANONICAL_PRESETS,
	MEDIA_TYPE_H264,
	MEDIA_TYPE_H265,
	type ModePreset,
	presetMatchesOffered,
} from '@ceraui/rpc';
import { Binary, Check, ChevronDown, Cpu, SlidersHorizontal, TriangleAlert } from '@lucide/svelte';
import { BITRATE_DEFAULT_MIN, type Pipeline } from '@ceraui/rpc/schemas';

import AppliesNextStart from '$lib/components/custom/AppliesNextStart.svelte';
import FieldSyncIndicator from '$lib/components/custom/FieldSyncIndicator.svelte';
import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import PreviewCanvas from '$lib/components/preview/PreviewCanvas.svelte';
import {
	bitrateBoundsFromCaps,
	clampBitrateToBounds,
	deriveCodecOptions,
	deriveUvcH265Sources,
	framerateOptions,
	offeredEncoderCaps,
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
	beginFieldSync,
	markFieldApplied,
	markFieldApplying,
	markFieldFailed,
} from '$lib/rpc/field-sync-state.svelte';
import {
	getCapabilities,
	getConfig,
	getDevices,
	getIsStreaming,
	getPipelines,
} from '$lib/rpc/subscriptions.svelte';
import { appliesOnNextStart } from '$lib/streaming/appliesNextStart';
import {
	findMatchingPresetId,
	presetToDraft,
	presetViews,
	videoCodecFromMediaType,
} from '$lib/streaming/modePresets';

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

// Pseudo-field key for the preset apply's field-sync lifecycle. It is NOT a
// persisted config field (the draft is committed on Save); it exists only so the
// preset apply reads applying → applied/failed through the Task-5 machine and the
// shared FieldSyncIndicator. Not a status field, so beginFieldSync accepts it.
const PRESET_FIELD = 'encoderPreset';

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

// Compact spec labels for the preset cards (JetBrains Mono spec values).
const presetResLabel = (resolution: Resolution): string =>
	resolution === '2160p' || resolution === '4k' ? '4K' : resolution;
const codecShortLabel = (mediaType: string): string =>
	mediaType === MEDIA_TYPE_H265 ? 'H.265' : mediaType === MEDIA_TYPE_H264 ? 'H.264' : mediaType;

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
// The codec the current selection resolves to (explicit choice, else Auto), plus
// the segmented-selector active-state (Auto = undefined selection).
const effectiveCodec = $derived<VideoCodec>(localCodec ?? resolvedAutoCodec);
const codecIsAuto = $derived(localCodec === undefined);
const codecIsH264 = $derived(localCodec === 'h264');
const codecIsH265 = $derived(localCodec === 'h265');
// The preset the operator last applied (or that matched on seed). The visible
// active state is the derived `activePresetId`, which clears this to "Custom" the
// moment any preset-defined field diverges or the preset becomes unsupported.
let selectedPresetId = $state<string | null>(null);
let advancedOpen = $state(false);

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
		// Highlight a preset that matches the seeded resolution/framerate/codec
		// (Auto resolves to the platform default for matching); otherwise the
		// surface opens in "Custom" with the Advanced section expanded.
		const matchId = findMatchingPresetId(
			{ resolution: localResolution, framerate: localFramerate },
			localCodec ?? resolvedAutoCodec,
		);
		selectedPresetId = matchId;
		advancedOpen = matchId === null;
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

// Capability-driven offered set (platform ∩ selected source) from intersectCaps.
// Drives per-option enable/disable so an incompatible resolution/framerate/preset
// is shown disabled with a reason rather than hidden or all-or-nothing gated.
const offered = $derived(offeredEncoderCaps(hardware, localSource || undefined, selectedPipeline));
const resolutionChoices = $derived(resolutionOptions(offered));
const framerateChoices = $derived(framerateOptions(offered));
const resolutionSupported = $derived(offered.resolutions.includes(localResolution));
const framerateSupported = $derived(offered.framerates.includes(localFramerate));

// Preset cards tagged with their capability verdict (supported / disabled+reason).
const presetCards = $derived(presetViews(offered));

// The VISIBLE active preset: the last selection, but only while it still matches
// every preset-defined field AND is still offered. Any Advanced edit that diverges
// a field (or a source change that makes the preset unsupported) drops it to
// "Custom" with no extra wiring — purely derived.
const activePresetId = $derived.by<string | null>(() => {
	if (selectedPresetId === null) return null;
	const preset = CANONICAL_PRESETS[selectedPresetId];
	if (!preset) return null;
	if (preset.resolution !== localResolution) return null;
	if (preset.framerate !== localFramerate) return null;
	if (videoCodecFromMediaType(preset.codec) !== effectiveCodec) return null;
	if (
		preset.bitrateDefault !== undefined &&
		clampBitrateToBounds(preset.bitrateDefault, BITRATE) !== localBitrate
	) {
		return null;
	}
	return presetMatchesOffered(preset, offered) ? selectedPresetId : null;
});

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

/** Build the current draft snapshot the preset mapper extends. */
function currentDraft(): EncoderConfig {
	return {
		source: localSource || undefined,
		resolution: localResolution,
		framerate: localFramerate,
		bitrate: localBitrate,
		bitrateOverlay: localOverlay,
		codec: localCodec,
	};
}

/**
 * Apply a preset onto the draft, driving the field-sync lifecycle so the apply
 * reads applying → applied (or failed for an unsupported preset, which the UI
 * also blocks by disabling the card). Uses the pure `presetToDraft` mapper so the
 * preset→field mapping has one unit-tested source of truth.
 */
function applyPreset(preset: ModePreset) {
	beginFieldSync(PRESET_FIELD, preset.id);
	markFieldApplying(PRESET_FIELD);
	if (!presetMatchesOffered(preset, offered)) {
		markFieldFailed(PRESET_FIELD, selectedPresetId);
		return;
	}
	const next = presetToDraft(preset, currentDraft(), BITRATE);
	if (next.resolution) localResolution = next.resolution;
	if (next.framerate) localFramerate = next.framerate;
	if (next.bitrate !== undefined) localBitrate = next.bitrate;
	// The preset TRULY applies its codec: an explicit choice, so the preset stays
	// active (not reset to Auto) and `video_codec` is written on save.
	localCodec = next.codec;
	selectedPresetId = preset.id;
	markFieldApplied(PRESET_FIELD, preset.id);
}

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

		<!-- Mode presets LEAD: tuned resolution/framerate/codec profiles. A preset
		     outside the offered set renders disabled with a reason, never hidden. -->
		<div class="space-y-2">
			<div class="flex items-center justify-between gap-2">
				<Label class="text-sm font-medium">{$LL.live.presets.heading()}</Label>
				<FieldSyncIndicator
					field={PRESET_FIELD}
					applyingLabel={$LL.live.presets.applying()}
					appliedLabel={$LL.live.presets.applied()}
					failedLabel={$LL.live.presets.failed()}
					data-testid="preset-sync"
				/>
			</div>
			<div
				class="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr))]"
				data-testid="mode-presets"
			>
				{#each presetCards as view (view.preset.id)}
					{@const active = activePresetId === view.preset.id}
					<button
						type="button"
						aria-disabled={view.supported ? undefined : 'true'}
						aria-pressed={active}
						class="group flex min-h-[44px] flex-col gap-0.5 rounded-lg border p-3 text-start transition-colors
							{active
							? 'border-primary bg-primary/10 ring-1 ring-primary'
							: view.supported
								? 'border-border bg-card/40 hover:border-primary/50 hover:bg-primary/5'
								: 'border-border bg-muted/30 cursor-not-allowed opacity-50'}"
						data-active={active}
						data-preset-id={view.preset.id}
						data-supported={view.supported}
						data-testid="mode-preset"
						disabled={!view.supported}
						onclick={() => applyPreset(view.preset)}
						title={view.supported ? undefined : t(view.reason ?? '')}
					>
						<span class="flex items-center justify-between gap-1">
							<span
								class="font-mono text-sm font-semibold {active
									? 'text-primary'
									: 'text-foreground'}"
							>
								{presetResLabel(view.preset.resolution)}
							</span>
							{#if active}
								<Check aria-hidden={true} class="text-primary size-3.5 shrink-0" />
							{:else if !view.supported}
								<TriangleAlert
									aria-hidden={true}
									class="text-muted-foreground size-3.5 shrink-0"
								/>
							{/if}
						</span>
						<span class="text-muted-foreground font-mono text-xs">
							{getFramerateLabel(view.preset.framerate)} · {codecShortLabel(view.preset.codec)}
						</span>
						{#if view.preset.bitrateDefault !== undefined}
							<span class="text-muted-foreground/80 text-micro font-mono">
								{view.preset.bitrateDefault} {$LL.units.kbps()}
							</span>
						{/if}
					</button>
				{/each}
			</div>
		</div>

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

		<!-- Advanced / Custom: the full granular controls. Editing any preset-defined
		     field here drops the active preset to "Custom" (via activePresetId). -->
		<details bind:open={advancedOpen} class="bg-card/40 rounded-lg border">
			<summary
				class="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden"
				data-testid="encoder-advanced-summary"
			>
				<span class="flex items-center gap-2">
					<SlidersHorizontal aria-hidden={true} class="text-muted-foreground size-4 shrink-0" />
					{$LL.live.presets.advanced()}
				</span>
				<ChevronDown
					aria-hidden={true}
					class="text-muted-foreground size-4 shrink-0 transition-transform {advancedOpen
						? 'rotate-180'
						: ''}"
				/>
			</summary>

			<div class="space-y-5 border-t px-4 py-4">
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
											title={option.reason}
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
		</details>
	</div>
</AppDialog>
