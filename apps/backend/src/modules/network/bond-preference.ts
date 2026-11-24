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

const vendorOf = (keys: PhysicalBondKeys) =>
	keys.vid?.trim().toLowerCase() ?? "";

const portVendorKey = (port: string, vid: string) => `${port}:${vid}`;

const portOf = (keys: PhysicalBondKeys) =>
	keys.anchor === "id-path" ? keys.linkId : portLinkId(keys.idPath);

const portInRecord = (key: string) => key.split(":", 1)[0] ?? key;

function portExclusion(
	records: PortOptOut | undefined,
	port: string,
	vid: string,
) {
	return (
		records?.[portVendorKey(port, vid)] ??
		(records?.[port]?.vid === vid ? records[port] : undefined)
	);
}

function portChoice(preferences: BondPreferences, keys: PhysicalBondKeys) {
	if (keys.anchor !== "id-path") return undefined;
	const vid = vendorOf(keys);
	const choice =
		preferences.optIn?.[portVendorKey(keys.linkId, vid)] ??
		preferences.optIn?.[keys.linkId];
	return choice?.vid === vid ? choice : undefined;
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
	const port = portOf(identity);
	if (
		port !== undefined &&
		portExclusion(preferences.portOut, port, vendorOf(identity))
	)
		return true;
	if (
		preferences.out?.[identity.linkId] === true &&
		choice?.pin !== true &&
		!(
			identity.anchor === "id-path" &&
			(Object.entries(preferences.portOut ?? {}).some(
				([key, record]) =>
					record.exact === true && portInRecord(key) === identity.linkId,
			) ||
				Object.entries(preferences.optIn ?? {}).some(
					([key, record]) =>
						record.pin === true && portInRecord(key) === identity.linkId,
				))
		)
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
 * Run main's transition without rollback-only bits. The effective reader
 * uses vendor records; the saver appends the bits needed by the old reader.
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
				optIn[portVendorKey(peer.linkId, choice.vid)] = {
					vid: choice.vid,
					pin: true,
				};
		}
	}
	const port = portOf(target);
	const vid = vendorOf(target);
	if (
		port !== undefined &&
		(optOut || target.anchor === "id-path") &&
		optIn[port]?.vid === vid
	)
		delete optIn[port];
	if (optOut) {
		if (port !== undefined) {
			const key = portVendorKey(port, vid);
			delete optIn[key];
			if (vid) {
				const previous = portExclusion(portOut, port, vid);
				if (portOut[port]?.vid === vid) delete portOut[port];
				portOut[key] = {
					vid,
					...(out[port] === true && { exact: true }),
					...((target.anchor === "usb-serial" ||
						previous?.rollback === true) && { rollback: true }),
				};
			}
		}
	} else {
		if (target.anchor !== "id-path") delete groupOut[target.linkId];
		if (port !== undefined) {
			const key = portVendorKey(port, vid);
			const previous = portExclusion(portOut, port, vid);
			if (portOut[port]?.vid === vid) delete portOut[port];
			delete portOut[key];
			if (target.anchor === "id-path") optIn[key] = { vid };
			else if (previous?.exact === true) optIn[key] = { vid, pin: true };
		}
	}
	for (const [key, record] of Object.entries(portOut)) {
		if (record.exact === true && out[portInRecord(key)] !== true) {
			const { exact: _exact, ...choice } = record;
			portOut[key] = choice;
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
		const rollback: ExactOptOut = {};
		for (const [key, record] of Object.entries(next.portOut ?? {})) {
			const port = portInRecord(key);
			if (record.rollback && next.out?.[port] !== true) rollback[port] = true;
		}
		config.bond_opt_out = presentOrUndefined(next.out);
		config.bond_rollback_out = presentOrUndefined(rollback);
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
