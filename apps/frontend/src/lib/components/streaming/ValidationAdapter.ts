import {
	deviceKindToPipelineId,
	intersectCaps,
	MEDIA_TYPE_H264,
	MEDIA_TYPE_H265,
	mediaTypeToSourceKind,
	type OfferedSet,
	type PlatformCaps,
	type VideoSourceCap,
} from "@ceraui/rpc";
import {
	AUDIO_DELAY_MAX,
	AUDIO_DELAY_MIN,
	AVAILABLE_FRAMERATES,
	AVAILABLE_RESOLUTIONS,
	BITRATE_DEFAULT_MAX,
	BITRATE_DEFAULT_MIN,
	BITRATE_MAX,
	BITRATE_MIN,
	type CapabilitiesMessage,
	type CaptureCap,
	type CaptureDevice,
	type DeviceMode,
	type DeviceModeGroup,
	type Framerate,
	type HardwareType,
	HOTSPOT_NAME_MAX,
	HOTSPOT_NAME_MIN,
	HOTSPOT_PASSWORD_MAX,
	HOTSPOT_PASSWORD_MIN,
	normalizeFramerateToRung,
	normalizeResolutionToRung,
	type Pipeline,
	PORT_MAX,
	PORT_MIN,
	type Resolution,
	SIM_PIN_MAX_LENGTH,
	SIM_PIN_MIN_LENGTH,
	SIM_PUK_LENGTH,
	SRT_LATENCY_MAX,
	SRT_LATENCY_MIN,
	WIFI_PASSWORD_MIN,
} from "@ceraui/rpc/schemas";

export const streamingConstraints = {
	bitrate: {
		min: BITRATE_MIN,
		max: BITRATE_MAX,
		defaultMin: BITRATE_DEFAULT_MIN,
		defaultMax: BITRATE_DEFAULT_MAX,
	},
	srtLatency: { min: SRT_LATENCY_MIN, max: SRT_LATENCY_MAX },
	audioDelay: { min: AUDIO_DELAY_MIN, max: AUDIO_DELAY_MAX },
	port: { min: PORT_MIN, max: PORT_MAX },
} as const;

// Port parse + bounds live here (not inlined in dialogs) so the PORT_MIN/PORT_MAX
// schema bounds stay the single source, per the no-inline-literals rule.
export function parsePort(value: string): number | undefined {
	return value.trim() === "" ? undefined : Number.parseInt(value, 10);
}

export function isPortValid(value: number | undefined): boolean {
	return (
		value !== undefined &&
		Number.isInteger(value) &&
		value >= streamingConstraints.port.min &&
		value <= streamingConstraints.port.max
	);
}

// ── Capability-driven encoder option bounds ──────────────────────────────────
//
// The encoder dialog no longer treats the static AVAILABLE_RESOLUTIONS /
// AVAILABLE_FRAMERATES arrays as the source of truth for what is selectable.
// Instead it asks `intersectCaps()` (the shared, pure capability-intersection
// helper) for the OFFERED set given the current platform ∩ selected source, and
// renders any option OUTSIDE that set as disabled + a reason tooltip (never
// hidden). The arrays remain only as the candidate universe to iterate over so
// incompatible rungs can still be shown, greyed out, with an explanation.

export const STREAMING_MODE = "streaming";

// i18n keys for disabled-option reason tooltips. Consumers pass these to LL
// (e.g. LL.live.education.reason.unsupportedPlatform()) — never render the key
// string directly. The key names are the stable contract; the English text lives
// in packages/i18n/src/en/index.ts under live.education.reason.*.
export const OPTION_UNSUPPORTED_ON_PLATFORM =
	"live.education.reason.unsupportedPlatform" as const;
export const OPTION_FIXED_BY_SOURCE =
	"live.education.reason.fixedBySource" as const;
// A framerate the device offers at SOME resolution, but not at the currently
// selected one — a per-resolution device-mode limit (offeredAxes), distinct from
// a platform/source ceiling.
export const OPTION_UNSUPPORTED_AT_RESOLUTION =
	"live.education.reason.unsupportedAtResolution" as const;

