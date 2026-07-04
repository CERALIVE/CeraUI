/**
 * intersectCaps — the effective capability set for a platform ∩ source ∩ mode combo.
 *
 * This is the pure heart of CeraUI's capability-driven UX. Given the device's
 * platform capabilities, the selected video source's capabilities, and the active
 * mode, it derives the single `OfferedSet` the UI should present: which
 * resolutions, framerates, and codecs to offer, the bitrate window, and which
 * override toggles are live.
 *
 * Pure function — no I/O, no side effects, browser-safe. The capability INPUT
 * types mirror the `@ceralive/cerastream` wire contract (`PlatformCaps`,
 * `VideoSourceCap` from its `get-capabilities` result). They are mirrored here
 * rather than imported because `@ceraui/rpc` deliberately does NOT depend on the
 * cerastream tarball — the same mirroring convention `captureCapSchema` already
 * uses in `streaming.schema.ts`.
 */
import {
	AVAILABLE_FRAMERATES,
	AVAILABLE_RESOLUTIONS,
	BITRATE_MAX,
	BITRATE_MIN,
	type DeviceMode,
	normalizeFramerateToRung,
	normalizeResolutionToRung,
	type Resolution,
} from '../schemas/streaming.schema';

/**
 * Platform (Tier-1 / SBC) capabilities. Mirrors `@ceralive/cerastream`
 * `platformCapsSchema`.
 */
export interface PlatformCaps {
	supports_h265: boolean;
	hardware_accelerated: boolean;
	max_resolution: string;
}

/**
 * Capture-source (Tier-2) capabilities. Mirrors `@ceralive/cerastream`
 * `videoSourceCapSchema` — the high-level source descriptor returned by
 * `get-capabilities`, not the per-device `list-devices` format cap.
 */
export interface VideoSourceCap {
	id: string;
	supports_audio: boolean;
	supports_resolution_override: boolean;
	supports_framerate_override: boolean;
	default_resolution: string;
	default_framerate: number;
}

/**
 * A single per-device capture format from cerastream `list-devices`. Mirrors the
 * cerastream format cap INCLUDING `media_type` (the `captureCapSchema` mirror in
 * `streaming.schema.ts` predates that field). Every field is optional because a
 * driver may advertise a partial format.
 */
export interface CaptureFormatCap {
	width?: number | undefined;
	height?: number | undefined;
	framerate?: string | undefined;
	media_type?: string | undefined;
}

/** The effective, UI-facing capability set for one platform/source/mode combo. */
export interface OfferedSet {
	resolutions: string[];
	framerates: number[];
	codecs: string[];
	bitrateRange: { min: number; max: number; unit: string };
	supportsAudio: boolean;
	supportsResolutionOverride: boolean;
	supportsFramerateOverride: boolean;
}

// GStreamer media-type tokens carried on the cerastream capture format caps.
export const MEDIA_TYPE_H265 = 'video/x-h265';
export const MEDIA_TYPE_H264 = 'video/x-h264';
export const MEDIA_TYPE_RAW = 'video/x-raw';

// Bitrate is expressed in kbps across the CeraUI stack (matches BITRATE_MIN/MAX).
const BITRATE_UNIT = 'kbps';

// Resolution rungs, ascending. `AVAILABLE_RESOLUTIONS` is already sorted this way;
// aliased locally so the ladder math reads clearly. `4k` is an accepted alias of
// the top rung (`2160p`) some platforms report.
const RESOLUTION_LADDER: readonly Resolution[] = AVAILABLE_RESOLUTIONS;
// The universal baseline rung — every platform can encode 480p. Used as the
// fail-closed floor when `max_resolution` is unparseable (see platformResolutionLadder).
const RESOLUTION_FLOOR: Resolution = '480p';
const RESOLUTION_HEIGHT: Readonly<Record<number, Resolution>> = {
	480: '480p',
	720: '720p',
	1080: '1080p',
	1440: '1440p',
	2160: '2160p',
};

