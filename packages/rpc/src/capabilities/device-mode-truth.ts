/**
 * The exact-capability contract, as ONE pure rule shared by both consumers.
 *
 * cerastream ADR-0008 §10 settles it: a device's capability list is the flat
 * `CaptureCap` cross-product `devices.rs::caps_for` produces, and
 *
 *   - **the per-`media_type` mode ladder is the ONLY truth.** A resolution
 *     offered under `video/x-h264` says nothing about what `image/jpeg` offers on
 *     the same device;
 *   - **the engine reports the ladders VERBATIM** — no widening, no synthesis;
 *   - **the UI and the save path may never invent or union.** A consumer may
 *     filter and display, but may not construct a mode the engine did not report,
 *     and may not merge two media types' ladders into one list.
 *
 * That last clause names TWO consumers, which is why this module lives in
 * `@ceraui/rpc` rather than in either of them:
 *
 *   - the frontend `ValidationAdapter` decides what the operator is OFFERED, and
 *   - the backend `streaming.setConfig` decides what may be PERSISTED.
 *
 * They must agree by construction. An offering the save path would reject is a
 * lie told to the operator; a save the offering would have disabled is a bypass
 * of the very rule this module exists to enforce. Two implementations of one rule
 * drift — the frontend #244 defect (unioned ladders offering a resolution the
 * device could not deliver, failing `not-negotiated` at the leg) was exactly that
 * class, one layer up.
 *
 * NONE-CAP POLICY, inherited from `intersect-caps`: an unknown never subtracts.
 * Every guard below fails OPEN — absent modes, un-normalizable rungs, a kind that
 * names no advertised format — because refusing on an unknown would block a save
 * the hardware can honour, which is the same dishonesty in the other direction.
 */

import {
	AVAILABLE_RESOLUTIONS,
	type DeviceMode,
	type Framerate,
	normalizeFramerateToRung,
	normalizeResolutionToRung,
	type Resolution,
} from '../schemas/streaming.schema';
import { mediaTypeToSourceKind } from './intersect-caps';

/**
 * MJPEG's GStreamer token. It is the one media type `mediaTypeToSourceKind`
 * leaves unclassified (it maps no `image/*` token), so it is matched directly
 * below rather than duplicated into that helper's switch — which is deliberately
 * scoped to the `video/*` tokens the capability intersection consumes.
 */
export const MEDIA_TYPE_MJPEG = 'image/jpeg';

/** The encode-target ceiling a source reporting a SINGLE capture mode imposes. */
export interface SourceModeCeiling {
	resolution: Resolution;
	framerate: Framerate;
}

/** Why a requested encode target is not on the active source's ladder. */
export type DeviceModeRefusal =
	/** The request exceeds a single-signal source's reported resolution. */
	| 'resolution_above_source_signal'
	/** The request exceeds a single-signal source's reported framerate. */
	| 'framerate_above_source_signal'
	/** No mode in the governing ladder pairs this resolution with this framerate. */
	| 'mode_not_enumerated';

export type DeviceModeVerdict =
	| { supported: true }
	| { supported: false; reason: DeviceModeRefusal };

const SUPPORTED: DeviceModeVerdict = { supported: true };

/** Whether `mediaType` is the format the capture `kind` commands. */
function mediaTypeDrivesKind(mediaType: string, kind: string): boolean {
	if (mediaType === MEDIA_TYPE_MJPEG) return kind === 'mjpeg';
	// `mediaTypeToSourceKind` disambiguates `video/x-raw` into camlink-vs-hdmi from
	// a source id; the KIND is itself the truthful hint for that split, so it
	// doubles as the argument.
	return mediaTypeToSourceKind(mediaType, kind) === kind;
}

/** The distinct, explicitly tagged media types a mode list advertises. */
function advertisedMediaTypes(modes: readonly DeviceMode[]): Set<string> {
	const seen = new Set<string>();
	for (const mode of modes) {
		if (mode.media_type !== undefined) seen.add(mode.media_type);
	}
	return seen;
}

/**
 * The media type whose ladder governs a source of `kind`.
 *
 * `undefined` when there is nothing to disambiguate (fewer than two media types
 * advertised) or when the kind names none of the advertised ones — both narrow
 * NOTHING, so an untagged old-engine payload stays byte-identical and a kind we
 * cannot place never narrows on a guess.
 *
 * Which ladder applies is not itself a guess: the active source's `kind` is what
 * cerastream resolves into its `InputKind`, and that `InputKind` emits the
 * `capsfilter` media type the UVC/v4l2 negotiation runs against. The kind NAMES
 * the governing format.
 */