// Network-ingest gateway availability — re-surfaced from the single-source-of-
// truth helper (`$lib/streaming/pipelineAvailability`) so the disabled-reason key
// family stays together. The rule itself is NEVER re-implemented here.
export {
	isPipelineAvailable,
	PIPELINE_GATEWAY_INACTIVE,
	type PipelineAvailability,
	type PipelineView,
	pipelineAvailability,
	pipelineViews,
} from "$lib/streaming/pipelineAvailability";

/**
 * Bridge the `HardwareType` the pipelines broadcast already carries to the
 * {@link PlatformCaps} `intersectCaps()` consumes. This is a deliberately thin
 * board→ceiling map: hardware-accelerated SBCs reach the 4K rung, the software
 * (`generic`) fallback tops out at 1080p (4K software encode is impractical).
 *
 * It exists because the additive `get-capabilities` engine method is not yet
 * surfaced to the FE over RPC; the moment it is, this map is replaced by the
 * engine's real PlatformCaps and deleted.
 */
const PLATFORM_CAPS_BY_HARDWARE: Record<HardwareType, PlatformCaps> = {
	jetson: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	rk3588: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	n100: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	generic: {
		supports_h265: true,
		hardware_accelerated: false,
		max_resolution: "1080p",
	},
};

/** Resolve the platform capability profile for a board, defaulting to `generic`. */
export function platformCapsForHardware(
	hardware: HardwareType | undefined,
): PlatformCaps {
	return hardware
		? PLATFORM_CAPS_BY_HARDWARE[hardware]
		: PLATFORM_CAPS_BY_HARDWARE.generic;
}

/**
 * Project a `Pipeline` (the FE's capability-derived source descriptor) onto the
 * {@link VideoSourceCap} shape `intersectCaps()` expects. The pipeline metadata
 * already comes from the backend capability service (`getPipelines` is derived
 * from `getCapabilities`), so this is a pure shape adapter, not a second source
 * of truth.
 */
export function videoSourceCapFromPipeline(
	id: string,
	pipeline: Pipeline,
): VideoSourceCap {
	return {
		id,
		supports_audio: pipeline.supportsAudio,
		supports_resolution_override: pipeline.supportsResolutionOverride,
		supports_framerate_override: pipeline.supportsFramerateOverride,
		default_resolution: pipeline.defaultResolution ?? "1080p",
		default_framerate: pipeline.defaultFramerate ?? 30,
	};
}

/**
 * The effective offered capability set for the current platform ∩ selected
 * source. An absent pipeline is permissive (the full platform ladder, all
 * overrides live) — exactly the None-cap policy `intersectCaps()` documents.
 */
export function offeredEncoderCaps(
	hardware: HardwareType | undefined,
	pipelineId: string | undefined,
	pipeline: Pipeline | undefined,
	mode: string = STREAMING_MODE,
): OfferedSet {
	const platform = platformCapsForHardware(hardware);
	const source =
		pipelineId && pipeline
			? videoSourceCapFromPipeline(pipelineId, pipeline)
			: undefined;
	return intersectCaps(platform, source, mode);
}

/**
 * A single rendered encoder option plus its capability verdict. `supported`
 * drives whether the option is selectable; `reason` is the disabled tooltip
 * (undefined when supported).
 */
export interface EncoderOption<T> {
	value: T;
	supported: boolean;
	reason: string | undefined;
}

function reasonFor(overrideAllowed: boolean): string {
	// When the source itself forbids the override, every non-default rung is
	// "fixed by the source"; otherwise an excluded rung is a platform ceiling.
	return overrideAllowed
		? OPTION_UNSUPPORTED_ON_PLATFORM
		: OPTION_FIXED_BY_SOURCE;
}

/**
 * The full resolution candidate universe, each tagged with whether the offered
 * set includes it and, when not, why. Incompatible rungs are returned (not
 * filtered out) so the dialog can show them disabled with a reason.
 */
export function resolutionOptions(
	offered: OfferedSet,
): EncoderOption<Resolution>[] {
	const offeredSet = new Set(offered.resolutions);
	return AVAILABLE_RESOLUTIONS.map((value) => {
		const supported = offeredSet.has(value);
		return {
			value,
			supported,
			reason: supported
				? undefined
				: reasonFor(offered.supportsResolutionOverride),
		};
	});
}

