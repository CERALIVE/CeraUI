import {
	activeMediaTypeForModes,
	intersectCaps,
	MEDIA_TYPE_H264,
	MEDIA_TYPE_H265,
	MEDIA_TYPE_MJPEG,
	MEDIA_TYPE_RAW,
	mediaTypeToSourceKind,
	type OfferedSet,
	type PlatformCaps,
	type SourceModeCeiling,
	scopeModesToMediaType,
	singleModeSourceCeiling,
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
	type InputMode,
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
	type StreamSource,
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

// Transport × audio-codec compatibility (C5) — re-surfaced from the SINGLE source
// of truth in `@ceraui/rpc/schemas` (`TRANSPORT_AUDIO_CODECS` +
// `audioCodecAllowedForTransport`). The frontend gates the codec picker through
// THIS re-export (matching the pipelineAvailability precedent) — never a direct
// schema import in a dialog, and never a re-implemented copy of the map.
export { audioCodecAllowedForTransport } from "@ceraui/rpc/schemas";
// Network-ingest gateway availability — re-surfaced from the single-source-of-
// truth helper (`$lib/streaming/pipelineAvailability`) so the disabled-reason key
// family stays together. The rule itself is NEVER re-implemented here.
export {
	isPipelineAvailable,
	PIPELINE_GATEWAY_DISABLED_IN_SETTINGS,
	PIPELINE_GATEWAY_INACTIVE,
	type PipelineAvailability,
	type PipelineView,
	pipelineAvailability,
	pipelineViews,
} from "$lib/streaming/pipelineAvailability";

import {
	governingInputMode,
	ladderForInputMode,
	mediaTypeForInputMode,
} from "$lib/streaming/capture-modes";

/**
 * Bridge the `HardwareType` the pipelines broadcast already carries to the
 * {@link PlatformCaps} `intersectCaps()` consumes. This is a deliberately thin
 * board→ceiling map: hardware-accelerated SBCs reach the 4K rung, the software
 * (`generic`) fallback tops out at 1080p (4K software encode is impractical).
 *
 * WHY THIS SURVIVED THE UNION RETIREMENT (device-quality-wave3 todo 11c).
 *
 * The legacy device-modes union was deleted because it INVENTED device
 * capability — it merged two devices' (or two media types') ladders and offered
 * a mode no single device had ever reported, which cerastream ADR-0008 §10
 * forbids outright. This map is a categorically different thing and stays.
 *
 * It is a PLATFORM ENCODE CEILING, not device capability. It answers "what can
 * this BOARD's encoder emit", never "what can the attached camera deliver" —
 * the two are independent facts about different hardware, and `intersectCaps`
 * takes the INTERSECTION of them. So this map can only ever SUBTRACT from the
 * offering; it can never add a mode the device did not report, which is the
 * precise property the ADR requires. A device advertising 4K on an RK3588 still
 * has its own ladder consulted; this only stops the UI offering an encode target
 * the SoC cannot produce.
 *
 * It is also not a stand-in for absent device truth. Per-device ladders arrive
 * VERBATIM on `StreamSource.modes` and are read by {@link resolveDeviceModes} —
 * that path is fully wired, so nothing here is compensating for missing data.
 *
 * The open follow-up is unchanged and is a SEPARATE concern: the engine's real
 * `platform` caps from `get-capabilities` are not yet surfaced to the frontend
 * over RPC, so the board→ceiling values are still hardcoded here rather than
 * engine-reported. When that lands, replace this map with the engine's values.
 * Do NOT delete it before then — removing the platform ceiling would let the UI
 * offer encode targets the board cannot produce, which is the same dishonesty
 * the union retirement was fixing, in the other direction.
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
 * Project a device-first {@link StreamSource} onto the {@link VideoSourceCap}
 * shape `intersectCaps()` expects — the source-keyed counterpart of
 * {@link videoSourceCapFromPipeline}. The StreamSource facets already come from
 * the backend `sources` builder (itself derived from the capability service), so
 * this is a pure shape adapter, not a second source of truth.
 */
export function videoSourceCapFromStreamSource(
	source: StreamSource,
): VideoSourceCap {
	return {
		id: source.id,
		supports_audio: source.supportsAudio,
		supports_resolution_override: source.supportsResolutionOverride,
		supports_framerate_override: source.supportsFramerateOverride,
		default_resolution: source.defaultResolution ?? "1080p",
		default_framerate: source.defaultFramerate ?? 30,
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
 * The effective offered set plus the device modes that refine it per resolution.
 *
 * `deviceModes` is `undefined` whenever there is no per-resolution refinement to
 * apply — either nothing narrowed the coarse offering (no engine caps, a
 * non-device pipeline, zero kind-matched devices), or the source reports a SINGLE
 * capture mode whose ceiling already applies uniformly to every rung at or below
 * it (see {@link singleModeSourceCeiling}). In both cases the per-resolution
 * framerate refinement falls back to the coarse framerate list.
 *
 * `activeMediaType` names the ONE capture format the active source negotiates
 * when its modes span several (see {@link resolveActiveMediaType}); `deviceModes`
 * is already scoped to it. It is absent whenever nothing disambiguated the
 * ladders, and every per-resolution derivation then reads every mode.
 */
export interface OfferedAxes {
	offered: OfferedSet;
	deviceModes: readonly DeviceMode[] | undefined;
	activeMediaType?: string;
}

/**
 * The device modes that narrow the axes for the active {@link StreamSource}.
 *
 * This is the ONLY lookup. The pipelineId ∪ selectedVideoInput union path it
 * replaced is GONE, not deprecated: unioning every kind-matched device's ladder
 * is exactly what cerastream ADR-0008 §10 forbids ("the UI and the save path may
 * never invent or union"), and it is the #244 defect — the union produced a
 * resolution/framerate pair no single device could deliver and the leg failed
 * `not-negotiated`. The backend `sources` builder already folds each device's own
 * modes onto its StreamSource, so the adapter just reads `source.modes`.
 *
 * A `[]` modes list (coarse/virtual/network, or a capture device whose modes the
 * engine has not enumerated) falls back to the coarse offering (`undefined`) — an
 * empty match must NEVER collapse an axis to nothing.
 *
 * A device that advertises SEVERAL formats (todo 21 `inputModes`) narrows one
 * step further: the ladder of the GOVERNING format alone. `source.modes` is the
 * device's flat list across every format it exposes, so offering from it would
 * union two disjoint ladders — the same ADR-0008 §10 violation one level down.
 * `inputMode` lets a caller preview an unsaved pick; absent, the engine's own
 * `selectedInputMode` governs, and a device that reported no split is untouched.
 */
export function resolveDeviceModes(
	source: StreamSource | undefined,
	inputMode?: InputMode | undefined,
): readonly DeviceMode[] | undefined {
	const family = ladderForInputMode(source, inputMode);
	if (family !== undefined) return family;
	return source && source.modes.length > 0 ? source.modes : undefined;
}

// ── Source signal vs encode target ───────────────────────────────────────────
//
// A UVC camera's `modes` ENUMERATE a menu of modes it can be commanded into. An
// HDMI receiver's do not: cerastream's DV-timings projection collapses it to
// exactly ONE mode — whatever signal is currently on the cable. Intersecting the
// ENCODE TARGET with that single mode disabled every other rung (a 1080p59.94
// signal on the onboard HDMI-RX could not be encoded at 720p30) even though the
// capture leg scales and rate-converts freely — `videoscale`/`videorate` are
// wired in both cerastream's generic capture-leg builder and its RK3588 template.
// A reported signal BOUNDS the encode target from above; it does not enumerate it.
//
// An enumerated multi-mode source keeps the exact per-mode narrowing — and that is
// SOURCE-CONFIRMED correct, not merely conservative. A UVC camera's modes really are
// COMMANDED: the requested resolution/framerate travel `start` → `InputKind::UvcH264`/
// `UvcH265` → a `libuvch264src ! capsfilter` carrying those exact dimensions, and the
// plugin intersects that capsfilter against the device's OWN enumerated descriptors
// before `uvc_get_stream_ctrl_format_size()` turns the winner into a UVC `SET_CUR` on
// the wire. The capsfilter IS the device negotiation. (With no override the plugin
// auto-selects the highest compatible enumerated mode — still a negotiation, not a
// passive read of whatever the device happened to default to.)
//
// Which is precisely WHY UVC must NOT inherit the ceiling model. The HDMI ceiling is
// safe because `videoscale`/`videorate` normalize an uncontrolled capture downstream;
// in front of a UVC negotiation there is no such safety net, so an encode target the
// device does not enumerate has no mode to negotiate at all. Narrowing to the real
// enumerated modes is the truthful offering here.
//
// The open follow-up is NOT whether that negotiation happens — it does. It is that
// changing a UVC mode requires tearing the capture down and rebuilding it (libuvc
// refuses a mode change on a running stream), so a mid-session change needs restart
// UX plus real-camera validation. See `apps/frontend/AGENTS.md` → "Known follow-up".

// `singleModeSourceCeiling` + `SourceModeCeiling` now live in `@ceraui/rpc`
// (`capabilities/device-mode-truth`) because the backend save path applies the
// SAME ceiling rule — an offering the save path would reject is a lie. Re-exported
// here so this module stays the frontend's single constraint-import surface.
export { type SourceModeCeiling, singleModeSourceCeiling };

/**
 * Narrow an offered set to everything AT OR BELOW the source's reported signal —
 * downscale/rate-reduction is always available, an encode target above the signal
 * never is.
 */
function capOfferedToSourceCeiling(
	offered: OfferedSet,
	ceiling: SourceModeCeiling,
): OfferedSet {
	const ceilingIndex = AVAILABLE_RESOLUTIONS.indexOf(ceiling.resolution);
	return {
		...offered,
		resolutions: offered.resolutions.filter((resolution) => {
			const rung = normalizeResolutionToRung(resolution);
			return (
				rung !== undefined &&
				AVAILABLE_RESOLUTIONS.indexOf(rung) <= ceilingIndex
			);
		}),
		framerates: offered.framerates.filter(
			(framerate) => framerate <= ceiling.framerate,
		),
	};
}

/**
 * The shared axes tail both {@link offeredAxes} overloads resolve through: the
 * source's modes either impose a single-signal ceiling (capped axes, no
 * per-resolution refinement) or enumerate a menu that narrows `intersectCaps`
 * exactly, as before — now within the ONE media type `activeKind` negotiates.
 *
 * The ceiling test deliberately reads the FULL mode list, before any media-type
 * scoping. A device that enumerates a real menu must not collapse into a ceiling
 * merely because scoping left one mode standing: for a UVC negotiation there is
 * no `videoscale`/`videorate` safety net, so an encode target the device does not
 * enumerate has no mode to negotiate at all.
 */
function axesFromResolvedModes(
	platform: PlatformCaps,
	source: VideoSourceCap | undefined,
	mode: string,
	resolvedModes: readonly DeviceMode[] | undefined,
	activeKind: string | undefined,
	// The media type the ENGINE declared for an already-scoped ladder. Required
	// because that ladder carries a single media type, and the shared rule below
	// deliberately narrows nothing below two — so re-inferring it from the rungs
	// that survived would answer `undefined` for a format we positively know.
	declaredMediaType?: string | undefined,
): OfferedAxes {
	const ceiling = singleModeSourceCeiling(resolvedModes);
	if (ceiling) {
		return {
			offered: capOfferedToSourceCeiling(
				intersectCaps(platform, source, mode),
				ceiling,
			),
			deviceModes: undefined,
		};
	}
	const activeMediaType =
		declaredMediaType ?? activeMediaTypeForModes(resolvedModes, activeKind);
	const scopedModes = scopeModesToMediaType(resolvedModes, activeMediaType);
	return {
		offered: intersectCaps(platform, source, mode, scopedModes),
		deviceModes: scopedModes,
		...(activeMediaType !== undefined ? { activeMediaType } : {}),
	};
}

/**
 * The offered capability set for platform ∩ the active {@link StreamSource} ∩ its
 * own Tier-2 device modes. The source's `modes` (see {@link resolveDeviceModes})
 * bound the resolution/framerate axes — as a ceiling when the source reports one
 * signal, as an exact per-mode narrowing when it enumerates a menu (see
 * {@link axesFromResolvedModes}); per-resolution framerate refinement is
 * {@link framerateOptionsForResolution}'s job. With `source.modes` empty the
 * result is byte-identical to the coarse {@link offeredEncoderCaps} offering.
 *
 * `inputMode` scopes both the ladder and the governing media type to ONE of the
 * device's advertised formats (todo 23). Absent, the engine's own
 * `selectedInputMode` governs; a device that reported no split is untouched.
 */
export function offeredAxes(
	hardware: HardwareType | undefined,
	source: StreamSource | undefined,
	mode: string = STREAMING_MODE,
	inputMode?: InputMode | undefined,
): OfferedAxes {
	const platform = platformCapsForHardware(hardware);
	const cap = source ? videoSourceCapFromStreamSource(source) : undefined;
	return axesFromResolvedModes(
		platform,
		cap,
		mode,
		resolveDeviceModes(source, inputMode),
		activeCaptureKind(source, inputMode),
		mediaTypeForInputMode(source, inputMode),
	);
}

// ── Media-type-scoped device modes ───────────────────────────────────────────
//
// A capture device enumerates its formats PER media type, and those ladders are
// DISJOINT descriptor sets — not one universal capability matrix. The same
// camera legitimately offers 3840x2160@60 as `image/jpeg` and only
// 1920x1080@30 as `video/x-raw`; unioning the two told the operator the device
// drives 4K60 but not 1080p60, a pairing no single capture format can honour.
// The backend already keeps them apart (`groupDeviceCaps()` keys on
// width × height × media_type) — this file was the only layer collapsing them.
//
// Which ladder applies is NOT a guess. The active source's `kind` is what
// cerastream resolves into its `InputKind`, and that InputKind is what emits the
// `capsfilter` media type the device negotiation is performed against (see the
// SOURCE SIGNAL note above). So the kind names the governing media type, and the
// other media types' modes are simply not on the table for this source.
//
// Fail-open, like every other none-cap rule here: a mode list carrying fewer
// than two distinct media types, and a kind that names none of the advertised
// ones, narrow NOTHING. An unknown must never subtract from the offering.

// The rule itself now lives in `@ceraui/rpc` (`capabilities/device-mode-truth`),
// shared verbatim with the backend save path. Re-exported so this module remains
// the frontend's single constraint-import surface.
export { activeMediaTypeForModes, scopeModesToMediaType };

/**
 * The capture `kind` an active {@link StreamSource} commands, if any.
 *
 * A multi-format device's SELECTED mode outranks the engine's collapsed scalar
 * `kind`: the shared rule scopes a ladder by "the media type the KIND names", so
 * handing it the selected mode is the whole of mode-awareness — the same
 * evaluator, pointed at the format the leg will actually negotiate. This mirrors
 * the backend's `device-mode-guard.ts` `governingKind()` exactly, because an
 * offering the save path would reject is a lie told to the operator.
 */
function activeCaptureKind(
	source: StreamSource | undefined,
	inputMode?: InputMode | undefined,
): string | undefined {
	if (source?.origin !== "capture") return undefined;
	return governingInputMode(source, inputMode) ?? source.kind;
}

/**
 * The media type governing the axes for the active {@link StreamSource} — the
 * companion of {@link resolveDeviceModes}, and keyed the same way.
 */
export function resolveActiveMediaType(
	source: StreamSource | undefined,
	inputMode?: InputMode | undefined,
): string | undefined {
	return (
		mediaTypeForInputMode(source, inputMode) ??
		activeMediaTypeForModes(
			resolveDeviceModes(source, inputMode),
			activeCaptureKind(source, inputMode),
		)
	);
}

/**
 * The framerate rungs the device modes can drive at one specific resolution,
 * within ONE media type.
 *
 * `mediaType` is the format the active source actually negotiates: a mode
 * belonging to a DIFFERENT advertised media type describes a ladder this source
 * cannot select, so it must not contribute a rate here. An untagged mode carries
 * no format constraint and always counts; an `undefined` `mediaType` means
 * nothing disambiguated the ladders, so every mode counts (unchanged behaviour).
 */
function deviceModeFrameratesAtResolution(
	modes: readonly DeviceMode[],
	resolution: Resolution,
	mediaType?: string | undefined,
): Set<number> {
	const framerates = new Set<number>();
	for (const mode of modes) {
		if (
			mediaType !== undefined &&
			mode.media_type !== undefined &&
			mode.media_type !== mediaType
		) {
			continue;
		}
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
 * A per-option "available elsewhere" hint: the framerate is disabled at the
 * current resolution but the device CAN drive it at `resolution`. Drives the
 * EncoderDialog option `title` (e.g. "… \u2014 60 fps available at 720p").
 */
export interface FramerateAvailabilityHint {
	fps: Framerate;
	resolution: Resolution;
}

/**
 * A framerate option that additionally carries the optional
 * {@link FramerateAvailabilityHint}. Only a rate disabled with
 * {@link OPTION_UNSUPPORTED_AT_RESOLUTION} that the device offers at ANOTHER rung
 * gets a hint; every other option leaves it undefined.
 */
export interface FramerateOption extends EncoderOption<Framerate> {
	hint?: FramerateAvailabilityHint;
}

/**
 * For ONE candidate framerate, the highest offered resolution rung OTHER than
 * `excludeResolution` whose device modes can drive that framerate — the source of
 * the "available elsewhere" hint. `undefined` when the device offers the rate at
 * no other rung (that option then carries no hint), or when there are no device
 * modes at all (the coarse path has nothing to hint at).
 *
 * Keyed on the candidate framerate (NOT just the resolution) so two options
 * disabled at the same resolution get DIFFERENT hints — a 60 fps offered at 720p
 * and a 50 fps offered nowhere must not share one resolution-keyed hint.
 *
 * Scoped to `axes.activeMediaType`, so the hint never points at a rung only
 * another capture format reaches — that would send the operator to a resolution
 * where the rate is disabled all over again.
 */
export function framerateAvailableAt(
	axes: OfferedAxes,
	framerate: Framerate,
	excludeResolution: Resolution,
): Resolution | undefined {
	const { offered, deviceModes, activeMediaType } = axes;
	if (!deviceModes || deviceModes.length === 0) return undefined;
	if (!offered.framerates.includes(framerate)) return undefined;
	let best: Resolution | undefined;
	for (const rung of AVAILABLE_RESOLUTIONS) {
		if (rung === excludeResolution) continue;
		if (!offered.resolutions.includes(rung)) continue;
		if (
			deviceModeFrameratesAtResolution(deviceModes, rung, activeMediaType).has(
				framerate,
			)
		) {
			best = rung;
		}
	}
	return best;
}

/**
 * The framerate candidate universe gated by BOTH the offered set and the selected
 * resolution: a rate the device can't drive at `resolution` renders disabled with
 * {@link OPTION_UNSUPPORTED_AT_RESOLUTION}, never hidden. With no device modes this
 * is identical to {@link framerateOptions} (coarse gating).
 *
 * A rate is judged against the ONE capture format the active source negotiates
 * (`axes.activeMediaType`), never the union across formats. A device advertising
 * 1080p60 as MJPEG and 1080p30 as raw offers two DISJOINT ladders, and unioning
 * them offered a 60 the raw ladder cannot deliver.
 *
 * Each option additionally carries a {@link FramerateAvailabilityHint} when it is
 * disabled at THIS resolution but offered at another rung (via
 * {@link framerateAvailableAt}), so EncoderDialog can render "… available at Xp".
 */
export function framerateOptionsForResolution(
	axes: OfferedAxes,
	resolution: Resolution,
): FramerateOption[] {
	const { offered, deviceModes, activeMediaType } = axes;
	if (!deviceModes || deviceModes.length === 0) {
		return framerateOptions(offered);
	}
	const offeredSet = new Set(offered.framerates);
	const atResolution = deviceModeFrameratesAtResolution(
		deviceModes,
		resolution,
		activeMediaType,
	);
	return AVAILABLE_FRAMERATES.map((value) => {
		const inOffered = offeredSet.has(value);
		const supported = inOffered && atResolution.has(value);
		// Supported, or not offered at all (a coarse source/platform ceiling) — neither
		// is a per-resolution limit, so neither carries an "available elsewhere" hint.
		if (supported || !inOffered) {
			return {
				value,
				supported,
				reason: supported
					? undefined
					: reasonFor(offered.supportsFramerateOverride),
			};
		}
		// Offered by the source/platform but not at THIS resolution: attach the option's
		// OWN hint when the rate lives at another rung; a rate offered nowhere else keeps
		// the plain per-resolution reason with no hint.
		const availableAt = framerateAvailableAt(axes, value, resolution);
		return {
			value,
			supported,
			reason: OPTION_UNSUPPORTED_AT_RESOLUTION,
			hint: availableAt ? { fps: value, resolution: availableAt } : undefined,
		};
	});
}

/** The encode axes a device with no stored choice starts from. */
export const DEFAULT_ENCODE_RESOLUTION: Resolution = "1080p";
export const DEFAULT_ENCODE_FRAMERATE: Framerate = 30;

/**
 * The resolution+framerate a freshly-seeded encoder draft should open on for the
 * ACTIVE source.
 *
 * An axis the operator has actually stored a value for is passed through
 * UNTOUCHED, even when the current source cannot deliver it. That is deliberate:
 * a stale explicit choice must surface as a flagged control and a blocked save so
 * the operator re-decides it, never as a silent rewrite of their encode settings.
 *
 * An axis with NO stored value is different — there is no operator intent to
 * protect, only a hardcoded fallback. A source whose ceiling sits BELOW that
 * fallback (a receiver locked to 480p25, a device that tops out at 720p) would
 * otherwise open the dialog already-invalid: red control, save blocked, and
 * nothing the operator had done wrong. Such an axis is reconciled onto what the
 * source can actually drive.
 *
 * Reconciling is safe because a reconciled value is always one the source offers,
 * and unsupported options render `disabled` — so this can never overwrite a choice
 * the operator was able to make.
 *
 * Each axis steps DOWN its ladder first: a fallback the hardware cannot reach
 * should degrade rather than silently exceed the default (30 must not become 60
 * while 25 is on offer). Only when nothing at or below is offered does it take the
 * lowest thing that is — which is how a 59.94-only receiver resolves 30. With
 * nothing offered at all the fallback stands.
 */
export function seededAxisSelection(
	axes: OfferedAxes,
	stored: {
		resolution: Resolution | undefined;
		framerate: Framerate | undefined;
	},
): { resolution: Resolution; framerate: Framerate } {
	const resolution =
		stored.resolution ??
		snapToLadder(DEFAULT_ENCODE_RESOLUTION, AVAILABLE_RESOLUTIONS, (rung) =>
			axes.offered.resolutions.includes(rung),
		) ??
		DEFAULT_ENCODE_RESOLUTION;
	if (stored.framerate !== undefined) {
		return { resolution, framerate: stored.framerate };
	}
	const drivable = new Set(
		framerateOptionsForResolution(axes, resolution)
			.filter((option) => option.supported)
			.map((option) => option.value),
	);
	return {
		resolution,
		framerate:
			snapToLadder(DEFAULT_ENCODE_FRAMERATE, AVAILABLE_FRAMERATES, (rung) =>
				drivable.has(rung),
			) ?? DEFAULT_ENCODE_FRAMERATE,
	};
}

/**
 * `seed` when it is offered; else the nearest offered rung, searching DOWN the
 * ascending `ladder` before UP. `undefined` when nothing is offered, or when
 * `seed` is not on the ladder at all.
 */
function snapToLadder<T>(
	seed: T,
	ladder: readonly T[],
	isOffered: (rung: T) => boolean,
): T | undefined {
	if (isOffered(seed)) return seed;
	const at = ladder.indexOf(seed);
	if (at < 0) return undefined;
	for (let i = at - 1; i >= 0; i -= 1) {
		const rung = ladder[i];
		if (rung !== undefined && isOffered(rung)) return rung;
	}
	for (let i = at + 1; i < ladder.length; i += 1) {
		const rung = ladder[i];
		if (rung !== undefined && isOffered(rung)) return rung;
	}
	return undefined;
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
	const { offered, deviceModes, activeMediaType } = axes;
	const resolution = highestResolutionRung(offered.resolutions);
	// With device modes, the ceiling must be an ACHIEVABLE pair: the highest offered
	// resolution rung and THAT rung's own max framerate (the device modes at that
	// resolution ∩ the offered framerates), so the summary never claims a
	// resolution+fps combo the hardware can't drive simultaneously (e.g. 4K/60 when
	// 4K only runs at 30) — and, within a multi-format device, never a rate that
	// belongs to a media type the active source does not negotiate.
	if (deviceModes && deviceModes.length > 0 && resolution !== undefined) {
		const atResolution = deviceModeFrameratesAtResolution(
			deviceModes,
			resolution,
			activeMediaType,
		);
		const achievable = offered.framerates.filter((fps) =>
			atResolution.has(fps),
		);
		return {
			resolution,
			framerate:
				achievable.length > 0
					? (Math.max(...achievable) as Framerate)
					: undefined,
		};
	}
	// No per-resolution refinement: the independent-axes ceiling. Still exact for a
	// single-signal source, whose axes were both capped at that one reported mode.
	const { framerates } = offered;
	return {
		resolution,
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

// Matched by PREFIX, not an exact token list, so every audio-capable device
// (HDMI embedded, USB Audio Class, ALSA card) is covered without a codec table.
const AUDIO_MEDIA_PREFIX = "audio/";

const AUDIO_CAP_LABEL = "Audio";
const AUDIO_CAP_LABEL_KEY = "live.encoder.probedCapAudio";

export type CapLabelTranslator = (key: string) => string;

function audioCapLabel(t?: CapLabelTranslator): string {
	if (t) {
		const translated = t(AUDIO_CAP_LABEL_KEY);
		if (translated && !translated.includes(AUDIO_CAP_LABEL_KEY)) {
			return translated;
		}
	}
	return AUDIO_CAP_LABEL;
}

function isAudioMediaType(mediaType: string): boolean {
	return mediaType.startsWith(AUDIO_MEDIA_PREFIX);
}

/** `video/x-vp9` → `VP9` — an unmapped token still reads as a codec name. */
function genericMediaLabel(mediaType: string): string {
	const slash = mediaType.indexOf("/");
	const subtype = slash === -1 ? mediaType : mediaType.slice(slash + 1);
	const bare = subtype.startsWith("x-") ? subtype.slice(2) : subtype;
	return bare === "" ? mediaType : bare.toUpperCase();
}

function shortMediaType(mediaType: string): string {
	if (mediaType === MEDIA_TYPE_H265) return "H.265";
	if (mediaType === MEDIA_TYPE_H264) return "H.264";
	if (mediaType === MEDIA_TYPE_MJPEG) return "MJPEG";
	if (mediaType === MEDIA_TYPE_RAW) return "Raw";
	return genericMediaLabel(mediaType);
}

/** `30/1` → `30`, `60000/1001` → `59.94`. A non-fraction value passes through. */
function shortFramerate(framerate: string): string {
	const fraction = framerate.match(/^(\d+)\s*\/\s*(\d+)$/);
	if (!fraction) return framerate;
	const denominator = Number(fraction[2]);
	if (denominator === 0) return framerate;
	const fps = Number(fraction[1]) / denominator;
	if (!Number.isFinite(fps)) return framerate;
	return String(Math.round(fps * 100) / 100);
}

/**
 * Render one probed format as a compact spec string (e.g. `1920×1080 @ 59.94 H.264`).
 *
 * An AUDIO format collapses to one plain-language label: the engine's `CaptureCap`
 * carries ONLY `media_type` for audio (its GStreamer probe never reads
 * `rate`/`channels`/`format`), so `audio/x-raw` is byte-identical for every audio
 * device — it distinguishes nothing and reads as a diagnostic string.
 */
export function formatProbedCap(
	cap: CaptureCap,
	t?: CapLabelTranslator,
): string {
	if (cap.media_type && isAudioMediaType(cap.media_type)) {
		return audioCapLabel(t);
	}
	const parts: string[] = [];
	if (cap.width !== undefined && cap.height !== undefined) {
		parts.push(`${cap.width}\u00d7${cap.height}`);
	}
	if (cap.framerate) parts.push(`@ ${shortFramerate(cap.framerate)}`);
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
	t?: CapLabelTranslator,
): ProbedCapsSummary[] {
	if (!devices) return [];
	const out: ProbedCapsSummary[] = [];
	for (const device of devices) {
		if (!device.caps || device.caps.length === 0) continue;
		// Identical labels carry identical information; a device advertising two
		// audio formats would otherwise render the same chip twice.
		const caps = [
			...new Set(
				device.caps
					.map((cap) => formatProbedCap(cap, t))
					.filter((label) => label.length > 0),
			),
		];
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
