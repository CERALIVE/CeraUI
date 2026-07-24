<!--
  EncoderDialog.svelte — focused video-encoder configuration dialog.

  Pure encoding (no source selection): the dialog exposes independent
  codec / bitrate / resolution / framerate selectors directly. There is no
  mode-preset catalog — every control is capability-gated on its own. The active
  source is chosen in the Source section and shown here as a READ-ONLY context
  line (name + kind); this dialog never writes `source`/`pipeline`.

  Capability discipline
  ---------------------
  • Resolution / Framerate come from `offeredAxes` (platform ∩ active source ∩
    that source's Tier-2 device modes). Framerate is gated PER selected resolution,
    so a rate the device can't drive at that resolution renders
    disabled-with-reason. Every rung outside the offered set renders DISABLED with a
    reason tooltip — never hidden. H.265 is disabled-with-reason when the platform
    can't encode it. With no active source (config lacking `source`/`pipeline`, e.g.
    a federated mount) the axes degrade to the platform-coarse offering.
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
import type { Framerate, Resolution, VideoCodec, VideoPassthrough } from '@ceraui/rpc/schemas';

export interface EncoderConfig {
	// Legacy field: the encoder dialog is pure encoding and no longer selects or
	// emits a source — the active input is owned by the Source section and echoed
	// on `config.source`. Kept optional so existing consumers (LiveView's draft)
	// stay compile-compatible; the dialog never sets it.
	source?: string;
	resolution: Resolution | undefined;
	framerate: Framerate | undefined;
	bitrate: number | undefined;
	bitrateOverlay: boolean | undefined;
	// Egress video codec. `undefined` = "Auto (recommended)" → the engine's
	// platform default (never written to `video_codec`); `h264`/`h265` = the
	// operator's explicit choice. Optional so callers that don't set it (LiveView
	// seed) stay valid.
	codec?: VideoCodec;
	// Same-codec passthrough policy (auto/force/off). Optional so a seed without
	// it stays valid; the dialog defaults it to `auto` on open.
	passthrough?: VideoPassthrough;
}
</script>

<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Binary, Cable, Cpu, Radio, SquareDashed, Usb, Video } from '@lucide/svelte';
import { BITRATE_DEFAULT_MIN, type DeviceKind, type StreamSource } from '@ceraui/rpc/schemas';

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
	type FramerateOption,
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
	sourceLabel,
} from '$lib/helpers/PipelineHelper';
import {
	getCapabilities,
	getConfig,
	getDevices,
	getIsStreaming,
	getPipelines,
	getSources,
} from '$lib/rpc/subscriptions.svelte';
import { appliesOnNextStart } from '$lib/streaming/appliesNextStart';
import {
	captureModeCodecs,
	resolvePassthroughMode,
	sourceOffersCodec,
} from '$lib/streaming/passthrough';

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

// A disabled framerate option's title = its capability reason plus its OWN
// "available elsewhere" hint (per-option: different rates disabled at the same
// resolution get different hints). No hint → the plain reason; no new literals.
function framerateOptionTitle(option: FramerateOption): string | undefined {
	if (!option.reason) return undefined;
	const reason = t(option.reason);
	if (!option.hint) return reason;
	const hint = $LL.live.encoder.fpsAvailableAt({
		fps: option.hint.fps,
		resolution: getResolutionLabel(option.hint.resolution),
	});
	return `${reason} \u2014 ${hint}`;
}

// ── Editable working copy (seeded when the dialog opens) ───────────────────────
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

// Same-codec passthrough policy (auto/force/off). Defaults to auto on open.
let localPassthrough = $state<VideoPassthrough>('auto');
const passthroughIsAuto = $derived(localPassthrough === 'auto');
const passthroughIsForce = $derived(localPassthrough === 'force');
const passthroughIsOff = $derived(localPassthrough === 'off');

// Whether the last bitrate commit was snapped into the board window (drives the
// inline "adjusted to the supported range" notice).
let bitrateClamped = $state(false);

// Seed snapshot captured on open: edits are measured against these so a
// restart-required field changed mid-stream can be badged "applies on next start".
let seededResolution = $state<Resolution>('1080p');
let seededFramerate = $state<Framerate>(30);

