import { getConfig, saveConfig } from "../config.ts";
import {
	listPresentPhysicalDevices,
	type PhysicalBondKeys,
} from "../modems/physical-identity.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";
import {
	type BondPreferences,
	type BondPreferenceView,
	hasStoredOptOut,
	presentOrUndefined,
	projectBondPreferences,
	rollbackOptOut,
	transition,
} from "./bond-preference-state.ts";
import { onNetdevRetired } from "./netdev-lifetime.ts";

const sessionOptOut = new Set<string>();

onNetdevRetired((ifname) => sessionOptOut.delete(ifname));

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = resolveBondPhysicalIdentity(ifname);
	return identity?.anchor === "ifname" ? undefined : identity?.linkId;
}

/** Read-only preview of all admissions affected by the requested OFF. */
export function previewBondOptOut(
	target: string,
	identity: PhysicalBondKeys | undefined,
	view: BondPreferenceView = "effective",
) {
	const source = readPreferences();
	const stored = projectBondPreferences(source, view);
	const present = listPresentPhysicalDevices();
	const next =
		identity === undefined || identity.anchor === "ifname"
			? stored
			: projectBondPreferences(
					transition(source, identity, { optOut: true, present, view }),
					view,
				);
	return (
		name: string,
		peer: PhysicalBondKeys | undefined,
		phase: "before" | "after",
	) => {
		if (sessionOptOut.has(name) || (phase === "after" && name === target))
			return true;
		return hasStoredOptOut(peer, phase === "after" ? next : stored, present);
	};
}

function readPreferences(): BondPreferences {
	const config = getConfig();
	return {
		out: config.bond_opt_out,
		groupOut: config.bond_group_out,
		optIn: config.bond_opt_in,
		portOut: config.bond_port_out,
	};
}

export function isBondOptedOut(
	ifname: string,
	view: BondPreferenceView = "effective",
): boolean {
	if (sessionOptOut.has(ifname)) return true;
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return false;
	return hasStoredOptOut(
		identity,
		projectBondPreferences(readPreferences(), view),
		listPresentPhysicalDevices(),
	);
}

export function setPersistentBondOptOut(
	ifname: string,
	optOut: boolean,
	view: BondPreferenceView = "effective",
): string | undefined {
	if (optOut) sessionOptOut.add(ifname);
	else sessionOptOut.delete(ifname);
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;

	const stored = readPreferences();
	const present = listPresentPhysicalDevices();
	const config = getConfig();
	const next = transition(stored, identity, { optOut, present, view });
	config.bond_opt_out = presentOrUndefined(next.out);
	config.bond_rollback_out = rollbackOptOut(next);
	config.bond_group_out = presentOrUndefined(next.groupOut);
	config.bond_opt_in = presentOrUndefined(next.optIn);
	config.bond_port_out = presentOrUndefined(next.portOut);
	saveConfig();
	return identity.linkId;
}

export function resetPersistentBondOptOutForTest(): void {
	sessionOptOut.clear();
	const config = getConfig();
	config.bond_opt_out = undefined;
	config.bond_group_out = undefined;
	config.bond_opt_in = undefined;
	config.bond_port_out = undefined;
	config.bond_rollback_out = undefined;
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
