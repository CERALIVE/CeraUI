import { z } from 'zod';

/**
 * The capability-module feature-gate framework and its support-claim taxonomy.
 *
 * It lives in this package, like `device-mode-truth.ts`, because THREE consumers
 * must agree by construction: the backend decides what may be MUTATED, the
 * frontend decides what is SURFACED, and the support matrix decides what may be
 * CLAIMED. Three copies of one ladder drift, and every way they can drift is a
 * lie told to somebody — an offered control the device refuses, a hidden control
 * the hardware supports, or a documented capability nobody proved.
 *
 * This file is the FRAMEWORK ONLY. It implements none of the seven modules; each
 * lands as its own reviewed change and consumes the helpers here.
 */

// ── The seven gated modules ──────────────────────────────────────────────────
// Every one of them is DEFAULT-OFF (see `resolveSupportClaim`): each either
// mutates the radio in a way that can cost the bond link, or reaches a surface
// (SMS, USSD, eSIM) that is billable, irreversible, or both.
export const CAPABILITY_MODULES = [
	'band-lock',
	'sms',
	'five-g-pref',
	'fcc-auto-unlock',
	'gps',
	'ussd',
	'esim',
] as const;
export const capabilityModuleSchema = z.enum(CAPABILITY_MODULES);
export type CapabilityModule = z.infer<typeof capabilityModuleSchema>;

// ── The FIVE-STATE support-claim taxonomy ────────────────────────────────────
/**
 * A monotone ladder. `resolveSupportClaim` returns the HIGHEST rung reached, so
 * the state is a single honest answer rather than a bag of independent flags:
 *
 *   unavailable — this build does not ship the module, OR this modem POSITIVELY
 *                 lacks the capability. Nothing the operator does here can work,
 *                 and saying so is the whole point of the state existing: a gate
 *                 an operator has already turned ON must still read `unavailable`
 *                 on hardware that cannot honour it, never a silently missing row.
 *   implemented — the module ships, but the device-config gate is OFF. This is
 *                 the DEFAULT for all seven, on every device, forever, until an
 *                 operator opts in.
 *   enabled     — the gate is ON, but the modem's capability is UNKNOWN (not yet
 *                 probed, or the probe could not answer). "We have not looked" is
 *                 not "it is absent" — the ladder stops here rather than guessing
 *                 in either direction.
 *   capable     — the gate is ON and the modem POSITIVELY advertises the
 *                 capability. This is the floor for SURFACING a control.
 *   certified   — capable, AND a reviewed evidence bundle proves the module on
 *                 this exact model+firmware. This is the ONLY rung a support
 *                 matrix or a doc may claim.
 */
export const SUPPORT_CLAIM_STATES = [
	'unavailable',
	'implemented',
	'enabled',
	'capable',
	'certified',
] as const;
export const supportClaimStateSchema = z.enum(SUPPORT_CLAIM_STATES);
export type SupportClaimState = z.infer<typeof supportClaimStateSchema>;

/**
 * What a probe found. `unknown` is a first-class answer, never folded into
 * `absent` — an unreadable modem is a statement about the READ, and treating it
 * as a statement about the DEVICE is how a working capability disappears for the
 * lifetime of a process.
 */
export const capabilityEvidenceSchema = z.enum(['present', 'absent', 'unknown']);
export type CapabilityEvidence = z.infer<typeof capabilityEvidenceSchema>;

export interface SupportClaimInput {
	/** Does this build ship the module at all? */
	readonly implemented: boolean;
	/** Has an operator turned the device-config gate ON? */
	readonly gateEnabled: boolean;
	/** What the modem itself says about the capability. */
	readonly capability: CapabilityEvidence;
	/** Is there a reviewed evidence bundle for this model+firmware? */
	readonly certified: boolean;
}

/** Resolve one module's support claim. Pure, total, never throws. */
export function resolveSupportClaim(input: SupportClaimInput): SupportClaimState {
	// Two conditions make the module unusable regardless of the operator's gate,
	// and both must answer `unavailable` so the UI can say so out loud.
	if (!input.implemented || input.capability === 'absent') {
		return 'unavailable';
	}
	if (!input.gateEnabled) {
		return 'implemented';
	}
	if (input.capability === 'unknown') {
		return 'enabled';
	}
	// Certification is a claim ABOUT a present capability, so it can only ever be
	// reached from `capable`. A `certified: true` on an unprobed modem is not
	// evidence about that modem and is deliberately ignored above.
	return input.certified ? 'certified' : 'capable';
}

/**
 * The ONLY states at which a module's control may be offered: the gate is ON and
 * the modem positively advertises the capability. Certification governs what may
 * be CLAIMED, not what may be USED — refusing to surface an uncertified-but-
 * capable control would hide working hardware behind a paperwork gate.
 */
