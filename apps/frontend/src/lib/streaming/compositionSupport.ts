import {
	type CapabilitiesMessage,
	COMPOSITION_FEATURE,
} from "@ceraui/rpc/schemas";

/**
 * Whether the engine advertises picture composition. FAIL-CLOSED: `features` is
 * absent on every fallback rung of the capability ladder (engine starting,
 * engine unavailable, a build that predates the token), and none of those is a
 * claim that this board can compose. Shared by both Live cockpits.
 */
export function compositionSupported(
	capabilities: CapabilitiesMessage | undefined,
): boolean {
	return capabilities?.features?.includes(COMPOSITION_FEATURE) === true;
}
