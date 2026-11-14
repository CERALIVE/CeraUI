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
	type StreamingSetConfigInput,
} from "@ceraui/rpc/schemas";

export const COMPOSITION_UNSUPPORTED_ERROR = "composition_unsupported";
export const COMPOSITION_GEOMETRY_UNSUPPORTED_ERROR =
	"composition_geometry_unsupported";
export const COMPOSITION_RECT_INVALID_ERROR = "composition_rect_invalid";

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
 * Whether a persisted `composition` may be CLEARED FROM DISK as residue.
 *
 * Deliberately stricter than {@link isCompositionSupported}: that gate refuses a
 * write on an unproven capability, which is safe because nothing is lost. This
 * one destroys an operator's saved setup, so it demands a LIVE snapshot that
 * positively lacks the token — an unreachable engine says nothing about the
 * board, and erasing the setup on every engine blip would be unrecoverable.
 */
/**
 * The composition a save writes, decided against the one the device has saved.
 *
 * A `composition_rect` placement is composed onto the saved composition (or the
 * one in the same save) as `layout: 'custom'` with that rectangle, and a custom
 * write without a rectangle keeps the saved one, so the sender's possibly stale
 * copy of the other fields never overwrites newer ones. Runs before the first
 * config mutation: a refusal leaves disk untouched. An explicit `null` is the
 * operator turning composition off and stays reachable on any engine.
 */
export function resolveCompositionWrite(
	input: Pick<StreamingSetConfigInput, "composition" | "composition_rect">,
	saved: CompositionConfig | undefined,
	caps: CapabilitiesMessage | undefined,
): { composition: CompositionConfig | null | undefined } | { error: string } {
	let next = input.composition;
	if (input.composition_rect !== undefined) {
		const base = next === undefined ? saved : next;
		if (base == null) return { error: COMPOSITION_RECT_INVALID_ERROR };
		next = { ...base, layout: "custom", rect: input.composition_rect };
	}
	if (next == null) return { composition: next };
	if (!isCompositionSupported(caps))
		return { error: COMPOSITION_UNSUPPORTED_ERROR };
	if (next.layout !== "custom" && next.rect === undefined)
		return { composition: next };
	if (caps?.features?.includes(COMPOSITION_GEOMETRY_FEATURE) !== true)
		return { error: COMPOSITION_GEOMETRY_UNSUPPORTED_ERROR };
	const rect = next.rect ?? saved?.rect;
	if (
		next.layout !== "custom" ||
		rect === undefined ||
		!compositionRectFits(rect)
	)
		return { error: COMPOSITION_RECT_INVALID_ERROR };
	return { composition: { ...next, rect } };
}

export function compositionResidueShouldClear(
	caps: CapabilitiesMessage | undefined,
): boolean {
	if (caps === undefined || caps.engineUnavailable === true) return false;
	return !isCompositionSupported(caps);
}