export function activeMediaTypeForModes(
	modes: readonly DeviceMode[] | undefined,
	kind: string | undefined,
): string | undefined {
	if (!modes || kind === undefined) return undefined;
	const advertised = advertisedMediaTypes(modes);
	if (advertised.size < 2) return undefined;
	for (const mediaType of advertised) {
		if (mediaTypeDrivesKind(mediaType, kind)) return mediaType;
	}
	return undefined;
}

/**
 * The subset of `modes` belonging to `mediaType`.
 *
 * An UNTAGGED mode is kept — it carries no format constraint, so it can never be
 * SHOWN to belong to another ladder. Returns the input array unchanged (same
 * reference) whenever nothing is dropped, and falls back to it wholesale rather
 * than emptying the list.
 */
export function scopeModesToMediaType(
	modes: readonly DeviceMode[] | undefined,
	mediaType: string | undefined,
): readonly DeviceMode[] | undefined {
	if (!modes || mediaType === undefined) return modes;
	const scoped = modes.filter(
		(mode) => mode.media_type === undefined || mode.media_type === mediaType,
	);
	if (scoped.length === 0 || scoped.length === modes.length) return modes;
	return scoped;
}

/**
 * The ceiling a source reporting a SINGLE capture mode imposes on the encode
 * target, or `undefined` for a source that enumerates a mode menu.
 *
 * A reported SIGNAL is not an enumeration. cerastream's DV-timings projection
 * collapses an HDMI receiver to whatever is currently on the cable, and the
 * capture leg downscales and rate-converts freely (`videoscale`/`videorate` are
 * wired in both the generic capture-leg builder and the RK3588 template) — so
 * that one mode BOUNDS the encode target from above rather than enumerating it.
 *
 * Fail-closed: a modeless source, and a mode list whose rungs do not normalize
 * onto the ladder, both yield no ceiling — a noisy payload can never WIDEN the
 * offering by being mistaken for a single clean signal.
 */
export function singleModeSourceCeiling(
	modes: readonly DeviceMode[] | undefined,
): SourceModeCeiling | undefined {
	if (!modes || modes.length === 0) return undefined;
	const resolutions = new Set<Resolution>();
	const framerates = new Set<Framerate>();
	for (const mode of modes) {
		const rung = normalizeResolutionToRung(`${mode.width}x${mode.height}`);
		if (rung !== undefined) resolutions.add(rung);
		for (const framerate of mode.framerates) {
			const rate = normalizeFramerateToRung(framerate);
			if (rate !== undefined) framerates.add(rate);
		}
	}
	if (resolutions.size !== 1 || framerates.size !== 1) return undefined;
	const [resolution] = [...resolutions];
	const [framerate] = [...framerates];
	if (resolution === undefined || framerate === undefined) return undefined;
	return { resolution, framerate };
}

/** The encode target being checked against a source's reported ladder. */
export interface DeviceModeQuery {
	/** The source's engine-reported modes. Absent/empty ⇒ no truth ⇒ no refusal. */
	modes: readonly DeviceMode[] | undefined;
	/** The source's capture kind — it NAMES the governing media type. */
	kind?: string | undefined;
	/** The requested encode resolution. Omitted ⇒ that axis is not checked. */
	resolution?: Resolution | undefined;
	/** The requested encode framerate. Omitted ⇒ that axis is not checked. */
	framerate?: Framerate | undefined;
}

/**
 * Whether a requested encode target is one the ACTIVE source can actually
 * deliver, per the exact-capability contract.
 *
 * Two models, and the split is load-bearing:
 *
 *   - a SINGLE-mode source is a CEILING — everything at or below it on both axes
 *     is reachable through the capture leg's scaler/rate-converter;
 *   - an ENUMERATED menu is exact — for a UVC negotiation there is no
 *     `videoscale`/`videorate` safety net in front of the device, so an encode
 *     target the device does not enumerate has no mode to negotiate at all.
 *
 * The ceiling test deliberately reads the FULL, unscoped mode list: a device that
 * enumerates a real menu must not collapse into a ceiling merely because
 * media-type scoping left one mode standing.
 */