// Seed the working copy from the bound draft first, falling back to the saved
// device config. Re-seed on every open so a cancelled edit is fully discarded.
let seeded = $state(false);
// The source id the draft was last seeded for. When `config.source` changes while
// the dialog is open (the operator picked a new input in the Source section) the
// draft is RE-seeded from the NEW active config and a calm note is surfaced —
// never a silent swap. Federation-safe: with no source in config both stay
// undefined and the initial seed path is byte-unchanged.
let seededSource = $state<string | undefined>(undefined);
let sourceChangedNote = $state(false);

function seedDraft(fromSaved: boolean): void {
	if (fromSaved) {
		// Re-seed from the NEW active config (getConfig): the operator switched
		// source in the Source section, so the bound draft is stale — the device
		// config is the truth for the new input.
		localResolution = savedConfig?.resolution ?? '1080p';
		localFramerate = savedConfig?.framerate ?? 30;
		const seedBitrate = savedConfig?.max_br ?? BITRATE.defaultMin;
		localBitrate = Number.isFinite(seedBitrate) ? seedBitrate : BITRATE.defaultMin;
		localOverlay = savedConfig?.bitrate_overlay ?? false;
		localCodec = savedConfig?.video_codec;
		localPassthrough = savedConfig?.video_passthrough ?? 'auto';
	} else {
		localResolution = config?.resolution ?? '1080p';
		localFramerate = config?.framerate ?? 30;
		const seedBitrate = config?.bitrate ?? savedConfig?.max_br ?? BITRATE.defaultMin;
		localBitrate = Number.isFinite(seedBitrate) ? seedBitrate : BITRATE.defaultMin;
		localOverlay = config?.bitrateOverlay ?? savedConfig?.bitrate_overlay ?? false;
		localCodec = config?.codec;
		localPassthrough = config?.passthrough ?? savedConfig?.video_passthrough ?? 'auto';
	}
	seededResolution = localResolution;
	seededFramerate = localFramerate;
	bitrateClamped = false;
}

$effect(() => {
	const currentSource = savedConfig?.source;
	if (open && !seeded) {
		seedDraft(false);
		seededSource = currentSource;
		sourceChangedNote = false;
		seeded = true;
	} else if (open && seeded && currentSource !== seededSource) {
		seedDraft(true);
		seededSource = currentSource;
		sourceChangedNote = true;
	} else if (!open) {
		seeded = false;
		sourceChangedNote = false;
	}
});

// ── Active source (read-only context) ──────────────────────────────────────────
// The source is chosen in the Source section; this dialog only reflects it. The
// active StreamSource (from `getSources()`, keyed by the persisted `config.source`)
// drives the read-only context line AND the capability axes below. When no source
// is set (config lacking `source`/`pipeline`, e.g. a federated mount) it is
// undefined and the axes fall back to the platform-coarse offering — no throw.
const activeSource = $derived(
	getSources()?.sources.find((source) => source.id === savedConfig?.source),
);

// ── Passthrough resolved-mode disclosure (pre-start) ───────────────────────────
// The resolved output codec (explicit pick or the Auto-resolved default) drives
// whether the active source can be passed through. Under the honest todo-16
// policy adaptive bitrate is always active (there is no operator control to make
// it fixed), so `auto` always transcodes — passthrough surfaces only for `force`.
const passthroughOutputCodec = $derived<VideoCodec>(localCodec ?? resolvedAutoCodec);
const activeSourceKind = $derived(
	activeSource?.origin === 'capture' ? activeSource.kind : undefined,
);
// A dual-codec device's `kind` collapses to one value, so pass the truthful
// modes-derived codec set: it keeps passthrough eligibility correct when the
// operator picks the codec the collapsed `kind` doesn't name.
const activeSourceCodecs = $derived(
	activeSource?.origin === 'capture' ? captureModeCodecs(activeSource.modes) : undefined,
);
const passthroughSourceEligible = $derived(
	sourceOffersCodec(activeSourceKind, passthroughOutputCodec, activeSourceCodecs),
);
const resolvedPassthroughMode = $derived(
	resolvePassthroughMode({
		setting: localPassthrough,
		sourceOffersOutputCodec: passthroughSourceEligible,
		adaptiveActive: true,
	}),
);
const passthroughActive = $derived(resolvedPassthroughMode === 'passthrough');
// A human token for the source's incoming codec, used in the transcode line
// ("Re-encoding <in>→<out>"). Raw/HDMI/network sources have no codec token.
const inputCodecLabel = $derived.by<string>(() => {
	if (activeSourceKind === 'mjpeg') return 'MJPEG';
	if (activeSourceKind === 'uvc_h264') return 'H.264';
	if (activeSourceKind === 'uvc_h265') return 'H.265';
	return $LL.live.encoder.passthrough.inputRaw();
});
const outputCodecLabel = $derived(passthroughOutputCodec === 'h265' ? 'H.265' : 'H.264');

