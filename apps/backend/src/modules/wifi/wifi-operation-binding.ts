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

/** A refusal is sticky: later reads may not rebind a transaction or allow a retry. */
export function wifiOperationGuard(binding: WifiOperationBinding | undefined) {
	let changed = false;
	const current = () => {
		changed ||= binding !== undefined && !ownsWifiOperation(binding);
		return !changed;
	};
	const check = async () => {
		if (!binding || !current()) return !changed;
		changed ||= !matchesWifiOperationRadio(
			binding,
			await sampleWifiOperationRadio(binding.ifname),
		);
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
		permit: async () => (await check()) && current(),
	};
}