/**
 * Map a capture format's `media_type` to a CeraUI source-kind id.
 *
 *   - `video/x-h265` → `uvc_h265`
 *   - `video/x-h264` → `uvc_h264`
 *   - `video/x-raw`  → `camlink` when the source id names a Cam Link, else `hdmi`
 *
 * None-cap (permissive) policy: an absent or unrecognised `media_type` returns
 * `undefined` — the source is left unclassified, and therefore still offered,
 * never dropped.
 */
export function mediaTypeToSourceKind(
	mediaType: string | undefined,
	sourceId?: string,
): string | undefined {
	switch (mediaType) {
		case MEDIA_TYPE_H265:
			return 'uvc_h265';
		case MEDIA_TYPE_H264:
			return 'uvc_h264';
		case MEDIA_TYPE_RAW:
			return sourceId?.includes('camlink') ? 'camlink' : 'hdmi';
		default:
			return undefined;
	}
}

/**
 * The SINGLE source of truth bridging a list-devices device `kind` to the
 * capability `sources[]` pipeline id — two DISTINCT namespaces (device input_ids
 * vs pipeline/source-kind ids). Both the frontend axis intersection (`offeredAxes`)
 * and the backend pipeline registry consume THIS table and never re-derive it.
 *
 * A kind with no direct video pipeline (`audio`) or an ambiguous multi-pipeline
 * kind (`network` → rtmp|srt) maps to `undefined`; the consumer then falls back to
 * the coarse source/platform offering. The `uvc_h264→libuvch264` / `mjpeg→usb_mjpeg`
 * mappings are the cerastream contract (todo 8); `uvc_h265` has no dedicated engine
 * source id, so it rides `libuvch264`.
 *
 * Kept `as const satisfies` (not a bare `Record<string, …>`) so the backend
 * re-export (`Record<CaptureDeviceKind, string | undefined>`, pipelines.ts) is a
 * compile-time exhaustiveness gate: a new engine device kind fails to type-check
 * until it has an entry here.
 */
export const DEVICE_KIND_TO_PIPELINE_ID = {
	hdmi: 'hdmi',
	uvc_h264: 'libuvch264',
	uvc_h265: 'libuvch264',
	mjpeg: 'usb_mjpeg',
	camlink: 'camlink',
	test: 'test',
	network: undefined,
	audio: undefined,
} as const satisfies Record<string, string | undefined>;

/**
 * Resolve a list-devices device `kind` (carried on `device_modes[input_id].kind`)
 * to its pipeline/source-kind id via {@link DEVICE_KIND_TO_PIPELINE_ID}. Returns
 * `undefined` for an absent kind, an unrecognised kind, or a kind with no direct
 * video pipeline — the caller then treats the device as unbridged (coarse offering).
 */
export function deviceKindToPipelineId(kind: string | undefined): string | undefined {
	if (kind === undefined) {
		return undefined;
	}
	return (DEVICE_KIND_TO_PIPELINE_ID as Record<string, string | undefined>)[kind];
}

/**
 * Resolve a concrete capture format to the `Resolution` rung it advertises.
 *
 * None-cap (permissive) policy: when `width` or `height` is absent the format
 * carries no dimensional constraint, so this returns `undefined` meaning "imposes
 * no restriction". Callers treat that as SUPPORTED/offered — an unknown format
 * must never subtract from the offered set. A non-standard height also returns
 * `undefined` (permissive) rather than guessing a rung.
 */
export function captureCapResolution(cap: CaptureFormatCap): Resolution | undefined {
	if (cap.width === undefined || cap.height === undefined) {
		return undefined;
	}
	return RESOLUTION_HEIGHT[cap.height];
}

/**
 * Platform resolution ladder: every rung up to and including `max_resolution`.
 *
 * Routed through `normalizeResolutionToRung` (Task 4) so BOTH rung forms ("2160p",
 * "4k") and pixel forms ("3840x2160") cap correctly — a pixel-form max can no longer
 * WIDEN the offer. FAIL-CLOSED (behavior change): an unparseable max collapses to the
 * 480p floor, NOT the full ladder as before, so a noisy engine value never over-offers.
 */
function platformResolutionLadder(maxResolution: string): string[] {
	const normalized = normalizeResolutionToRung(maxResolution);
	if (normalized === undefined) {
		return [RESOLUTION_FLOOR];
	}
	const maxIndex = RESOLUTION_LADDER.indexOf(normalized);
	return RESOLUTION_LADDER.slice(0, maxIndex + 1);
}

