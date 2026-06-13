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
 * An unknown / unparseable max is treated permissively — the whole ladder is
 * offered rather than nothing.
 */
function platformResolutionLadder(maxResolution: string): string[] {
	const normalized = maxResolution === '4k' ? '2160p' : maxResolution;
	const maxIndex = RESOLUTION_LADDER.indexOf(normalized as Resolution);
	if (maxIndex === -1) {
		return [...RESOLUTION_LADDER];
	}
	return RESOLUTION_LADDER.slice(0, maxIndex + 1);
}

/**
 * Compute the effective `OfferedSet` for a platform ∩ source ∩ mode combination.
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
 * None-cap (permissive) policy: a `source` of `undefined` means nothing is known
 * about the capture side, so nothing is narrowed — the full platform ladder is
 * offered and every override toggle reads live.
 */
export function intersectCaps(
	platform: PlatformCaps,
	source: VideoSourceCap | undefined,
	mode: string,
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

	const resolutions =
		source && !supportsResolutionOverride ? [source.default_resolution] : platformResolutions;

	const framerates: number[] =
		source && !supportsFramerateOverride ? [source.default_framerate] : [...AVAILABLE_FRAMERATES];

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
