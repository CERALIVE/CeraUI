/**
 * Capability-tier → UI-state mapping (Task 9).
 *
 * The `capabilitiesMessageSchema` carries three optional boolean tier flags the
 * engine raises when the offered set cannot be trusted as authoritative:
 *
 *   • `engineUnavailable`      — the engine isn't answering `get-capabilities`.
 *   • `engineStarting`         — the engine is booting; caps are not final yet.
 *   • `schemaVersionMismatch`  — the engine speaks a newer/older caps schema, so
 *                                some options may be approximate.
 *
 * This pure, rune-free module collapses those flags into ONE discriminated UI
 * state so the banner + control-gating render from a single, testable source.
 * It never renders i18n text — the component maps `tier` onto `live.education.*`
 * copy. Severity is intentionally calm: every non-normal tier is an
 * informational `role="status"`, NOT an error/alert (instrument-clarity tone —
 * a starting engine is expected, not a failure).
 *
 * Priority (most to least constraining): engineUnavailable › engineStarting ›
 * schemaVersionMismatch › normal. Only one tier is ever active.
 */
import type { CapabilitiesMessage } from "@ceraui/rpc/schemas";

export type CapabilityTier =
	| "normal"
	| "engineStarting"
	| "engineUnavailable"
	| "schemaVersionMismatch";

/** The non-normal tiers, in render-priority order (most constraining first). */
export const CAPABILITY_TIER_PRIORITY: readonly Exclude<
	CapabilityTier,
	"normal"
>[] = ["engineUnavailable", "engineStarting", "schemaVersionMismatch"] as const;

/**
 * The resolved presentation contract for a tier. Carries only presentation
 * tokens (no i18n text), so it is fully assertable in a unit test without a
 * locale.
 */
export interface CapabilityTierView {
	tier: CapabilityTier;
	/** ARIA live role for the banner. Calm `status` for every visible tier. */
	role: "status" | null;
	/** Whether a banner renders at all (false only for `normal`). */
	visible: boolean;
	/**
	 * Whether config controls should be locked. True while the engine is
	 * unavailable or still starting — the offered set isn't trustworthy yet. A
	 * schema mismatch is advisory only and never locks controls.
	 */
	disablesControls: boolean;
	/** Whether the banner shows the booting skeleton/spinner (engineStarting). */
	showsSkeleton: boolean;
	/** Stable test/automation hook for the rendered banner. */
	testId: string;
}

/** Resolve the active tier from a capabilities snapshot (or its absence). */
export function capabilityTier(
	caps: CapabilitiesMessage | undefined,
): CapabilityTier {
	if (!caps) return "normal";
	if (caps.engineUnavailable) return "engineUnavailable";
	if (caps.engineStarting) return "engineStarting";
	if (caps.schemaVersionMismatch) return "schemaVersionMismatch";
	return "normal";
}

/** Map a tier onto its presentation contract. */
export function capabilityTierView(tier: CapabilityTier): CapabilityTierView {
	switch (tier) {
		case "engineUnavailable":
			return {
				tier,
				role: "status",
				visible: true,
				disablesControls: true,
				showsSkeleton: false,
				testId: "capability-engine-unavailable",
			};
		case "engineStarting":
			return {
				tier,
				role: "status",
				visible: true,
				disablesControls: true,
				showsSkeleton: true,
				testId: "capability-engine-starting",
			};
		case "schemaVersionMismatch":
			return {
				tier,
				role: "status",
				visible: true,
				disablesControls: false,
				showsSkeleton: false,
				testId: "capability-schema-mismatch",
			};
		case "normal":
			return {
				tier,
				role: null,
				visible: false,
				disablesControls: false,
				showsSkeleton: false,
				testId: "capability-normal",
			};
	}
}

/** Convenience: resolve a snapshot straight to its presentation contract. */
export function capabilityTierViewFor(
	caps: CapabilitiesMessage | undefined,
): CapabilityTierView {
	return capabilityTierView(capabilityTier(caps));
}
