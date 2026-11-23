import { getConfig, saveConfig } from "../config.ts";
import { listPresentPhysicalDevices } from "../modems/physical-identity.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";

const sessionOptOut = new Set<string>();

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;
	return identity.linkId;
}

/**
 * Read-only view of the exclusion change a disable would make. A stable key
 * can exclude multiple live rows; deleting a legacy key can also admit a row
 * whose exclusion is not migrated to an observed exact identity.
 */
export function previewBondOptOut(target: string) {
	const identity = resolveBondPhysicalIdentity(target, "preview");
	const exact = identity?.anchor === "ifname" ? undefined : identity?.linkId;
	const legacy = exact === undefined ? undefined : identity?.legacyLinkId;
	const stored = getConfig().bond_opt_out;
	const migrated = new Set(
		legacy !== undefined && stored?.[legacy] === true
			? listPresentPhysicalDevices()
					.filter(
						(row) => row.anchor !== "ifname" && row.legacyLinkId === legacy,
					)
					.map((row) => row.linkId)
			: [],
	);
	return (name: string, phase: "before" | "after") => {
		if (sessionOptOut.has(name) || (phase === "after" && name === target))
			return true;
		const peer = resolveBondPhysicalIdentity(name, "preview");
		if (peer === undefined || peer.anchor === "ifname") return false;
		const excluded = (key: string) =>
			phase === "before"
				? stored?.[key] === true
				: key !== legacy &&
					(key === exact || migrated.has(key) || stored?.[key] === true);
		return (
			excluded(peer.linkId) ||
			(peer.legacyLinkId !== undefined && excluded(peer.legacyLinkId))
		);
	};
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

	const next = { ...getConfig().bond_opt_out };
	const identity = resolveBondPhysicalIdentity(ifname);
	const legacy = identity?.legacyLinkId;
	if (legacy !== undefined && next[legacy] === true) {
		for (const present of listPresentPhysicalDevices()) {
			if (present.legacyLinkId === legacy && present.anchor !== "ifname") {
				next[present.linkId] = true;
			}
		}
	}
	if (optOut) next[physicalId] = true;
	else delete next[physicalId];
	if (legacy !== undefined) delete next[legacy];
	getConfig().bond_opt_out = Object.keys(next).length === 0 ? undefined : next;
	saveConfig();
	return physicalId;
}

export function resetPersistentBondOptOutForTest(): void {
	sessionOptOut.clear();
	getConfig().bond_opt_out = undefined;
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