export const SURFACEABLE_SUPPORT_STATES: readonly SupportClaimState[] = ['capable', 'certified'];

export function mayRenderModule(state: SupportClaimState): boolean {
	return SURFACEABLE_SUPPORT_STATES.includes(state);
}

/** Docs and the support matrix may claim a combination ONLY at `certified`. */
export function mayClaimSupport(state: SupportClaimState): boolean {
	return state === 'certified';
}

// ── Wire shape ───────────────────────────────────────────────────────────────
/**
 * Every module is present on every modem row, ALWAYS — never present-only-when-
 * supported. The frontend status/modem merges preserve an omitted optional field,
 * so a claim published only when true can be raised and never lowered (the
 * `policy_route_missing` latch, exactly). A `z.record` over the module enum is
 * total, so the schema itself enforces it.
 */
export const capabilityModuleClaimsSchema = z.record(
	capabilityModuleSchema,
	supportClaimStateSchema,
);
export type CapabilityModuleClaims = z.infer<typeof capabilityModuleClaimsSchema>;

// ── Mutation vocabulary these modules contribute ─────────────────────────────
/**
 * SMS is deliberately ABSENT: CeraUI's SMS surface is permanently read-only
 * (list + read, never send/delete), enforced by its own grep gate. A module with
 * no mutation kind cannot be routed through the journaled mutation helper at all,
 * which makes that policy structural rather than a convention.
 */
export const MUTATING_CAPABILITY_MODULES = [
	'band-lock',
	'five-g-pref',
	'fcc-auto-unlock',
	'gps',
	'ussd',
	'esim',
] as const satisfies readonly CapabilityModule[];
export type MutatingCapabilityModule = (typeof MUTATING_CAPABILITY_MODULES)[number];

/** Spread into `modemMutationKindSchema` — one journal kind per mutating module. */
export const CAPABILITY_MODULE_MUTATION_KINDS = [
	'band-lock',
	'five-g-pref',
	'fcc-unlock',
	'gps',
	'ussd',
	'esim',
] as const;

export const CAPABILITY_MODULE_MUTATION_KIND = {
	'band-lock': 'band-lock',
	'five-g-pref': 'five-g-pref',
	'fcc-auto-unlock': 'fcc-unlock',
	gps: 'gps',
	ussd: 'ussd',
	esim: 'esim',
} as const satisfies Record<
	MutatingCapabilityModule,
	(typeof CAPABILITY_MODULE_MUTATION_KINDS)[number]
>;

/**
 * Which modules arm a DURABLE journal entry (pre-state persisted before the call,
 * crash-surviving rollback) rather than taking the lease alone. The split is
 * exactly "can this cost the bond link": a band lock, a 5G preference, an FCC
 * unlock and an eSIM profile switch all re-register the radio; a GPS toggle and a
 * USSD session do not.
 */
export const JOURNALED_CAPABILITY_MODULES = [
	'band-lock',
	'five-g-pref',
	'fcc-auto-unlock',
	'esim',
] as const satisfies readonly MutatingCapabilityModule[];
export type JournaledCapabilityModule = (typeof JOURNALED_CAPABILITY_MODULES)[number];
export type LeaseOnlyCapabilityModule = Exclude<
	MutatingCapabilityModule,
	JournaledCapabilityModule
>;

export function isJournaledCapabilityModule(
	module: MutatingCapabilityModule,
): module is JournaledCapabilityModule {
	return (JOURNALED_CAPABILITY_MODULES as readonly MutatingCapabilityModule[]).includes(module);
}

/**
 * Spread into `modemMutationRefusalSchema`. Two distinct operator facts:
 *   module_disabled    — the gate is OFF; turning it on is the fix.
 *   module_unavailable — this build or this modem cannot do it, OR its capability
 *                        could not be proven. The unproven case fails CLOSED into
 *                        this refusal on purpose: a mutation nobody can show the
 *                        hardware supports must not be dispatched at it.
 * Collapsing them would tell an operator to change a setting that will not help,
 * or leave them hunting for a setting that does not exist.
 */
export const CAPABILITY_MODULE_MUTATION_REFUSALS = [
	'module_disabled',
	'module_unavailable',
] as const;

/**
 * Config key per module, under the `modem_capabilities` runtime-config object.
 * The mapping is explicit rather than derived from the module id: the ids are a
 * wire vocabulary and the config keys are a persisted one, and letting a rename
 * of either silently re-point a persisted gate is not a saving worth making.
 */
export const CAPABILITY_MODULE_CONFIG_KEY = {
	'band-lock': 'band_lock',
	sms: 'sms',
	'five-g-pref': 'five_g_pref',
	'fcc-auto-unlock': 'fcc_auto_unlock',
	gps: 'gps',
	ussd: 'ussd',
	esim: 'esim',
} as const satisfies Record<CapabilityModule, string>;

