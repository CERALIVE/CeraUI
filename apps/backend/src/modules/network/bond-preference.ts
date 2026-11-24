import { getConfig, saveConfig } from "../config.ts";
import {
	listPresentPhysicalDevices,
	type PhysicalBondKeys,
} from "../modems/physical-identity.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";
import {
	type BondPreferences,
	exactOptOut,
	hasStoredOptOut,
	presentOrUndefined,
	rollbackOptOut,
	transition,
} from "./bond-preference-state.ts";

const sessionOptOut = new Set<string>();

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = resolveBondPhysicalIdentity(ifname);
	return identity?.anchor === "ifname" ? undefined : identity?.linkId;
}

/** Read-only preview of all admissions affected by the requested OFF. */
export function previewBondOptOut(
	target: string,
	identity: PhysicalBondKeys | undefined,
	view: "effective" | "legacy" = "effective",
) {
	const stored = readPreferences(view);
	const present = listPresentPhysicalDevices();
	const next =
		identity === undefined || identity.anchor === "ifname"
			? stored
			: view === "effective"
				? transition(stored, identity, true, present)
				: {
						...stored,
						out: exactOptOut(stored, identity, { optOut: true, present }),
					};
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

function readPreferences(
	view: "effective" | "legacy" = "effective",
): BondPreferences {
	const config = getConfig();
	return {
		out: config.bond_opt_out,
		groupOut: view === "effective" ? config.bond_group_out : undefined,
		optIn: view === "effective" ? config.bond_opt_in : undefined,
		portOut: view === "effective" ? config.bond_port_out : undefined,
	};
}

export function isBondOptedOut(ifname: string): boolean {
	if (sessionOptOut.has(ifname)) return true;
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return false;
	return hasStoredOptOut(
		identity,
		readPreferences(),
		listPresentPhysicalDevices(),
	);
}

export function setPersistentBondOptOut(
	ifname: string,
	optOut: boolean,
	mode: "effective" | "legacy" = "effective",
): string | undefined {
	if (optOut) sessionOptOut.add(ifname);
	else sessionOptOut.delete(ifname);
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;

	const stored = readPreferences(mode);
	const present = listPresentPhysicalDevices();
	const config = getConfig();
	if (mode === "legacy") {
		config.bond_opt_out = presentOrUndefined(
			exactOptOut(stored, identity, { optOut, present }),
		);
	} else {
		const next = transition(stored, identity, optOut, present);
		config.bond_opt_out = presentOrUndefined(next.out);
		config.bond_rollback_out = rollbackOptOut(next);
		config.bond_group_out = presentOrUndefined(next.groupOut);
		config.bond_opt_in = presentOrUndefined(next.optIn);
		config.bond_port_out = presentOrUndefined(next.portOut);
	}
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
