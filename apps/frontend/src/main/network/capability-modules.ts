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
