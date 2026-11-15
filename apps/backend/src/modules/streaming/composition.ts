/**
 * The `composition` feature gate — the ONE rule every composition-touching seam
 * asks, so the offering, the save path and the start path cannot disagree.
 *
 * cerastream filters the `composition` token out of `get-capabilities.features`
 * unless the platform is RK3588 AND its `rgacompositor` clears a NULL→READY
 * backend trial, so the token means "a two-leg session can actually be built
 * here" rather than "the element is registered".
 */
import {
	type CapabilitiesMessage,
	COMPOSITION_FEATURE,
	COMPOSITION_GEOMETRY_FEATURE,
	type CompositionConfig,
	compositionRectFits,
	presetRect,
	type StreamingSetConfigInput,
} from "@ceraui/rpc/schemas";

export const COMPOSITION_UNSUPPORTED_ERROR = "composition_unsupported";
export const COMPOSITION_GEOMETRY_UNSUPPORTED_ERROR =
	"composition_geometry_unsupported";
export const COMPOSITION_RECT_INVALID_ERROR = "composition_rect_invalid";
export const COMPOSITION_OFF_ERROR = "composition_off";

/**
 * FAIL-CLOSED: an absent `features` array — a legacy engine, or any fallback
 * rung of the capability ladder — is not a claim of support.
 */
export function isCompositionSupported(
	caps: CapabilitiesMessage | undefined,
): boolean {
	return caps?.features?.includes(COMPOSITION_FEATURE) === true;
}

/**
 * The composition a save writes, decided against the one the device has saved.
 *
 * `composition_patch` (layout, second input, opacity) and `composition_rect` (a
 * placement: `custom` with that rectangle) are deltas, merged onto the saved
 * composition (or the one in the same save), so the sender's possibly stale
 * copy of the other fields never overwrites newer ones. A preset drops the
 * rectangle; `custom` without one keeps the saved rectangle or takes the saved
 * preset's own. A rectangle beside an explicitly stated preset contradicts
 * itself and is refused. Runs before the first config mutation: a refusal
 * leaves disk untouched. An explicit `null` is the operator turning composition
 * off and stays reachable on any engine.
 */
export function resolveCompositionWrite(
	input: Pick<
		StreamingSetConfigInput,
		"composition" | "composition_patch" | "composition_rect"
	>,
	saved: CompositionConfig | undefined,
	caps: CapabilitiesMessage | undefined,
): { composition: CompositionConfig | null | undefined } | { error: string } {
	const {
		composition,
		composition_patch: patch,
		composition_rect: rect,
	} = input;
	let next = composition;
	if (patch !== undefined || rect !== undefined) {
		const base = composition === undefined ? saved : composition;
		if (base == null) return { error: COMPOSITION_OFF_ERROR };
		const statedLayout = patch?.layout ?? composition?.layout;
		const merged: CompositionConfig = {
			...base,
			...(patch?.secondary_input_id === undefined
				? {}
				: { secondary_input_id: patch.secondary_input_id }),
			...(patch?.alpha === undefined ? {} : { alpha: patch.alpha }),
		};
		if (rect !== undefined) {
			if (statedLayout !== undefined && statedLayout !== "custom")
				return { error: COMPOSITION_RECT_INVALID_ERROR };
			next = { ...merged, layout: "custom", rect };
		} else if (patch?.layout === "custom") {
			const kept =
				base.layout === "custom" ? base.rect : presetRect(base.layout);
			next = { ...merged, layout: "custom", ...(kept ? { rect: kept } : {}) };
		} else if (patch?.layout !== undefined) {
			const { rect: _dropped, ...preset } = merged;
			next = { ...preset, layout: patch.layout };
		} else {
			next = merged;
		}
	}
	if (next == null) return { composition: next };
	if (!isCompositionSupported(caps))
		return { error: COMPOSITION_UNSUPPORTED_ERROR };
	if (next.layout !== "custom" && next.rect === undefined)
		return { composition: next };
	if (caps?.features?.includes(COMPOSITION_GEOMETRY_FEATURE) !== true)
		return { error: COMPOSITION_GEOMETRY_UNSUPPORTED_ERROR };
	const placed = next.rect ?? saved?.rect;
	if (
		next.layout !== "custom" ||
		placed === undefined ||
		!compositionRectFits(placed)
	)
		return { error: COMPOSITION_RECT_INVALID_ERROR };
	return { composition: { ...next, rect: placed } };
}

/**
 * Whether a persisted `composition` may be CLEARED FROM DISK as residue.
 *
 * Deliberately stricter than {@link isCompositionSupported}: that gate refuses a
 * write on an unproven capability, which is safe because nothing is lost. This
 * one destroys an operator's saved setup, so it demands a LIVE snapshot that
 * positively lacks the token — an unreachable engine says nothing about the
 * board, and erasing the setup on every engine blip would be unrecoverable.
 */
export function compositionResidueShouldClear(
	caps: CapabilitiesMessage | undefined,
): boolean {
	if (caps === undefined || caps.engineUnavailable === true) return false;
	return !isCompositionSupported(caps);
}
