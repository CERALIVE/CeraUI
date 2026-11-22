import { logger } from "../../helpers/logger.ts";
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
	const stored = getConfig().bond_opt_out;
	return (
		stored?.[identity.linkId] === true ||
		(identity.legacyLinkId !== undefined &&
			stored?.[identity.legacyLinkId] === true)
	);
}

export function setPersistentBondOptOut(
	ifname: string,
	optOut: boolean,
): string | undefined {
	if (optOut) sessionOptOut.add(ifname);
	else sessionOptOut.delete(ifname);
	const physicalId = bondPhysicalId(ifname);
	if (physicalId === undefined) return undefined;

	const config = getConfig();
	const next = { ...config.bond_opt_out };
	const groups = { ...config.bond_group_opt_out };
	const identity = resolveBondPhysicalIdentity(ifname);
	const legacy = identity?.legacyLinkId;
	if (legacy !== undefined && next[legacy] === true) {
		for (const present of listPresentPhysicalDevices()) {
			if (present.legacyLinkId === legacy && present.anchor !== "ifname") {
				next[present.linkId] = true;
			}
		}
	}
	if (optOut) {
		// The same port may have been enabled under a different serial.
		for (const [group, enabled] of Object.entries(groups)) {
			if (enabled.includes(physicalId)) {
				groups[group] = enabled.filter((id) => id !== physicalId);
			}
		}
	}
	if (
		legacy !== undefined &&
		(next[legacy] === true || Object.hasOwn(groups, legacy))
	) {
		const enabled = groups[legacy] ?? [];
		groups[legacy] = optOut
			? enabled
			: [...new Set([...enabled, physicalId])].sort();
	}
	delete groups[physicalId];
	if (optOut) next[physicalId] = true;
	else delete next[physicalId];
	if (legacy !== undefined) delete next[legacy];
	config.bond_opt_out = Object.keys(next).length === 0 ? undefined : next;
	config.bond_group_opt_out =
		Object.keys(groups).length === 0 ? undefined : groups;
	saveConfig();
	return physicalId;
}

/** Materialize the remaining group exclusion before publishing a USB scan. */
export function excludeResidualGroupMembers(): void {
	try {
		const config = getConfig();
		const groups = config.bond_group_opt_out;
		if (groups === undefined) return;
		let next: typeof config.bond_opt_out;
		for (const {
			legacyLinkId,
			anchor,
			linkId,
		} of listPresentPhysicalDevices()) {
			if (legacyLinkId === undefined || anchor === "ifname") continue;
			const enabled = groups[legacyLinkId];
			if (enabled === undefined || enabled.includes(linkId)) continue;
			if ((next ?? config.bond_opt_out)?.[linkId] === true) continue;
			next ??= { ...config.bond_opt_out };
			next[linkId] = true;
		}
		if (next === undefined) return;
		config.bond_opt_out = next;
		saveConfig();
	} catch (error) {
		logger.warn("bond: could not persist a twin group exclusion", { error });
	}
}

export function resetPersistentBondOptOutForTest(): void {
	sessionOptOut.clear();
	getConfig().bond_opt_out = undefined;
	getConfig().bond_group_opt_out = undefined;
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