/** As {@link resolutionOptions}, for the framerate candidate universe. */
export function framerateOptions(
	offered: OfferedSet,
): EncoderOption<Framerate>[] {
	const offeredSet = new Set(offered.framerates);
	return AVAILABLE_FRAMERATES.map((value) => {
		const supported = offeredSet.has(value);
		return {
			value,
			supported,
			reason: supported
				? undefined
				: reasonFor(offered.supportsFramerateOverride),
		};
	});
}

// ── Capability-gated axes (platform ∩ source ∩ Tier-2 device modes) ───────────
//
// `offeredAxes` layers the per-device capture modes the engine broadcasts on
// `capabilities.device_modes` on top of the coarse `offeredEncoderCaps`
// intersection, so Resolution/Framerate options reflect what the SELECTED (or
// kind-matched) capture hardware can actually drive — not just the platform
// ceiling. When the engine emits no `device_modes`, the result is byte-identical
// to the coarse offering.

/**
 * The effective offered set plus the device modes that narrowed it. `deviceModes`
 * is `undefined` when nothing narrowed the coarse offering (no engine caps, a
 * non-device pipeline, or zero kind-matched devices) — the per-resolution
 * framerate refinement then falls back to the coarse framerate list.
 */
export interface OfferedAxes {
	offered: OfferedSet;
	deviceModes: readonly DeviceMode[] | undefined;
}

/**
 * Resolve which device modes narrow the axes for the current selection.
 *
 *   1. An explicitly selected capture device (`selectedVideoInput`, a list-devices
 *      input_id) narrows to THAT device's modes.
 *   2. No device selected → the UNION of modes across every device whose `kind`
 *      maps to the selected pipeline via {@link deviceKindToPipelineId}.
 *   3. Non-device pipelines (rtmp/srt/test) or zero kind-matched devices → coarse
 *      (`undefined`): an empty device match must NEVER collapse an axis to nothing.
 *
 * `deviceModes` absent entirely → `undefined` (byte-identical to today's coarse
 * offering).
 */
export function resolveDeviceModes(
	deviceModes: Record<string, DeviceModeGroup> | undefined,
	pipelineId: string | undefined,
	selectedVideoInput: string | undefined,
): readonly DeviceMode[] | undefined {
	if (!deviceModes) return undefined;

	if (selectedVideoInput) {
		const group = deviceModes[selectedVideoInput];
		return group && group.modes.length > 0 ? group.modes : undefined;
	}

	if (!pipelineId) return undefined;

	const union: DeviceMode[] = [];
	for (const group of Object.values(deviceModes)) {
		if (deviceKindToPipelineId(group.kind) === pipelineId) {
			union.push(...group.modes);
		}
	}
	return union.length > 0 ? union : undefined;
}

/**
 * The offered capability set for the current platform ∩ selected source ∩ Tier-2
 * device modes. Base is {@link offeredEncoderCaps}; the resolved device modes (see
 * {@link resolveDeviceModes}) are threaded into `intersectCaps` for the union-level
 * resolution/framerate narrowing. Per-resolution framerate refinement is
 * {@link framerateOptionsForResolution}'s job.
 */
export function offeredAxes(
	hardware: HardwareType | undefined,
	pipelineId: string | undefined,
	pipeline: Pipeline | undefined,
	deviceModes: Record<string, DeviceModeGroup> | undefined,
	selectedVideoInput: string | undefined,
	mode: string = STREAMING_MODE,
): OfferedAxes {
	const platform = platformCapsForHardware(hardware);
	const source =
		pipelineId && pipeline
			? videoSourceCapFromPipeline(pipelineId, pipeline)
			: undefined;
	const resolvedModes = resolveDeviceModes(
		deviceModes,
		pipelineId,
		selectedVideoInput,
	);
	return {
		offered: intersectCaps(platform, source, mode, resolvedModes),
		deviceModes: resolvedModes,
	};
}

/** The framerate rungs the device modes can drive at one specific resolution. */
function deviceModeFrameratesAtResolution(
	modes: readonly DeviceMode[],
	resolution: Resolution,
): Set<number> {
	const framerates = new Set<number>();
	for (const mode of modes) {
		if (
			normalizeResolutionToRung(`${mode.width}x${mode.height}`) !== resolution
		) {
			continue;
		}
		for (const framerate of mode.framerates) {
			const rung = normalizeFramerateToRung(framerate);
			if (rung !== undefined) framerates.add(rung);
		}
	}
	return framerates;
}

