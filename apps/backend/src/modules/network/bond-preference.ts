import { getConfig, saveConfig } from "../config.ts";
import {
	listPresentPhysicalDevices,
	type PhysicalBondKeys,
	portLinkId,
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

type RuntimeConfig = ReturnType<typeof getConfig>;
type ExactOptOut = NonNullable<RuntimeConfig["bond_opt_out"]>;
type PortOptIn = NonNullable<RuntimeConfig["bond_opt_in"]>;
type PortOptOut = NonNullable<RuntimeConfig["bond_port_out"]>;
type BondPreferences = {
	readonly out: ExactOptOut | undefined;
	readonly groupOut: ExactOptOut | undefined;
	readonly optIn: PortOptIn | undefined;
	readonly portOut: PortOptOut | undefined;
};

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

export function hasBondPreferenceOverlay(): boolean {
	const { optIn, groupOut, portOut } = readPreferences();
	return optIn !== undefined || groupOut !== undefined || portOut !== undefined;
}

const vendorOf = (keys: PhysicalBondKeys) =>
	keys.vid?.trim().toLowerCase() ?? "";

function portChoice(preferences: BondPreferences, keys: PhysicalBondKeys) {
	const choice =
		keys.anchor === "id-path" ? preferences.optIn?.[keys.linkId] : undefined;
	return choice?.vid === vendorOf(keys) ? choice : undefined;
}

/**
 * A pair key is twin evidence when the scan confirmed a shared serial, or when
 * another present port of the same brand reports the same placeholder. A lone
 * placeholder reads exactly as main does.
 */
function hasTwinEvidence(
	keys: PhysicalBondKeys,
	present: readonly PhysicalBondKeys[],
): boolean {
	return (
		keys.sharedSerial === true ||
		present.some(
			(peer) =>
				peer.linkId !== keys.linkId &&
				peer.legacyLinkId === keys.legacyLinkId &&
				vendorOf(peer) === vendorOf(keys),
		)
	);
}

function hasStoredOptOut(
	identity: PhysicalBondKeys | undefined,
	preferences: BondPreferences,
	present: readonly PhysicalBondKeys[],
): boolean {
	if (identity === undefined || identity.anchor === "ifname") return false;
	const choice = portChoice(preferences, identity);
	const portOff =
		identity.anchor === "id-path"
			? preferences.portOut?.[identity.linkId]
			: undefined;
	if (portOff?.vid === vendorOf(identity)) return true;
	if (
		preferences.out?.[identity.linkId] === true &&
		choice?.pin !== true &&
		portOff?.exact !== true
	)
		return true;
	if (choice !== undefined) return false;
	const legacy = identity.legacyLinkId;
	if (legacy === undefined) return false;
	return (
		preferences.out?.[legacy] === true ||
		(preferences.groupOut?.[legacy] === true &&
			hasTwinEvidence(identity, present))
	);
}

function exactOptOut(
	stored: BondPreferences,
	target: PhysicalBondKeys,
	change: {
		readonly optOut: boolean;
		readonly present: readonly PhysicalBondKeys[];
	},
): ExactOptOut {
	return transitionExactOptOut(
		stored.out,
		{
			exact: target.linkId,
			legacy: target.legacyLinkId,
			optOut: change.optOut,
		},
		change.present,
	);
}

function transitionExactOptOut(
	stored: ExactOptOut | undefined,
	{
		exact,
		legacy,
		optOut,
	}: {
		readonly exact: string;
		readonly legacy: string | undefined;
		readonly optOut: boolean;
	},
	presentDevices: readonly PhysicalBondKeys[],
): ExactOptOut {
	const next = { ...stored };
	if (legacy !== undefined && next[legacy] === true) {
		for (const present of presentDevices) {
			if (present.legacyLinkId === legacy && present.anchor !== "ifname") {
				next[present.linkId] = true;
			}
		}
	}
	if (optOut) next[exact] = true;
	else delete next[exact];
	// Legacy deletion wins even when both identities use the same key.
	if (legacy !== undefined) delete next[legacy];
	return next;
}

/**
 * `bond_opt_out` is exactly main's transition, so v2026.11.4 reads the bytes it
 * would have written itself. The pair default that transition deletes is kept
 * in `bond_group_out`, and a port-anchored ON is recorded in `bond_opt_in`.
 */
function transition(
	stored: BondPreferences,
	target: PhysicalBondKeys,
	optOut: boolean,
	present: readonly PhysicalBondKeys[],
): BondPreferences {
	const legacy = target.legacyLinkId;
	const out = exactOptOut(stored, target, { optOut, present });
	const groupOut = { ...stored.groupOut };
	const optIn = { ...stored.optIn };
	const portOut = { ...stored.portOut };
	if (legacy !== undefined && stored.out?.[legacy] === true) {
		groupOut[legacy] = true;
		for (const peer of present) {
			const choice = portChoice(stored, peer);
			// A pin main derived for a port that holds an ON yields to that ON here.
			if (
				peer.legacyLinkId === legacy &&
				choice !== undefined &&
				stored.out?.[peer.linkId] !== true &&
				out[peer.linkId] === true
			)
				optIn[peer.linkId] = { vid: choice.vid, pin: true };
		}
	}
	const port =
		target.anchor === "id-path" ? target.linkId : portLinkId(target.idPath);
	const vid = vendorOf(target);
	if (optOut) {
		delete optIn[target.linkId];
		if (port !== undefined) {
			delete optIn[port];
			if (vid) {
				portOut[port] =
					target.anchor === "id-path" || portOut[port]?.exact === true
						? { vid, exact: true }
						: { vid };
			}
		}
	} else if (target.anchor === "id-path") {
		delete portOut[target.linkId];
		optIn[target.linkId] = { vid };
	} else {
		delete groupOut[target.linkId];
		if (port !== undefined && portOut[port]?.vid === vid) {
			if (portOut[port]?.exact === true) optIn[port] = { vid, pin: true };
			delete portOut[port];
		}
	}
	return { out, groupOut, optIn, portOut };
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

const presentOrUndefined = <T extends object>(value: T | undefined) =>
	value !== undefined && Object.keys(value).length > 0 ? value : undefined;

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
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
