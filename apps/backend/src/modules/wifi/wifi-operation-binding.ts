import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import type { BaseWifiInterface } from "./wifi-interfaces.ts";
import {
	type RadioLifetime,
	radioIdentityReaders,
	sameRadioLifetime,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import { projectWifiRadioIncarnation } from "./wifi-radio-publication.ts";
import { type RadioSample, sampleRadio } from "./wifi-radio-read-budget.ts";

export type WifiOperationBinding = {
	readonly row: BaseWifiInterface;
	readonly key: string;
	readonly ifname: string;
	readonly token: string;
	readonly mac: string | undefined;
	readonly lifetime: RadioLifetime;
};

export const wifiOperationChanged = {
	success: false,
	error: "radio-changed",
} as const;

/** Trusted callers bind their own row without borrowing the RPC context. */
export function bindingForRow(
	key: string,
	row: BaseWifiInterface,
): WifiOperationBinding | undefined {
	const { ifname } = row;
	const identity = wifiRadioIdentity.state.rows.get(ifname);
	const token = projectWifiRadioIncarnation(row, identity);
	if (
		getWifiInterfacesByMacAddress()[key] !== row ||
		identity?.classification !== "verified" ||
		identity.degradedReason ||
		!identity.lifetime ||
		token === undefined
	)
		return undefined;
	return {
		row,
		key,
		ifname,
		token,
		mac: identity.permanentMac,
		lifetime: identity.lifetime,
	};
}

export function ownsWifiOperation(binding: WifiOperationBinding): boolean {
	const current = wifiRadioIdentity.state.rows.get(binding.ifname);
	return (
		getWifiInterfacesByMacAddress()[binding.key] === binding.row &&
		binding.row.ifname === binding.ifname &&
		binding.row.degradedReason !== "permanent-mac-unresolved" &&
		current?.row === binding.row &&
		current.classification === "verified" &&
		!current.degradedReason &&
		current.incarnation === binding.token &&
		current.permanentMac === binding.mac &&
		sameRadioLifetime(current.lifetime, binding.lifetime)
	);
}

export async function sampleWifiOperationRadio(
	ifname: string,
): Promise<RadioSample | undefined> {
	const controller = new AbortController();
	const expired = Promise.withResolvers<undefined>();
	const timeout = setTimeout(() => {
		controller.abort();
		expired.resolve(undefined);
	}, 2000);
	try {
		const { readText, realpath } = radioIdentityReaders;
		return await Promise.race([
			sampleRadio(ifname, { readText, realpath }, controller.signal),
			expired.promise,
		]);
	} finally {
		clearTimeout(timeout);
		controller.abort();
	}
}

export function matchesWifiOperationRadio(
	binding: WifiOperationBinding,
	sample: RadioSample | undefined,
): boolean {
	return (
		sample !== undefined &&
		sameRadioLifetime(binding.lifetime, sample.lifetime) &&
		(sample.macReadFailed || sample.permanentMac === binding.mac) &&
		ownsWifiOperation(binding)
	);
}

/**
 * A refusal is sticky: later reads may not rebind a transaction or allow a retry.
 * Every effect of a bound operation goes through `check`/`permit`. Once a hybrid
 * AP leg is bound, the same proof also covers that leg.
 */
export function wifiOperationGuard(binding: WifiOperationBinding | undefined) {
	let changed = false;
	let legCurrent: (() => Promise<boolean | undefined>) | undefined;
	const current = () => {
		changed ||= binding !== undefined && !ownsWifiOperation(binding);
		return !changed;
	};
	// Unavailable proof denies effects but is not evidence authorizing rollback Down.
	const observe = async () => {
		if (!binding) return "match";
		const parent = await sampleWifiOperationRadio(binding.ifname);
		if (!parent) return "unavailable";
		const leg = legCurrent ? await legCurrent() : true;
		if (leg === undefined) return "unavailable";
		if (
			!leg ||
			!sameRadioLifetime(binding.lifetime, parent.lifetime) ||
			(!parent.macReadFailed && parent.permanentMac !== binding.mac)
		)
			return "replaced";
		return ownsWifiOperation(binding) ? "match" : "unavailable";
	};
	const check = async () => {
		if (binding && current()) changed ||= (await observe()) !== "match";
		return !changed;
	};
	return {
		current,
		refuse: () => {
			changed = true;
			return false;
		},
		get changed() {
			return changed;
		},
		check,
		observe,
		permit: async () => (await check()) && current(),
		bindLeg: (proof: () => Promise<boolean | undefined>) => {
			legCurrent = proof;
		},
	};
}

/** The leg proof for a hybrid Start: the AP leg keeps the lifetime sampled at allocation. */
export function wifiLegLifetimeProof(
	ifname: string,
	lifetime: RadioLifetime,
): () => Promise<boolean | undefined> {
	return async () => {
		const sample = await sampleWifiOperationRadio(ifname);
		return sample && sameRadioLifetime(lifetime, sample.lifetime);
	};
}