/**
 * The framerate candidate universe gated by BOTH the offered set and the selected
 * resolution: a rate the device can't drive at `resolution` renders disabled with
 * {@link OPTION_UNSUPPORTED_AT_RESOLUTION}, never hidden. With no device modes this
 * is identical to {@link framerateOptions} (coarse gating).
 */
export function framerateOptionsForResolution(
	axes: OfferedAxes,
	resolution: Resolution,
): EncoderOption<Framerate>[] {
	const { offered, deviceModes } = axes;
	if (!deviceModes || deviceModes.length === 0) {
		return framerateOptions(offered);
	}
	const offeredSet = new Set(offered.framerates);
	const atResolution = deviceModeFrameratesAtResolution(
		deviceModes,
		resolution,
	);
	return AVAILABLE_FRAMERATES.map((value) => {
		const inOffered = offeredSet.has(value);
		const supported = inOffered && atResolution.has(value);
		return {
			value,
			supported,
			reason: supported
				? undefined
				: inOffered
					? OPTION_UNSUPPORTED_AT_RESOLUTION
					: reasonFor(offered.supportsFramerateOverride),
		};
	});
}

/** The highest resolution rung present in an offered list (ladder order). */
function highestResolutionRung(
	resolutions: readonly string[],
): Resolution | undefined {
	let best: Resolution | undefined;
	for (const rung of AVAILABLE_RESOLUTIONS) {
		if (resolutions.includes(rung)) best = rung;
	}
	return best;
}

/** The resolution/framerate ceiling of an offered-axes set, for the summary line. */
export interface AxisCeiling {
	resolution: Resolution | undefined;
	framerate: Framerate | undefined;
}

/**
 * The device/platform ceiling for the current axes — the "up to X" side of the
 * current-vs-device-max summary. Derived from the already-intersected offered set,
 * so it reflects the active source's real ceiling when device modes are present.
 */
export function axisCeiling(axes: OfferedAxes): AxisCeiling {
	const { framerates } = axes.offered;
	return {
		resolution: highestResolutionRung(axes.offered.resolutions),
		framerate:
			framerates.length > 0
				? (Math.max(...framerates) as Framerate)
				: undefined,
	};
}

// Bitrate slider/input clamp to the board's real `encoder.bitrate_range`, not
// the schema-wide validation range. The schema constants are only the fallback
// for the brief window before the capability contract arrives.
export interface BitrateBounds {
	min: number;
	max: number;
	defaultMin: number;
	defaultMax: number;
}

export function bitrateBoundsFromCaps(
	caps: CapabilitiesMessage | undefined,
): BitrateBounds {
	if (!caps) {
		return {
			min: BITRATE_MIN,
			max: BITRATE_MAX,
			defaultMin: BITRATE_DEFAULT_MIN,
			defaultMax: BITRATE_DEFAULT_MAX,
		};
	}
	const { min, max } = caps.encoder.bitrate_range;
	const defaultMin = Math.min(Math.max(BITRATE_DEFAULT_MIN, min), max);
	const defaultMax = Math.max(Math.min(BITRATE_DEFAULT_MAX, max), min);
	return { min, max, defaultMin, defaultMax };
}

export function clampBitrateToBounds(
	value: number,
	bounds: BitrateBounds,
): number {
	if (!Number.isFinite(value)) return bounds.defaultMin;
	return Math.min(bounds.max, Math.max(bounds.min, value));
}

// Every codec carries a UNIFORM `hardwareAccelerated` flag (the board's encode
// path is hardware or software for ALL codecs alike) so the dialog labels H.264
// and H.265 consistently instead of warning only H.265. `softwareWarning` is the
// narrower, codec-specific caveat: H.265 on a board with no hardware encoder
// (`generic`) runs in x265 software and is offered WITH the high-CPU warning,
// never hidden.
export interface CodecOption {
	mediaType: string;
	value: string;
	hardwareAccelerated: boolean;
	softwareWarning: boolean;
}