// Capture kind → coarse device family. Drives the context-line ICON only: a UVC
// dongle (`uvc_h264`) is USB family, so it gets the USB glyph. The visible kind
// label below is the SPECIFIC pipeline/profile ("UVC H.264", "MJPEG", "Cam Link"),
// mirroring SourceSection — never the coarse "USB" collapse.
type SourceKindFamily = 'hdmi' | 'usb' | 'network' | 'other';
function kindFamily(kind: DeviceKind): SourceKindFamily {
	if (kind === 'hdmi') return 'hdmi';
	if (kind === 'network') return 'network';
	if (
		kind === 'usb' ||
		kind === 'uvc_h264' ||
		kind === 'uvc_h265' ||
		kind === 'mjpeg' ||
		kind === 'camlink'
	) {
		return 'usb';
	}
	return 'other';
}
const SOURCE_KIND_ICON = { hdmi: Cable, usb: Usb, network: Radio, other: Video } as const;
function sourceKindLabel(source: StreamSource): string {
	if (source.origin === 'capture') return t(`live.inputPicker.groups.${source.kind}`);
	if (source.origin === 'network') return t('live.inputPicker.groups.network');
	if (source.origin === 'virtual') return t('live.inputPicker.groups.test');
	return t('live.inputPicker.groups.other');
}
function sourceIcon(source: StreamSource) {
	if (source.origin === 'capture') return SOURCE_KIND_ICON[kindFamily(source.kind)];
	if (source.origin === 'virtual') return SquareDashed;
	if (source.origin === 'network') return Radio;
	return Video;
}

// Restart-required edits made mid-stream → "applies on next start" badges. The
// edit test is against the open-time seed so an untouched field stays quiet.
const resolutionAppliesNextStart = $derived(
	appliesOnNextStart('resolution', isStreaming, localResolution !== seededResolution),
);
const framerateAppliesNextStart = $derived(
	appliesOnNextStart('framerate', isStreaming, localFramerate !== seededFramerate),
);

// Capability-gated axes: platform ∩ active source ∩ that source's Tier-2 device
// modes (source-keyed — T16). The StreamSource carries its own `modes`, so a
// selected/kind-matched capture device narrows Resolution/Framerate; a coarse /
// modeless source (or no source at all) degrades to the platform offering. Every
// incompatible rung is shown disabled with a reason — never hidden (house rule).
const axes = $derived(offeredAxes(hardware, activeSource));
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

// Codec validity: an explicit H.265 pick is invalid when the platform can't
// encode it (the same gate that disables the H.265 segment).
const codecSupported = $derived(localCodec !== 'h265' || h265Supported);

// Save-time axis/codec re-validation (C7). The draft is re-checked against the
// CURRENT offered set — the SAME derivations that drive each control's
// aria-invalid — so a device unplug that shrinks the offered axes blocks save
// with the SAME resolved disabled-reason copy rendered inline (never a toast).
// Returns the first blocking reason, or undefined when the whole selection is
// offered. Federation-safe: with no source the axes degrade to the coarse
// offering, so the current selection stays valid and save is never blocked.
const axisSaveError = $derived.by<string | undefined>(() => {
	if (!resolutionSupported) {
		const option = resolutionChoices.find((choice) => choice.value === localResolution);
		return option?.reason ? t(option.reason) : $LL.validation.invalid();
	}
	if (!framerateSupported) {
		const option = framerateChoices.find((choice) => choice.value === localFramerate);
		return option?.reason ? framerateOptionTitle(option) : $LL.validation.invalid();
	}
	if (!codecSupported) return $LL.live.encoder.codecH265Unavailable();
	return undefined;
});