export function evaluateDeviceMode(query: DeviceModeQuery): DeviceModeVerdict {
	const { modes, kind, resolution, framerate } = query;
	if (!modes || modes.length === 0) return SUPPORTED;
	if (resolution === undefined && framerate === undefined) return SUPPORTED;

	const ceiling = singleModeSourceCeiling(modes);
	if (ceiling) {
		if (resolution !== undefined) {
			const requested = AVAILABLE_RESOLUTIONS.indexOf(resolution);
			const limit = AVAILABLE_RESOLUTIONS.indexOf(ceiling.resolution);
			// A resolution outside the ladder cannot be placed against the ceiling,
			// so it is not refused (none-cap policy).
			if (requested >= 0 && limit >= 0 && requested > limit) {
				return { supported: false, reason: 'resolution_above_source_signal' };
			}
		}
		if (framerate !== undefined && framerate > ceiling.framerate) {
			return { supported: false, reason: 'framerate_above_source_signal' };
		}
		return SUPPORTED;
	}

	const scoped = scopeModesToMediaType(modes, activeMediaTypeForModes(modes, kind)) ?? modes;

	// One mode must pair BOTH axes. Checking them independently is precisely the
	// cross-product lie this contract forbids — 1080p and 60fps can each be real
	// on a device that cannot drive them together.
	for (const mode of scoped) {
		if (resolution !== undefined) {
			const rung = normalizeResolutionToRung(`${mode.width}x${mode.height}`);
			if (rung !== resolution) continue;
		}
		if (framerate !== undefined) {
			const drivesRate = mode.framerates.some(
				(rate) => normalizeFramerateToRung(rate) === framerate,
			);
			if (!drivesRate) continue;
		}
		return SUPPORTED;
	}

	// Fail open when the ladder carries NO placeable rung at all: the engine
	// reported modes we cannot normalize, which is an absence of truth, not
	// evidence against the request.
	const anyPlaceable = scoped.some(
		(mode) =>
			normalizeResolutionToRung(`${mode.width}x${mode.height}`) !== undefined &&
			mode.framerates.some((rate) => normalizeFramerateToRung(rate) !== undefined),
	);
	if (!anyPlaceable) return SUPPORTED;

	return { supported: false, reason: 'mode_not_enumerated' };
}

/**
 * The nearest mode a source CAN deliver for an out-of-ladder request — the
 * load-time clamp target for a config persisted against different hardware.
 *
 * "Nearest" is deliberately downward-biased: it prefers the highest offered rung
 * AT OR BELOW the request on each axis, stepping up only when nothing below
 * exists. Clamping UP would hand the operator a mode they never chose and the
 * device may struggle with; clamping DOWN degrades a setting they did choose.
 * Both axes are resolved from ONE real mode, so the result is always a pairing
 * the device actually enumerated.
 *
 * `undefined` when the source reports no usable ladder — there is then nothing
 * truthful to clamp TO, and the caller must leave the persisted value alone.
 */
export function nearestDeliverableMode(query: DeviceModeQuery): SourceModeCeiling | undefined {
	const { modes, kind, resolution, framerate } = query;
	if (!modes || modes.length === 0) return undefined;

	const ceiling = singleModeSourceCeiling(modes);
	if (ceiling) {
		const requested = resolution ? AVAILABLE_RESOLUTIONS.indexOf(resolution) : -1;
		const limit = AVAILABLE_RESOLUTIONS.indexOf(ceiling.resolution);
		const keepResolution = requested >= 0 && limit >= 0 && requested <= limit;
		return {
			resolution: keepResolution && resolution ? resolution : ceiling.resolution,
			framerate:
				framerate !== undefined && framerate <= ceiling.framerate ? framerate : ceiling.framerate,
		};
	}

	const scoped = scopeModesToMediaType(modes, activeMediaTypeForModes(modes, kind)) ?? modes;

	// Every enumerated {rung, rate} pairing, so the chosen pair is always real.
	const pairs: SourceModeCeiling[] = [];
	for (const mode of scoped) {
		const rung = normalizeResolutionToRung(`${mode.width}x${mode.height}`);
		if (rung === undefined) continue;
		for (const rate of mode.framerates) {
			const normalized = normalizeFramerateToRung(rate);
			if (normalized !== undefined) pairs.push({ resolution: rung, framerate: normalized });
		}
	}
	if (pairs.length === 0) return undefined;

	const wantResolution = resolution ? AVAILABLE_RESOLUTIONS.indexOf(resolution) : -1;
	const wantFramerate = framerate;

	// Distance is (resolution rungs, then framerate) with a penalty on stepping UP,
	// so a lower rung always beats a higher one at equal absolute distance.
	const cost = (pair: SourceModeCeiling): [number, number] => {
		const index = AVAILABLE_RESOLUTIONS.indexOf(pair.resolution);
		const resolutionDelta =
			wantResolution < 0
				? 0
				: index <= wantResolution
					? wantResolution - index
					: (index - wantResolution) * 100;
		const framerateDelta =
			wantFramerate === undefined
				? 0
				: pair.framerate <= wantFramerate
					? wantFramerate - pair.framerate
					: (pair.framerate - wantFramerate) * 100;
		return [resolutionDelta, framerateDelta];
	};

	let best = pairs[0] as SourceModeCeiling;
	let bestCost = cost(best);
	for (const pair of pairs.slice(1)) {
		const pairCost = cost(pair);
		if (pairCost[0] < bestCost[0] || (pairCost[0] === bestCost[0] && pairCost[1] < bestCost[1])) {
			best = pair;
			bestCost = pairCost;
		}
	}
	return best;
}