/** The set of resolution rungs any of the supplied device modes can drive. */
function deviceModeResolutionRungs(modes: readonly DeviceMode[]): Set<Resolution> {
	const rungs = new Set<Resolution>();
	for (const mode of modes) {
		const rung = normalizeResolutionToRung(`${mode.width}x${mode.height}`);
		if (rung !== undefined) {
			rungs.add(rung);
		}
	}
	return rungs;
}

/** The set of framerate rungs any of the supplied device modes can drive. */
function deviceModeFramerates(modes: readonly DeviceMode[]): Set<number> {
	const framerates = new Set<number>();
	for (const mode of modes) {
		for (const framerate of mode.framerates) {
			const rung = normalizeFramerateToRung(framerate);
			if (rung !== undefined) {
				framerates.add(rung);
			}
		}
	}
	return framerates;
}

/**
 * Compute the effective `OfferedSet` for a platform ∩ source ∩ mode combination,
 * optionally narrowed by a selected device's advertised capture modes.
 *
 * Layered intersection (per ADR — platform ∩ capture-source ∩ current-mode):
 *   - resolutions: the platform ladder (≤ `max_resolution`); when the source
 *     forbids resolution override, narrowed to its single `default_resolution`.
 *   - framerates: every available framerate; when the source forbids framerate
 *     override, narrowed to its single `default_framerate`.
 *   - codecs: H.264 is the universal baseline; H.265 is offered only when the
 *     platform advertises hardware support (`supports_h265`).
 *   - bitrateRange: the canonical hardware window (`BITRATE_MIN..BITRATE_MAX`).
 *
 * Device-mode dimension (Task 4): when `deviceModes` is a NON-EMPTY mode list, the
 * offered resolutions/framerates are further intersected against the rungs those
 * modes can drive (per-resolution framerate refinement is a caller/ValidationAdapter
 * concern). When `deviceModes` is `undefined` OR empty, the result is byte-identical
 * to the pre-Task-4 offering — an empty list is treated permissively (no narrowing),
 * never as "offer nothing".
 *
 * None-cap (permissive) policy: a `source` of `undefined` means nothing is known
 * about the capture side, so nothing is narrowed — the full platform ladder is
 * offered and every override toggle reads live.
 */
export function intersectCaps(
	platform: PlatformCaps,
	source: VideoSourceCap | undefined,
	mode: string,
	deviceModes?: readonly DeviceMode[],
): OfferedSet {
	// `mode` is the third intersection layer (platform ∩ source ∩ mode). The v1
	// capability contract surfaces a single streaming mode, so no mode currently
	// narrows the offered set; the parameter is threaded so the signature stays
	// stable as mode-specific gates land.
	void mode;

	const platformResolutions = platformResolutionLadder(platform.max_resolution);

	const supportsAudio = source?.supports_audio ?? true;
	const supportsResolutionOverride = source?.supports_resolution_override ?? true;
	const supportsFramerateOverride = source?.supports_framerate_override ?? true;

	let resolutions =
		source && !supportsResolutionOverride ? [source.default_resolution] : platformResolutions;

	let framerates: number[] =
		source && !supportsFramerateOverride ? [source.default_framerate] : [...AVAILABLE_FRAMERATES];

	if (deviceModes && deviceModes.length > 0) {
		const modeRungs = deviceModeResolutionRungs(deviceModes);
		const modeFramerates = deviceModeFramerates(deviceModes);
		resolutions = resolutions.filter((resolution) => {
			const rung = normalizeResolutionToRung(resolution);
			return rung !== undefined && modeRungs.has(rung);
		});
		framerates = framerates.filter((framerate) => modeFramerates.has(framerate));
	}

	const codecs = platform.supports_h265 ? [MEDIA_TYPE_H264, MEDIA_TYPE_H265] : [MEDIA_TYPE_H264];

	return {
		resolutions,
		framerates,
		codecs,
		bitrateRange: { min: BITRATE_MIN, max: BITRATE_MAX, unit: BITRATE_UNIT },
		supportsAudio,
		supportsResolutionOverride,
		supportsFramerateOverride,
	};
}
