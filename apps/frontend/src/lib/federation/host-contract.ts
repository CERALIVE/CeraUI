import type {
	CapabilitiesMessage,
	ConfigMessage,
	RelayValidateInput,
	RelayValidateOutput,
	StreamingConfigInput,
	StreamingSetConfigOutput,
} from "@ceraui/rpc/schemas";

export const FEDERATION_ABI_VERSION = 1 as const;

export interface FederationHostAdapter {
	setConfig(input: StreamingConfigInput): Promise<StreamingSetConfigOutput>;
	validateRelay(input: RelayValidateInput): Promise<RelayValidateOutput>;
}

export function requireAppliedConfig(result: StreamingSetConfigOutput): void {
	if (!result.success) throw new Error(result.error ?? "config_write_failed");
}

export interface FederationMountOptions {
	readonly host: FederationHostAdapter;
	readonly config?: ConfigMessage;
	/**
	 * The locale the host wants the dialog rendered in.
	 *
	 * ADDITIVE and OPTIONAL, so `federationAbiVersion` stays 1: a host that omits
	 * it gets the base locale, exactly as before. It exists because a federation
	 * bundle carries its OWN copy of the Paraglide runtime — the active locale is
	 * a module-level binding inside the bundle, so a host switching its own locale
	 * cannot reach it and every federated dialog would render English forever.
	 * An unknown code falls back to the base locale rather than throwing.
	 */
	readonly locale?: string;
	/**
	 * The device's engine-capability snapshot, as the host received it.
	 *
	 * ADDITIVE and OPTIONAL, so `federationAbiVersion` stays 1 — the same shape
	 * (and the same reason) as `locale` above: a host that omits it gets exactly
	 * the pre-existing behaviour. It exists because a federated bundle never runs
	 * `initSubscriptions()`, so every capability-gated control inside it reads a
	 * permanently `undefined` store and renders its honest "the engine stated
	 * nothing" state forever. Passing the snapshot the host already holds is what
	 * makes those controls truthful in a hosted mount.
	 *
	 * It is READ-ONLY evidence: a dialog may only ever narrow what it offers with
	 * it, never widen. A host that cannot supply one is not degraded — it simply
	 * gets the offering a device with no stated capability gets.
	 */
	readonly capabilities?: CapabilitiesMessage;
}

export interface FederationMountHandle {
	destroy(): Promise<void>;
}