function codecValueFor(mediaType: string): string {
	if (mediaType === MEDIA_TYPE_H265) return "h265";
	if (mediaType === MEDIA_TYPE_H264) return "h264";
	return mediaType;
}

export function deriveCodecOptions(
	platform: PlatformCaps | undefined,
): CodecOption[] {
	if (!platform) {
		return [
			{
				mediaType: MEDIA_TYPE_H264,
				value: "h264",
				hardwareAccelerated: false,
				softwareWarning: false,
			},
		];
	}
	const offered = intersectCaps(platform, undefined, STREAMING_MODE);
	return offered.codecs.map((mediaType) => ({
		mediaType,
		value: codecValueFor(mediaType),
		hardwareAccelerated: platform.hardware_accelerated,
		softwareWarning:
			mediaType === MEDIA_TYPE_H265 && !platform.hardware_accelerated,
	}));
}

// ── Probed capability surfacing ──────────────────────────────────────────────
//
// Each capture device the engine probes advertises a list of `CaptureCap`
// formats (resolution / framerate / media-type). The encoder/source area shows
// these inline so the operator sees exactly what the connected hardware reports,
// rather than guessing from the offered set alone.
export interface ProbedCapsSummary {
	inputId: string;
	displayName: string;
	caps: string[];
}

function shortMediaType(mediaType: string): string {
	if (mediaType === MEDIA_TYPE_H265) return "H.265";
	if (mediaType === MEDIA_TYPE_H264) return "H.264";
	return mediaType;
}

/** Render one probed format as a compact spec string (e.g. `1920×1080 @ 30 H.265`). */
export function formatProbedCap(cap: CaptureCap): string {
	const parts: string[] = [];
	if (cap.width !== undefined && cap.height !== undefined) {
		parts.push(`${cap.width}\u00d7${cap.height}`);
	}
	if (cap.framerate) parts.push(`@ ${cap.framerate}`);
	if (cap.media_type) parts.push(shortMediaType(cap.media_type));
	return parts.join(" ");
}

/**
 * Summarise the probed capabilities of every device that advertises at least one
 * renderable format. Devices with no probed formats are omitted so the surface
 * only shows real, advertised capabilities.
 */
export function summarizeProbedCaps(
	devices: readonly CaptureDevice[] | undefined,
): ProbedCapsSummary[] {
	if (!devices) return [];
	const out: ProbedCapsSummary[] = [];
	for (const device of devices) {
		if (!device.caps || device.caps.length === 0) continue;
		const caps = device.caps
			.map(formatProbedCap)
			.filter((label) => label.length > 0);
		if (caps.length === 0) continue;
		out.push({
			inputId: device.input_id,
			displayName: device.display_name,
			caps,
		});
	}
	return out;
}

export interface UvcH265Source {
	inputId: string;
	displayName: string;
	sourceKind: string;
}

// A device advertising a `video/x-h265` capture format becomes an offered UVC
// source; `mediaTypeToSourceKind` keeps the dialog and engine kind ids aligned.
export function deriveUvcH265Sources(
	devices: readonly CaptureDevice[] | undefined,
): UvcH265Source[] {
	if (!devices) return [];
	const out: UvcH265Source[] = [];
	for (const device of devices) {
		const advertisesH265 = device.caps?.some(
			(cap) => cap.media_type === MEDIA_TYPE_H265,
		);
		if (!advertisesH265) continue;
		const sourceKind =
			mediaTypeToSourceKind(MEDIA_TYPE_H265, device.input_id) ?? "uvc_h265";
		out.push({
			inputId: device.input_id,
			displayName: device.display_name,
			sourceKind,
		});
	}
	return out;
}

export const networkConstraints = {
	hotspot: {
		name: { min: HOTSPOT_NAME_MIN, max: HOTSPOT_NAME_MAX },
		password: { min: HOTSPOT_PASSWORD_MIN, max: HOTSPOT_PASSWORD_MAX },
	},
	wifi: {
		password: { min: WIFI_PASSWORD_MIN },
	},
	auth: {
		password: { min: WIFI_PASSWORD_MIN },
	},
	modem: {
		simPin: { min: SIM_PIN_MIN_LENGTH, max: SIM_PIN_MAX_LENGTH },
		simPuk: { length: SIM_PUK_LENGTH },
	},
} as const;
