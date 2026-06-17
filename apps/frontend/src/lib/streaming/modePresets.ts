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
 *      `resolution`, `framerate`, and `bitrate` (from `bitrateDefault`); `source`
 *      and `bitrateOverlay` are operator-owned and carried through untouched.
 *      The preset `codec` is NOT a persisted draft field (the streaming
 *      `setConfig` contract has no video-codec key — codec is platform-derived),
 *      so it is surfaced separately for display/active-state via
 *      {@link presetView} and never written into the draft.
 *   2. {@link presetViews} — tag every catalog preset with whether the current
 *      offered capability set supports it, mirroring the resolution/framerate
 *      option pattern: an unsupported preset is RETURNED (not filtered) with a
 *      reason key so the dialog can render it disabled-with-reason, never hidden.
 */
import {
	CANONICAL_PRESETS,
	type ModePreset,
	type OfferedSet,
	presetMatchesOffered,
} from "@ceraui/rpc";

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
 * Apply a preset to an encoder draft. Resolution and framerate come straight
 * from the preset; bitrate comes from the preset's `bitrateDefault`, clamped to
 * the board's real bitrate window so a 4K preset's 8 Mbps default can't exceed a
 * lower-cap board. Source and overlay are operator-owned and preserved.
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
	};
}

/**
 * Find the catalog preset whose resolution + framerate match the draft AND whose
 * codec matches the active codec (when one is known). Returns the preset id, or
 * `null` when the draft is a bespoke combination ("Custom"). Used on seed to
 * highlight a matching preset; an explicit selection or any Advanced edit then
 * owns the active state from there.
 */
export function findMatchingPresetId(
	draft: Pick<EncoderConfig, "resolution" | "framerate">,
	codec?: string,
): string | null {
	for (const preset of MODE_PRESETS) {
		if (preset.resolution !== draft.resolution) continue;
		if (preset.framerate !== draft.framerate) continue;
		if (codec !== undefined && preset.codec !== codec) continue;
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
