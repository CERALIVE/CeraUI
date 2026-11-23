import { getConfig, saveConfig } from "../config.ts";
import {
	listPresentPhysicalDevices,
	type PhysicalBondKeys,
} from "../modems/physical-identity.ts";
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
export function previewBondOptOut(
	target: string,
	identity: PhysicalBondKeys | undefined,
) {
	const stored = getConfig().bond_opt_out;
	const next =
		identity === undefined || identity.anchor === "ifname"
			? stored
			: setExactOptOut(
					migrateLegacyOptOut(
						{ ...stored },
						identity.legacyLinkId,
						listPresentPhysicalDevices(),
					),
					{
						exact: identity.linkId,
						legacy: identity.legacyLinkId,
						optOut: true,
					},
				);
	return (
		name: string,
		peer: PhysicalBondKeys | undefined,
		phase: "before" | "after",
	) => {
		if (sessionOptOut.has(name) || (phase === "after" && name === target))
			return true;
		return hasStoredOptOut(peer, phase === "after" ? next : stored);
	};
}

type ExactOptOut = NonNullable<ReturnType<typeof getConfig>["bond_opt_out"]>;

function hasStoredOptOut(
	identity: PhysicalBondKeys | undefined,
	stored: ExactOptOut | undefined,
): boolean {
	return (
		identity !== undefined &&
		identity.anchor !== "ifname" &&
		(stored?.[identity.linkId] === true ||
			(identity.legacyLinkId !== undefined &&
				stored?.[identity.legacyLinkId] === true))
	);
}

function migrateLegacyOptOut(
	next: ExactOptOut,
	legacy: string | undefined,
	presentDevices: readonly PhysicalBondKeys[],
): ExactOptOut {
	if (legacy !== undefined && next[legacy] === true) {
		for (const present of presentDevices) {
			if (present.legacyLinkId === legacy && present.anchor !== "ifname") {
				next[present.linkId] = true;
			}
		}
	}
	return next;
}

function setExactOptOut(
	next: ExactOptOut,
	{
		exact,
		legacy,
		optOut,
	}: {
		readonly exact: string;
		readonly legacy: string | undefined;
		readonly optOut: boolean;
	},
): ExactOptOut {
	if (optOut) next[exact] = true;
	else delete next[exact];
	if (legacy !== undefined) delete next[legacy];
	return next;
}

export function isBondOptedOut(ifname: string): boolean {
	if (sessionOptOut.has(ifname)) return true;
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return false;
	const stored = getConfig().bond_opt_out;
	return hasStoredOptOut(identity, stored);
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
	migrateLegacyOptOut(next, legacy, listPresentPhysicalDevices());
	setExactOptOut(next, { exact: physicalId, legacy, optOut });
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
