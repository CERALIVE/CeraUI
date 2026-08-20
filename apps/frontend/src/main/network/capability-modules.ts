/**
 * The render half of the capability feature-gate framework.
 *
 * Pure and rune-free, like `cellular-row.ts` beside it. It answers exactly one
 * question per module — may this control be OFFERED to the operator — and it
 * answers it from the device's own resolved claim rather than re-deriving the
 * ladder here. A second derivation would be free to disagree with the backend's,
 * and every way it could disagree is a lie: an offered control the device
 * refuses, or a hidden control the hardware supports.
 *
 * A module that is not surfaceable is NOT dropped. It is rendered in its honest
 * state — which is what makes an `unavailable` on a modem the operator has
 * already enabled the gate for readable as "this hardware cannot do it" instead
 * of as a missing row they go hunting for.
 */

import {
	CAPABILITY_MODULES,
	type CapabilityModule,
	type CapabilityModuleClaims,
	mayRenderModule,
	type SupportClaimState,
} from "@ceraui/rpc/schemas";

/**
 * The FOUR operation states `DESIGN.md` §1 renders, and the ONE resolver every
 * capability surface routes through.
 *
 *   available — claim ≥ `capable` and nothing refuses it right now. The control
 *               is rendered and it works.
 *   blocked   — claim ≥ `capable`, but the device refuses it AT THIS MOMENT
 *               (CT-2). The control is rendered, DISABLED, with an on-screen
 *               reason — never a bare disabled control, never a toast-only one.
 *   unknown   — nothing has been established about this modem: the gate is off
 *               so nothing was probed, or the probe could not answer (CT-3). It
 *               renders a VISIBLY DISTINCT `role="status"` diagnostic and NO
 *               control — it may never be hidden and may never be rendered as
 *               unsupported.
 *   absent    — positively unsupported, or not shipped in this build (CT-1).
 *               ZERO DOM nodes. Not a ghost, not a tooltip, not a greyed row.
 *
 * CT-4 is why `unknown` carries no control at all: a disabled control implies a
 * capability being withheld, and below `capable` nobody has shown there is one.
 * That is a stricter rule than "render everything disabled" and it is the point —
 * a fake disabled control is the specific lie this ladder exists to prevent.
 */
export const CAPABILITY_RENDER_MODES = [
	"available",
	"blocked",
	"unknown",
	"absent",
] as const;
export type CapabilityRenderMode = (typeof CAPABILITY_RENDER_MODES)[number];

export interface CapabilityReasonKeys {
	/** The device-config gate is OFF. Turning it on is the operator's fix. */
	readonly moduleDisabled: string;
	/** The gate is on and the capability could not be established. */
	readonly unproven: string;
}

export type CapabilityRenderView =
	| { readonly mode: "absent" }
	| { readonly mode: "unknown"; readonly reasonKey: string }
	| { readonly mode: "blocked"; readonly reasonKey: string }
	| { readonly mode: "available" };

/**
 * Resolve one module's render state from its claim.
 *
 * `blockedReasonKey` is the CURRENT refusal — a device-side condition a
 * ≥`capable` module is temporarily standing behind (no coverage entry, no status
 * block, a held lease). It is IGNORED below `capable`, by construction: CT-4
 * forbids a disabled control there, so a caller cannot accidentally promote an
 * unproven module into one by passing a reason.
 *
 * Pure and total, which is also CT-5: two calls with the same evidence return
 * the same view, so an unknown state can never degrade into a hidden one on a
 * re-render.
 */
export function resolveCapabilityRender(
	claim: SupportClaimState | undefined,
	reasons: CapabilityReasonKeys,
	blockedReasonKey?: string,
): CapabilityRenderView {
	// An ABSENT claim is a backend that never published the matrix. It is folded
	// into `unavailable` for the same fail-closed reason `buildCapabilityModuleViews`
	// does: absence of a claim is not a claim, and a radio-mutating control must
	// not be offered to a device that never described itself.
	if (claim === undefined || claim === "unavailable") return { mode: "absent" };
	if (claim === "implemented") {
		return { mode: "unknown", reasonKey: reasons.moduleDisabled };
	}
	if (claim === "enabled") {
		return { mode: "unknown", reasonKey: reasons.unproven };
	}
	return blockedReasonKey === undefined
		? { mode: "available" }
		: { mode: "blocked", reasonKey: blockedReasonKey };
}

export type CapabilityModuleView = {
	readonly module: CapabilityModule;
	readonly state: SupportClaimState;
	/** Whether the module's own control may be offered. */
	readonly surfaced: boolean;
};

/**
 * A modem row from a backend that does not publish the matrix resolves every
 * module to `unavailable` — fail-CLOSED, because absence of a claim is not a
 * claim, and offering a radio-mutating control to a device that never described
 * itself is the one outcome this framework exists to prevent.
 */
export function buildCapabilityModuleViews(
	claims: CapabilityModuleClaims | undefined,
): CapabilityModuleView[] {
	return CAPABILITY_MODULES.map((module) => {
		const state: SupportClaimState = claims?.[module] ?? "unavailable";
		return { module, state, surfaced: mayRenderModule(state) };
	});
}

export function surfacedCapabilityModules(
	claims: CapabilityModuleClaims | undefined,
): CapabilityModule[] {
	return buildCapabilityModuleViews(claims)
		.filter((view) => view.surfaced)
		.map((view) => view.module);
}
