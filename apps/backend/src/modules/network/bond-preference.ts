import { getConfig, saveConfig } from "../config.ts";
import { listPresentPhysicalDevices } from "../modems/physical-identity.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";

const sessionOptOut = new Set<string>();

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;
	return identity.linkId;
}

export function isBondOptedOut(ifname: string): boolean {
	if (sessionOptOut.has(ifname)) return true;
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return false;
	const config = getConfig();
	if (config.bond_opt_out?.[identity.linkId] === true) return true;
	const legacy = identity.legacyLinkId;
	if (legacy === undefined) return false;
	const enabledLinks = config.bond_legacy_opt_out?.[legacy];
	return (
		config.bond_opt_out?.[legacy] === true ||
		(enabledLinks !== undefined && enabledLinks[identity.linkId] !== true)
	);
}

export function setPersistentBondOptOut(
	ifname: string,
	optOut: boolean,
): string | undefined {
	if (optOut) sessionOptOut.add(ifname);
	else sessionOptOut.delete(ifname);
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;

	const { linkId: physicalId, legacyLinkId: legacy } = identity;
	const config = getConfig();
	const next = { ...config.bond_opt_out };
	if (legacy !== undefined) {
		const enabledLinks = config.bond_legacy_opt_out?.[legacy];
		const migrating = next[legacy] === true;
		if (migrating) {
			for (const present of listPresentPhysicalDevices()) {
				if (present.legacyLinkId === legacy && present.anchor !== "ifname") {
					next[present.linkId] = true;
				}
			}
			delete next[legacy];
		}
		// A scan cannot prove all siblings are plugged in.
		if (migrating || enabledLinks !== undefined) {
			const exceptions = { ...enabledLinks };
			if (optOut) delete exceptions[physicalId];
			else exceptions[physicalId] = true;
			config.bond_legacy_opt_out = {
				...config.bond_legacy_opt_out,
				[legacy]: exceptions,
			};
		}
	}
	if (optOut) next[physicalId] = true;
	else delete next[physicalId];
	config.bond_opt_out = Object.keys(next).length === 0 ? undefined : next;
	saveConfig();
	return physicalId;
}

export function resetPersistentBondOptOutForTest(): void {
	sessionOptOut.clear();
	const config = getConfig();
	config.bond_opt_out = undefined;
	config.bond_legacy_opt_out = undefined;
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
