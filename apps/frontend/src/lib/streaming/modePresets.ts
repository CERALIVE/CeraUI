/**
 * Mode-preset → encoder-draft mapping — SINGLE SOURCE OF TRUTH (Task 7).
 *
 * The EncoderDialog leads with the shared mode-preset catalog (Task 1's
 * `CANONICAL_PRESETS`). A preset is a named resolution / framerate / codec
 * combination; selecting one seeds the editable encoder draft. This module is
 * the pure, rune-free bridge between the catalog and the dialog draft so the
 * mapping (and the supported/disabled verdict) can be unit-tested without
 * mounting Svelte.
 *
 * Two responsibilities:
 *   1. {@link presetToDraft} — apply a preset onto the current draft. It writes
 *      `resolution`, `framerate`, `bitrate` (from `bitrateDefault`), and `codec`
 *      (the preset's codec as a wire `VideoCodec`, so the preset TRULY applies
 *      its codec → `video_codec`); `source` and `bitrateOverlay` are
 *      operator-owned and carried through untouched.
 *   2. {@link presetViews} — tag every catalog preset with whether the current
 *      offered capability set supports it, mirroring the resolution/framerate
 *      option pattern: an unsupported preset is RETURNED (not filtered) with a
 *      reason key so the dialog can render it disabled-with-reason, never hidden.
 */
import {
	CANONICAL_PRESETS,
	MEDIA_TYPE_H264,
	MEDIA_TYPE_H265,
	type ModePreset,
	type OfferedSet,
	presetMatchesOffered,
} from "@ceraui/rpc";
import type { VideoCodec } from "@ceraui/rpc/schemas";

import {
	type BitrateBounds,
	clampBitrateToBounds,
	OPTION_UNSUPPORTED_ON_PLATFORM,
} from "$lib/components/streaming/ValidationAdapter";
import type { EncoderConfig } from "$main/dialogs/EncoderDialog.svelte";

export type { ModePreset };

/** The canonical presets as a stable, render-ready array (catalog order). */
export const MODE_PRESETS: readonly ModePreset[] =
	Object.values(CANONICAL_PRESETS);

/**
 * Map a preset's media-type codec (`video/x-h264`) to the wire `VideoCodec`
 * (`h264`) the encoder draft + `video_codec` field speak. Returns `undefined`
 * for an unrecognised media type so an unknown codec never fabricates a value.
 */
export function videoCodecFromMediaType(
	mediaType: string,
): VideoCodec | undefined {
	if (mediaType === MEDIA_TYPE_H265) return "h265";
	if (mediaType === MEDIA_TYPE_H264) return "h264";
	return undefined;
}

/**
 * Apply a preset to an encoder draft. Resolution, framerate, and codec come
 * straight from the preset; bitrate comes from the preset's `bitrateDefault`,
 * clamped to the board's real bitrate window so a 4K preset's 8 Mbps default
 * can't exceed a lower-cap board. Source and overlay are operator-owned and
 * preserved.
 *
 * Pure: returns a new draft, never mutates the input.
 */
export function presetToDraft(
	preset: ModePreset,
	draft: EncoderConfig,
	bounds: BitrateBounds,
): EncoderConfig {
	const bitrate =
		preset.bitrateDefault !== undefined
			? clampBitrateToBounds(preset.bitrateDefault, bounds)
			: draft.bitrate;
	return {
		...draft,
		resolution: preset.resolution,
		framerate: preset.framerate,
		bitrate,
		codec: videoCodecFromMediaType(preset.codec),
	};
}

/**
 * Find the catalog preset whose resolution + framerate match the draft AND whose
 * codec matches the effective codec (when one is known). `codec` is a wire
 * `VideoCodec` (`h264`/`h265`) — the operator's explicit choice, or the
 * Auto-resolved default the dialog passes. Returns the preset id, or `null` when
 * the draft is a bespoke combination ("Custom"). Used on seed to highlight a
 * matching preset; an explicit selection or any Advanced edit then owns the
 * active state from there.
 */
export function findMatchingPresetId(
	draft: Pick<EncoderConfig, "resolution" | "framerate">,
	codec?: VideoCodec,
): string | null {
	for (const preset of MODE_PRESETS) {
		if (preset.resolution !== draft.resolution) continue;
		if (preset.framerate !== draft.framerate) continue;
		if (
			codec !== undefined &&
			videoCodecFromMediaType(preset.codec) !== codec
		) {
			continue;
		}
		return preset.id;
	}
	return null;
}

/**
 * A preset plus its capability verdict. `supported` drives whether the card is
 * selectable; `reason` is the disabled tooltip i18n key (undefined when
 * supported), mirroring {@link EncoderOption}.
 */
export interface PresetView {
	preset: ModePreset;
	supported: boolean;
	reason: string | undefined;
}

/**
 * Tag every catalog preset with whether `offered` supports it. An unsupported
 * preset is returned (not dropped) with the platform-unsupported reason key, so
 * the dialog shows it disabled-with-reason rather than hiding it.
 */
export function presetViews(offered: OfferedSet): PresetView[] {
	return MODE_PRESETS.map((preset) => {
		const supported = presetMatchesOffered(preset, offered);
		return {
			preset,
			supported,
			reason: supported ? undefined : OPTION_UNSUPPORTED_ON_PLATFORM,
		};
	});
}
