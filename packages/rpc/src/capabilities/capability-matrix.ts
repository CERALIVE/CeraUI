import {
	CAPABILITY_MODULES,
	type CapabilityEvidence,
	type CapabilityModule,
	type CapabilityModuleClaims,
	mayClaimSupport,
	mayRenderModule,
	resolveSupportClaim,
	type SupportClaimState,
} from '../schemas/capability-modules.schema';

/**
 * The per-module registry of what THIS BUILD actually ships.
 *
 * It is EMPTY on purpose. This change lands the feature-gate framework, the
 * taxonomy and the shared mutation-enforcement helper; each of the seven modules
 * adds itself here in its own reviewed change, alongside its capability probe and
 * its certification evidence. Until a module is listed, every device resolves it
 * to `unavailable` — which is the honest answer, and which is what stops a config
 * gate from surfacing a control with nothing behind it.
 */
export const IMPLEMENTED_CAPABILITY_MODULES: readonly CapabilityModule[] = ['fcc-auto-unlock'];

export interface CapabilityMatrixInput {
	/** Modules this build ships. Defaults to the registry above. */
	readonly implemented?: readonly CapabilityModule[];
	/** Device-config gates. An absent entry is OFF — absence is never consent. */
	readonly gates: Partial<Record<CapabilityModule, boolean>>;
	/** Per-modem probe results. An absent entry is `unknown`, never `absent`. */
	readonly capability: Partial<Record<CapabilityModule, CapabilityEvidence>>;
	/** Reviewed evidence for this modem's exact model+firmware. Absent is false. */
	readonly certified?: Partial<Record<CapabilityModule, boolean>>;
}

/**
 * Resolve the full seven-module claim matrix for ONE modem. Total by
 * construction: every module gets an explicit state, so a consumer can never
 * mistake an omitted key for a lowered claim.
 */
export function resolveCapabilityMatrix(input: CapabilityMatrixInput): CapabilityModuleClaims {
	const implemented = new Set(input.implemented ?? IMPLEMENTED_CAPABILITY_MODULES);
	const claims = {} as Record<CapabilityModule, SupportClaimState>;
	for (const module of CAPABILITY_MODULES) {
		claims[module] = resolveSupportClaim({
			implemented: implemented.has(module),
			gateEnabled: input.gates[module] === true,
			capability: input.capability[module] ?? 'unknown',
			certified: input.certified?.[module] === true,
		});
	}
	return claims;
}

/** The modules a UI may offer. Everything else renders as its honest state. */
export function surfaceableModules(claims: CapabilityModuleClaims): CapabilityModule[] {
	return CAPABILITY_MODULES.filter((module) => mayRenderModule(claims[module]));
}

/** The modules a support matrix or doc may claim. */
export function claimableModules(claims: CapabilityModuleClaims): CapabilityModule[] {
	return CAPABILITY_MODULES.filter((module) => mayClaimSupport(claims[module]));
}
