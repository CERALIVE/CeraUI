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
} from "@ceraui/rpc/schemas";

export const COMPOSITION_UNSUPPORTED_ERROR = "composition_unsupported";

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
export function compositionResidueShouldClear(
	caps: CapabilitiesMessage | undefined,
): boolean {
	if (caps === undefined || caps.engineUnavailable === true) return false;
	return !isCompositionSupported(caps);
}
