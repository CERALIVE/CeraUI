import { getConfig, saveConfig } from "../config.ts";
import {
	listPresentPhysicalDevices,
	type PhysicalDeviceRecord,
} from "../modems/physical-identity.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";

const sessionOptOut = new Set<string>();

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;
	return identity.linkId;
}

/**
 * The twin group whose saved exclusion covers this device. The exclusion stays
 * saved for every twin, plugged in or not; one twin is admitted only through an
 * exception recorded under that same group.
 */
function excludedGroup(identity: PhysicalDeviceRecord): string | undefined {
	const group = identity.legacyLinkId;
	return group !== undefined && getConfig().bond_opt_out?.[group] === true
		? group
		: undefined;
}

export function isBondOptedOut(ifname: string): boolean {
	if (sessionOptOut.has(ifname)) return true;
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined) return false;
	const group = excludedGroup(identity);
	if (identity.anchor === "ifname") return group !== undefined;
	if (getConfig().bond_opt_out?.[identity.linkId] === true) return true;
	return (
		group !== undefined && getConfig().bond_opt_in?.[identity.linkId] !== group
	);
}

/**
 * An enable that could not be kept apart from the excluded twins sharing its
 * serial: the link has no durable key to hold an exception, or the twins'
 * shared-serial record was evicted and it reads as the group key itself.
 */
export function isBondEnableUnconfirmed(ifname: string): boolean {
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined) return false;
	if (identity.anchor === "ifname")
		return excludedGroup(identity) !== undefined;
	const { bond_opt_out: excluded, bond_opt_in: exceptions } = getConfig();
	return (
		excluded?.[identity.linkId] === true &&
		Object.values(exceptions ?? {}).includes(identity.linkId)
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
	const physicalId = identity.linkId;
	const group = excludedGroup(identity);

	const excluded = { ...getConfig().bond_opt_out };
	// A choice on a group's own key ends every exception granted under it.
	const exceptions = Object.fromEntries(
		Object.entries(getConfig().bond_opt_in ?? {}).filter(
			([, granted]) => granted !== physicalId,
		),
	);
	if (group !== undefined) {
		// Untouched present twins stay out even if their serial later reads empty.
		for (const present of listPresentPhysicalDevices()) {
			if (
				present.legacyLinkId === group &&
				present.anchor !== "ifname" &&
				exceptions[present.linkId] === undefined
			) {
				excluded[present.linkId] = true;
			}
		}
	}
	if (optOut) {
		excluded[physicalId] = true;
		delete exceptions[physicalId];
	} else {
		delete excluded[physicalId];
		if (group !== undefined) exceptions[physicalId] = group;
	}
	getConfig().bond_opt_out =
		Object.keys(excluded).length === 0 ? undefined : excluded;
	getConfig().bond_opt_in =
		Object.keys(exceptions).length === 0 ? undefined : exceptions;
	saveConfig();
	return physicalId;
}

export function resetPersistentBondOptOutForTest(): void {
	sessionOptOut.clear();
	getConfig().bond_opt_out = undefined;
	getConfig().bond_opt_in = undefined;
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