// Save is gated on bitrate validity AND the axis/codec re-validation.
const canSave = $derived(isValid && axisSaveError === undefined);

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
	// Re-validate the draft against the CURRENT offered axes/codec set at save
	// time (defence-in-depth beside the disabled primary button): an axis the
	// hardware no longer offers blocks save and surfaces the inline reason.
	if (!canSave) return;
	const normalized = normalizeValue(localBitrate, BITRATE.min, BITRATE.max, BITRATE_STEP);
	localBitrate = normalized;

	// Persist the encoding selection into the draft LiveView owns + feeds the start
	// flow. This dialog is pure encoding: it NEVER writes `source`/`pipeline` (the
	// Source section owns the active input). Resolution/framerate stay capability-
	// gated against the active source's override support; when no source is known
	// (federated mount) they pass through and the consumer re-gates on the pipeline.
	const allowResolution = activeSource?.supportsResolutionOverride ?? true;
	const allowFramerate = activeSource?.supportsFramerateOverride ?? true;
	const next: EncoderConfig = {
		resolution: allowResolution ? localResolution : undefined,
		framerate: allowFramerate ? localFramerate : undefined,
		bitrate: normalized,
		bitrateOverlay: localOverlay,
		codec: localCodec,
		passthrough: localPassthrough,
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
	primaryDisabled={!canSave}
	primaryLabel={$LL.dialogs.save()}
	title={$LL.settings.encoderSettings()}
>
	<div class="space-y-5">
		{#if sourceChangedNote}
			<p
				class="text-muted-foreground bg-muted/40 rounded-md border px-3 py-2 text-xs"
				data-testid="encoder-source-changed-note"
				role="status"
			>
				{$LL.live.encoder.sourceChangedNote()}
			</p>
		{/if}

		{#if hardware}
			<div class="text-muted-foreground flex items-center gap-2 text-xs">
				<Cpu aria-hidden={true} class="size-3.5 shrink-0" />
				<span>{getHardwareLabel(hardware, t)}</span>
			</div>
		{/if}

		<!-- Active source (read-only, name + kind): chosen in the Source section, not
		     here. Absent when the config carries no source (e.g. a federated mount). -->
		<div class="space-y-2">
			{#if activeSource}
				{@const SourceIcon = sourceIcon(activeSource)}
				<div
					class="bg-muted/30 flex items-center gap-2.5 rounded-md border p-2.5"
					data-testid="encoder-active-source"
					data-origin={activeSource.origin}
					data-source-id={activeSource.id}
				>
					<SourceIcon aria-hidden={true} class="text-muted-foreground size-4 shrink-0" />
					<div class="flex min-w-0 flex-col">
						<span class="truncate text-sm font-medium">{sourceLabel(activeSource, t)}</span>
						<span class="text-muted-foreground text-xs" data-testid="encoder-active-source-kind">
							{sourceKindLabel(activeSource)}
						</span>
					</div>
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

		<!-- Same-codec passthrough policy (advanced): Auto / Force / Off. The resolved
		     mode is disclosed BEFORE start so `force` is safe — the operator sees the
		     consequence (camera controls bitrate; adaptive bonded bitrate inactive)
		     ahead of going live, never only while streaming. -->
		<div class="space-y-2">
			<Label class="text-sm font-medium">{$LL.live.encoder.passthrough.title()}</Label>
			<div
				class="bg-card/40 grid grid-cols-3 gap-1.5 rounded-lg border p-1"
				aria-label={$LL.live.encoder.passthrough.title()}
				data-testid="encoder-passthrough-selector"
				role="radiogroup"
			>
				<button
					type="button"
					aria-checked={passthroughIsAuto}
					class="flex min-h-[44px] items-center justify-center rounded-md px-2 py-2 text-xs font-medium transition-colors {passthroughIsAuto
						? 'bg-primary/10 text-primary ring-primary ring-1'
						: 'text-muted-foreground hover:bg-primary/5'}"
					data-active={passthroughIsAuto}
					data-testid="passthrough-auto"
					onclick={() => (localPassthrough = 'auto')}
					role="radio"
				>
					{$LL.live.encoder.passthrough.auto()}
				</button>
				<button
					type="button"
					aria-checked={passthroughIsForce}
					class="flex min-h-[44px] items-center justify-center rounded-md px-2 py-2 text-xs font-medium transition-colors {passthroughIsForce
						? 'bg-primary/10 text-primary ring-primary ring-1'
						: 'text-muted-foreground hover:bg-primary/5'}"
					data-active={passthroughIsForce}
					data-testid="passthrough-force"
					onclick={() => (localPassthrough = 'force')}
					role="radio"
				>
					{$LL.live.encoder.passthrough.force()}
				</button>
				<button
					type="button"
					aria-checked={passthroughIsOff}
					class="flex min-h-[44px] items-center justify-center rounded-md px-2 py-2 text-xs font-medium transition-colors {passthroughIsOff
						? 'bg-primary/10 text-primary ring-primary ring-1'
						: 'text-muted-foreground hover:bg-primary/5'}"
					data-active={passthroughIsOff}
					data-testid="passthrough-off"
					onclick={() => (localPassthrough = 'off')}
					role="radio"
				>
					{$LL.live.encoder.passthrough.off()}
				</button>
			</div>
			<!-- Resolved-mode disclosure: derived from setting + source kind + output
			     codec, shown pre-start so the operator knows the consequence. -->
			{#if resolvedPassthroughMode === 'passthrough'}
				<p
					class="text-primary bg-primary/5 rounded-md p-2 text-xs"
					data-testid="passthrough-disclosure"
					data-mode="passthrough"
				>
					{$LL.live.encoder.passthrough.disclosurePassthrough()}
				</p>
			{:else if resolvedPassthroughMode === 'forceUnavailable'}
				<p
					class="text-status-warning bg-status-warning/10 rounded-md p-2 text-xs"
					data-testid="passthrough-disclosure"
					data-mode="forceUnavailable"
				>
					{$LL.live.encoder.passthrough.disclosureForceUnavailable()}
				</p>
			{:else}
				<p
					class="text-muted-foreground bg-muted rounded-md p-2 text-xs"
					data-testid="passthrough-disclosure"
					data-mode="transcode"
				>
					{$LL.live.encoder.passthrough.disclosureTranscode({
						input: inputCodecLabel,
						output: outputCodecLabel,
					})}
				</p>
			{/if}
		</div>

		<!-- Bitrate LEADS (first-class, out of Advanced): slider + number input share
		     ONE board window (BITRATE.min‥max) and ONE clamp, so the two controls can
		     never diverge. While passthrough is the resolved mode the camera fixes the
		     bitrate, so both controls disable with a visible reason (never a silent
		     no-op). -->
		<div class="bg-muted/40 space-y-3 rounded-lg border p-4" data-testid="encoder-bitrate-control">
			<div class="flex items-center justify-between gap-2">
				<Label class="text-sm font-medium" for="encoder-bitrate">{$LL.settings.bitrate()}</Label>
				<span class="bg-primary/10 text-primary rounded-md px-2 py-1 font-mono text-xs">
					{Number.isFinite(localBitrate) ? localBitrate : BITRATE.defaultMin}
				</span>
			</div>
			<Slider
				aria-label={$LL.settings.bitrate()}
				disabled={passthroughActive}
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
				disabled={passthroughActive}
				max={BITRATE.max}
				min={BITRATE.min}
				oninput={(e) => commitBitrate(parseInt(e.currentTarget.value, 10))}
				step={BITRATE_STEP}
				type="number"
				value={Number.isFinite(localBitrate) ? localBitrate : BITRATE.defaultMin}
			/>
			{#if passthroughActive}
				<p
					class="text-muted-foreground bg-muted rounded-md p-2 text-xs"
					data-testid="bitrate-passthrough-disabled"
				>
					{$LL.live.encoder.passthrough.bitrateFixed()}
				</p>
			{/if}
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

			<!-- Resolution: every rung is shown; rungs outside the capability-offered
			     set render disabled (aria-disabled + reason title), never hidden. -->
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

			<!-- Framerate: same capability filtering as resolution — incompatible
			     rates render disabled with a reason, never hidden. -->
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
									title={framerateOptionTitle(option)}
									value={String(option.value)}
								></Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
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

		<!-- Save-time re-validation reason (C7): an axis/codec the hardware no longer
		     offers blocks save; the resolved disabled-reason renders inline here,
		     never as a toast. -->
		{#if axisSaveError}
			<p class="text-destructive text-sm" data-testid="encoder-save-blocked" role="alert">
				{axisSaveError}
			</p>
		{/if}
	</div>
</AppDialog>