export type CapabilityModuleConfigKey =
	(typeof CAPABILITY_MODULE_CONFIG_KEY)[keyof typeof CAPABILITY_MODULE_CONFIG_KEY];

/**
 * The persisted gates, under runtime config `modem_capabilities`.
 *
 * Every field is DEFAULT-ABSENT with NO entry in `RUNTIME_CONFIG_DEFAULTS`, the
 * `modem_provisioning` precedent: absent and `false` are equally inert, so a
 * module is unreachable until an operator deliberately opts in on that device.
 */
export const modemCapabilityGatesSchema = z.object({
	band_lock: z.boolean().optional(),
	sms: z.boolean().optional(),
	five_g_pref: z.boolean().optional(),
	fcc_auto_unlock: z.boolean().optional(),
	gps: z.boolean().optional(),
	ussd: z.boolean().optional(),
	esim: z.boolean().optional(),
});
export type ModemCapabilityGates = z.infer<typeof modemCapabilityGatesSchema>;

export function isCapabilityGateEnabled(
	gates: ModemCapabilityGates | undefined,
	module: CapabilityModule,
): boolean {
	return gates?.[CAPABILITY_MODULE_CONFIG_KEY[module]] === true;
}

export function readCapabilityGates(
	gates: ModemCapabilityGates | undefined,
): Record<CapabilityModule, boolean> {
	const resolved = {} as Record<CapabilityModule, boolean>;
	for (const module of CAPABILITY_MODULES) {
		resolved[module] = isCapabilityGateEnabled(gates, module);
	}
	return resolved;
}

// ── The operator's WRITE surface for those gates ─────────────────────────────
/**
 * The gates as a TOTAL record — every module, explicitly, never a sparse object.
 *
 * Same reason `capabilityModuleClaimsSchema` is total: the persisted shape is
 * DEFAULT-ABSENT, so an omitted key and a `false` mean the same thing on disk but
 * are indistinguishable from a LOWERED key on any consumer that merges. A wire
 * answer that states every module cannot be misread.
 */
export const capabilityGateStatesSchema = z.record(capabilityModuleSchema, z.boolean());
export type CapabilityGateStates = z.infer<typeof capabilityGateStatesSchema>;

/**
 * Output for `modems.getCapabilities` — what the operator has turned on, PLUS
 * what this build actually ships.
 *
 * `implemented` is on the wire because the render rule needs it and cannot
 * derive it: a module resolving `unavailable` on every attached modem is either
 * unimplemented in this build OR positively absent on all of that hardware, and
 * those are different facts with different honest renderings. It is also the only
 * answer available on a device with no modem attached at all.
 */
export const modemCapabilitiesOutputSchema = z.object({
	gates: capabilityGateStatesSchema,
	implemented: z.array(capabilityModuleSchema),
});
export type ModemCapabilitiesOutput = z.infer<typeof modemCapabilitiesOutputSchema>;

/**
 * Input for `modems.setCapabilities` — ONE module per call.
 *
 * The mirror of `network.setIngestEnabled({protocol, enabled})`, and for the same
 * reason: a whole-object write races itself when two toggles are in flight, and
 * the second writer silently restores the first's previous value. `.strict()`
 * because an unknown extra key on a gate that arms radio-mutating controls must
 * be REJECTED rather than ignored.
 */
export const setModemCapabilityInputSchema = z
	.object({
		module: capabilityModuleSchema,
		enabled: z.boolean(),
	})
	.strict();
export type SetModemCapabilityInput = z.infer<typeof setModemCapabilityInputSchema>;

/**
 * Why a gate write was refused.
 *
 * `module_not_implemented` is the only member, and it is fail-CLOSED on purpose:
 * persisting a gate for a module this build does not ship writes a key nothing
 * reads, so the operator would be looking at a switch that can never do anything.
 * Refusing is what keeps "the gate is on" and "a control may appear" the same
 * statement.
 */
export const setModemCapabilityRefusalSchema = z.enum(['module_not_implemented']);
export type SetModemCapabilityRefusal = z.infer<typeof setModemCapabilityRefusalSchema>;

/**
 * Output for `modems.setCapabilities`. `applied` is the FULL post-write gate
 * record, never the request — the applied-state convention every setter follows,
 * so a UI locks its switch to what the device persisted.
 */
export const setModemCapabilityOutputSchema = z.object({
	success: z.boolean(),
	applied: capabilityGateStatesSchema.optional(),
	error: setModemCapabilityRefusalSchema.optional(),
});
export type SetModemCapabilityOutput = z.infer<typeof setModemCapabilityOutputSchema>;
