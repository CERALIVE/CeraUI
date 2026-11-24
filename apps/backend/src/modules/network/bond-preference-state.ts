import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import {
	type PhysicalBondKeys,
	portLinkId,
} from "../modems/physical-identity.ts";

type ExactOptOut = NonNullable<RuntimeConfig["bond_opt_out"]>;
type PortOptIn = NonNullable<RuntimeConfig["bond_opt_in"]>;
type PortOptOut = NonNullable<RuntimeConfig["bond_port_out"]>;

export type BondPreferences = {
	readonly out: ExactOptOut | undefined;
	readonly groupOut: ExactOptOut | undefined;
	readonly optIn: PortOptIn | undefined;
	readonly portOut: PortOptOut | undefined;
};

const portOf = (keys: PhysicalBondKeys) =>
	keys.anchor === "id-path" ? keys.linkId : portLinkId(keys.idPath);

function portChoice(preferences: BondPreferences, keys: PhysicalBondKeys) {
	return keys.anchor === "id-path"
		? preferences.optIn?.[keys.linkId]?.[keys.vid ?? ""]
		: undefined;
}

/** A lone placeholder is not evidence for a retained pair exclusion. */
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
				(peer.vid ?? "") === (keys.vid ?? ""),
		)
	);
}

function hasExactOut(identity: PhysicalBondKeys, preferences: BondPreferences) {
	const { linkId } = identity;
	if (preferences.out?.[linkId] !== true) return false;
	if (identity.anchor !== "id-path") return true;
	// A vendor-owned bit must not exclude another vendor at an aliased path.
	return !hasScopedExact(preferences, linkId);
}

function hasScopedExact(preferences: BondPreferences, port: string) {
	return (
		Object.values(preferences.portOut?.[port] ?? {}).some(
			(record) => record.exact,
		) ||
		Object.values(preferences.optIn?.[port] ?? {}).some((record) => record.pin)
	);
}

export function hasStoredOptOut(
	identity: PhysicalBondKeys | undefined,
	preferences: BondPreferences,
	present: readonly PhysicalBondKeys[],
): boolean {
	if (identity === undefined || identity.anchor === "ifname") return false;
	const port = portOf(identity);
	if (port !== undefined && preferences.portOut?.[port]?.[identity.vid ?? ""])
		return true;
	if (hasExactOut(identity, preferences)) return true;
	if (portChoice(preferences, identity) !== undefined) return false;
	const legacy = identity.legacyLinkId;
	if (legacy === undefined) return false;
	return (
		preferences.out?.[legacy] === true ||
		(preferences.groupOut?.[legacy] === true &&
			hasTwinEvidence(identity, present))
	);
}

/** Main's unchanged projection, before any rollback-only path additions. */
export function exactOptOut(
	stored: BondPreferences,
	target: PhysicalBondKeys,
	change: {
		readonly optOut: boolean;
		readonly present: readonly PhysicalBondKeys[];
	},
): ExactOptOut {
	const next = { ...stored.out };
	const legacy = target.legacyLinkId;
	if (legacy !== undefined && next[legacy] === true) {
		for (const present of change.present) {
			if (present.legacyLinkId === legacy && present.anchor !== "ifname") {
				next[present.linkId] = true;
			}
		}
	}
	if (change.optOut) next[target.linkId] = true;
	else delete next[target.linkId];
	// Legacy deletion wins even when both identities use the same key.
	if (legacy !== undefined) delete next[legacy];
	return next;
}

export const presentOrUndefined = <T extends object>(value: T | undefined) =>
	value !== undefined && Object.keys(value).length > 0 ? value : undefined;

export function transition(
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
			// An exact bit derived for a port with an explicit ON does not win.
			if (
				peer.legacyLinkId === legacy &&
				portChoice(stored, peer) !== undefined &&
				stored.out?.[peer.linkId] !== true &&
				out[peer.linkId] === true
			) {
				optIn[peer.linkId] = {
					...optIn[peer.linkId],
					[peer.vid ?? ""]: { pin: true },
				};
			}
		}
	}
	const port = portOf(target);
	const vid = target.vid ?? "";
	if (!optOut && target.anchor !== "id-path") delete groupOut[target.linkId];
	if (port !== undefined) {
		const on = { ...optIn[port] };
		const off = { ...portOut[port] };
		const previous = off[vid];
		if (optOut) {
			delete on[vid];
			if (vid) {
				off[vid] = {
					// A new OFF cannot establish who owned a pre-upgrade bit.
					...(out[port] === true &&
						(stored.out?.[port] !== true || hasScopedExact(stored, port)) && {
							exact: true,
						}),
					...((target.anchor === "usb-serial" ||
						previous?.rollback === true) && { rollback: true }),
				};
			}
		} else {
			delete off[vid];
			if (target.anchor === "id-path") on[vid] = {};
			else if (previous?.exact === true) on[vid] = { pin: true };
		}
		if (presentOrUndefined(on)) optIn[port] = on;
		else delete optIn[port];
		if (presentOrUndefined(off)) portOut[port] = off;
		else delete portOut[port];
	}
	for (const [path, records] of Object.entries(portOut)) {
		if (out[path] === true) continue;
		for (const [vendor, record] of Object.entries(records)) {
			if (record.exact === true) {
				const { exact: _exact, ...choice } = record;
				portOut[path] = { ...portOut[path], [vendor]: choice };
			}
		}
	}
	return { out, groupOut, optIn, portOut };
}

export function retireLegacyChoice(
	stored: BondPreferences,
	target: PhysicalBondKeys,
	out: ExactOptOut,
	optOut: boolean,
): BondPreferences {
	const port = portOf(target);
	if (port === undefined) return { ...stored, out };
	const vid = target.vid ?? "";
	const optIn = { ...stored.optIn };
	const portOut = { ...stored.portOut };
	if (optOut && optIn[port]?.[vid]) {
		const choices = { ...optIn[port] };
		delete choices[vid];
		if (presentOrUndefined(choices)) optIn[port] = choices;
		else delete optIn[port];
	} else if (!optOut && portOut[port]?.[vid]) {
		const choices = { ...portOut[port] };
		delete choices[vid];
		if (presentOrUndefined(choices)) portOut[port] = choices;
		else delete portOut[port];
	}
	return { ...stored, out, optIn, portOut };
}

export function rollbackOptOut(next: BondPreferences) {
	const rollback: ExactOptOut = {};
	for (const [path, records] of Object.entries(next.portOut ?? {})) {
		if (
			next.out?.[path] !== true &&
			Object.values(records).some((record) => record.rollback)
		)
			rollback[path] = true;
	}
	return presentOrUndefined(rollback);
}
