import { getConfig, saveConfig } from "../config.ts";
import {
	listPresentPhysicalDevices,
	mintLinkId,
	type PhysicalBondKeys,
} from "../modems/physical-identity.ts";
import {
	peekBondKeys,
	resolveBondPhysicalIdentity,
} from "../streaming/bond-entry.ts";

type Preferences = Pick<
	ReturnType<typeof getConfig>,
	| "bond_opt_out"
	| "bond_legacy_out"
	| "bond_pair_vid"
	| "bond_pair_connector"
	| "bond_connector_choice"
>;
type Bits = NonNullable<Preferences["bond_opt_out"]>;
const sessionOptOut = new Set<string>();

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;
	return identity.linkId;
}

function choiceFor(keys: PhysicalBondKeys, stored: Preferences) {
	const connector = keys.connectorLinkId;
	const member = pairMemberKey(keys);
	const choice =
		connector !== undefined
			? stored.bond_connector_choice?.[connector]
			: member === undefined
				? undefined
				: stored.bond_connector_choice?.[member];
	if (choice === undefined || keys.vid !== choice.vid) return undefined;
	return choice;
}

function pairMemberKey(keys: PhysicalBondKeys): string | undefined {
	if (
		keys.connectorLinkId !== undefined ||
		keys.anchor !== "id-path" ||
		!keys.sharedSerial ||
		keys.legacyLinkId === undefined
	)
		return undefined;
	return mintLinkId(`bond-pair-member:${keys.legacyLinkId}:${keys.linkId}`);
}

function anotherConnectorOwns(
	choices: Preferences["bond_connector_choice"],
	connector: string | undefined,
	exact: string,
): boolean {
	return Object.entries(choices ?? {}).some(
		([owner, choice]) =>
			owner !== connector && !choice.enabled && choice.legacyExact === exact,
	);
}

function storedOut(
	keys: PhysicalBondKeys | undefined,
	prefs: Preferences,
): boolean {
	if (keys === undefined) return false;
	const exactOut =
		prefs.bond_opt_out?.[keys.linkId] === true ||
		prefs.bond_legacy_out?.[keys.linkId] === true;
	if (keys.anchor === "usb-serial" && exactOut) return true;
	const choice = choiceFor(keys, prefs);
	if (choice !== undefined) return !choice.enabled;
	if (keys.anchor === "ifname") return false;
	// A legacy path bit projected from a connector OFF has no authority
	// over a different brand or the connector that inherits its old label.
	const projectedOff =
		exactOut &&
		keys.anchor === "id-path" &&
		Object.values(prefs.bond_connector_choice ?? {}).some(
			(record) => !record.enabled && record.legacyExact === keys.linkId,
		);
	const group = keys.legacyLinkId;
	return (
		(exactOut && !projectedOff) ||
		(group !== undefined &&
			(prefs.bond_opt_out?.[group] === true ||
				prefs.bond_legacy_out?.[group] === true))
	);
}

function nonEmpty<T extends object>(value: T): T | undefined {
	return Object.keys(value).length > 0 ? value : undefined;
}

export function setLegacyBondOptOut(ifname: string, off: boolean): void {
	if (off) sessionOptOut.add(ifname);
	else sessionOptOut.delete(ifname);
	const keys = resolveBondPhysicalIdentity(ifname);
	if (keys === undefined || keys.anchor === "ifname") return;
	const config = getConfig();
	const out = { ...config.bond_opt_out };
	const pair = keys.legacyLinkId;
	if (pair !== undefined && out[pair]) {
		for (const peer of listPresentPhysicalDevices()) {
			if (peer.legacyLinkId === pair && peer.anchor !== "ifname")
				out[peer.linkId] = true;
		}
	}
	if (off) out[keys.linkId] = true;
	else delete out[keys.linkId];
	if (pair !== undefined) delete out[pair];
	config.bond_opt_out = nonEmpty(out);
	saveConfig();
}

function transition(
	prefs: Preferences,
	keys: PhysicalBondKeys | undefined,
	{
		off,
		hasLegacyAlias,
	}: { readonly off: boolean; readonly hasLegacyAlias: boolean },
): Preferences | undefined {
	if (keys === undefined) return undefined;
	const connector = keys.connectorLinkId;
	const vid = keys.vid;
	const exact = keys.linkId;
	const pair = keys.legacyLinkId;
	const previous =
		connector === undefined
			? undefined
			: prefs.bond_connector_choice?.[connector];
	const out: Bits = { ...prefs.bond_opt_out };
	const defaults: Bits = { ...prefs.bond_legacy_out };
	const pairVids = { ...prefs.bond_pair_vid };
	const pairConnectors = { ...prefs.bond_pair_connector };
	const choices = { ...prefs.bond_connector_choice };
	const clearExact = (key: string) => {
		if (!anotherConnectorOwns(choices, connector, key)) delete out[key];
	};
	const present = listPresentPhysicalDevices();
	for (const peer of [keys, ...present]) {
		if (
			peer.legacyLinkId !== undefined &&
			peer.vid !== undefined &&
			(out[peer.legacyLinkId] || defaults[peer.legacyLinkId])
		) {
			pairVids[peer.legacyLinkId] = peer.vid;
			if (peer.connectorLinkId !== undefined && peer.sharedSerial)
				pairConnectors[peer.connectorLinkId] = peer.legacyLinkId;
		}
	}
	if (
		connector !== undefined &&
		vid !== undefined &&
		keys.anchor !== "usb-serial"
	) {
		const group = keys.sharedSerial ? keys.legacyLinkId : undefined;
		const legacyExact = keys.anchor === "ifname" ? undefined : exact;
		if (
			previous?.enabled === false &&
			previous.vid === vid &&
			previous.legacyExact !== undefined
		)
			clearExact(previous.legacyExact);
		if (off) {
			if (legacyExact !== undefined) out[legacyExact] = true;
		} else {
			if (
				legacyExact !== undefined &&
				!(
					previous?.enabled === false &&
					previous.vid !== vid &&
					previous.legacyExact === legacyExact
				)
			)
				clearExact(legacyExact);
			// Only proven pair bits may move; an opaque bit may be an unrelated exact OFF.
			for (const [candidate, owner] of Object.entries(pairVids)) {
				if (
					owner === vid &&
					(group === undefined || candidate === group || candidate === pair) &&
					out[candidate]
				) {
					defaults[candidate] = true;
					delete out[candidate];
				}
			}
		}
		return {
			bond_opt_out: nonEmpty(out),
			bond_legacy_out: nonEmpty(defaults),
			bond_pair_vid: nonEmpty(pairVids),
			bond_pair_connector: nonEmpty(pairConnectors),
			bond_connector_choice: {
				...choices,
				[connector]: off
					? {
							enabled: false,
							vid,
							...(legacyExact !== undefined ? { legacyExact } : {}),
						}
					: {
							enabled: true,
							vid,
							...(group !== undefined ? { group } : {}),
						},
			},
		};
	}
	if (keys.anchor === "ifname") return undefined;
	const member = pairMemberKey(keys);
	if (member !== undefined && vid !== undefined) {
		if (off) delete choices[member];
		else {
			choices[member] = { enabled: true, vid };
			if (pair !== undefined && out[pair]) {
				defaults[pair] = true;
				delete out[pair];
			}
		}
	}
	if (
		pair !== undefined &&
		off &&
		hasLegacyAlias &&
		out[pair] &&
		!defaults[pair]
	) {
		// Keep the existing alias-only OFF migration.
		for (const peer of present) {
			if (
				peer.legacyLinkId === pair &&
				peer.anchor !== "ifname" &&
				choiceFor(peer, prefs)?.enabled !== true
			)
				out[peer.linkId] = true;
		}
		delete out[pair];
		delete defaults[pair];
		delete pairVids[pair];
	}
	if (off) out[exact] = true;
	else {
		clearExact(exact);
		delete defaults[exact];
		delete pairVids[exact];
	}
	if (
		!off &&
		connector !== undefined &&
		previous?.enabled === false &&
		previous.vid === vid
	) {
		delete choices[connector];
		if (previous.legacyExact !== undefined) clearExact(previous.legacyExact);
	}
	return {
		bond_opt_out: nonEmpty(out),
		bond_legacy_out: nonEmpty(defaults),
		bond_pair_vid: nonEmpty(pairVids),
		bond_pair_connector: nonEmpty(pairConnectors),
		bond_connector_choice: nonEmpty(choices),
	};
}

export function hasLegacyBondAlias(
	target: string,
	keys: PhysicalBondKeys | undefined,
	names: Iterable<string>,
	resolve: (name: string) => PhysicalBondKeys | undefined = peekBondKeys,
): boolean {
	if (keys?.legacyLinkId === undefined || keys.connectorLinkId !== undefined)
		return false;
	for (const name of names) {
		if (name === target) continue;
		const peer = resolve(name);
		if (peer?.linkId === keys.linkId && peer.legacyLinkId !== keys.legacyLinkId)
			return true;
	}
	return false;
}

export function previewBondOptOut(
	target: string,
	identity: PhysicalBondKeys | undefined,
	hasLegacyAlias: boolean,
) {
	const stored = getConfig();
	const next =
		transition(stored, identity, { off: true, hasLegacyAlias }) ?? stored;
	return (
		name: string,
		peer: PhysicalBondKeys | undefined,
		phase: "before" | "after",
	) => {
		const after = phase === "after";
		const config = after ? next : stored;
		if (
			(sessionOptOut.has(name) &&
				(peer === undefined || choiceFor(peer, config) === undefined)) ||
			(after && name === target) ||
			storedOut(peer, config)
		)
			return true;
		if (
			!after ||
			peer?.connectorLinkId === undefined ||
			peer.vid === undefined ||
			peer.anchor === "usb-serial" ||
			peer.sharedSerial ||
			choiceFor(peer, next)?.enabled === true
		)
			return false;
		const pair = next.bond_pair_connector?.[peer.connectorLinkId];
		return (
			pair !== undefined &&
			next.bond_pair_vid?.[pair] === peer.vid &&
			(next.bond_opt_out?.[pair] === true ||
				next.bond_legacy_out?.[pair] === true)
		);
	};
}

export function isBondOptedOut(ifname: string): boolean {
	const keys = resolveBondPhysicalIdentity(ifname);
	if (
		keys === undefined ||
		(keys.anchor === "ifname" && keys.connectorLinkId === undefined)
	)
		return sessionOptOut.has(ifname);
	const prefs = getConfig();
	return (
		storedOut(keys, prefs) ||
		(sessionOptOut.has(ifname) && choiceFor(keys, prefs) === undefined)
	);
}

export function setPersistentBondOptOut(
	ifname: string,
	off: boolean,
	names: Iterable<string> = [],
): string | undefined {
	const keys = resolveBondPhysicalIdentity(ifname);
	if (
		keys === undefined ||
		(keys.anchor === "ifname" && keys.connectorLinkId === undefined)
	) {
		if (off) sessionOptOut.add(ifname);
		else sessionOptOut.delete(ifname);
		return undefined;
	}
	const config = getConfig();
	const next = transition(config, keys, {
		off,
		hasLegacyAlias: off && hasLegacyBondAlias(ifname, keys, names),
	});
	if (next !== undefined) {
		const previous: Preferences = {
			bond_opt_out: config.bond_opt_out,
			bond_legacy_out: config.bond_legacy_out,
			bond_pair_vid: config.bond_pair_vid,
			bond_pair_connector: config.bond_pair_connector,
			bond_connector_choice: config.bond_connector_choice,
		};
		Object.assign(config, next);
		try {
			saveConfig();
		} catch (error) {
			Object.assign(config, previous);
			throw error;
		}
	}
	if (
		off &&
		(keys.connectorLinkId === undefined || keys.anchor === "usb-serial")
	)
		sessionOptOut.add(ifname);
	else sessionOptOut.delete(ifname);
	return keys?.anchor === "ifname" ? undefined : keys?.linkId;
}

export function resetPersistentBondOptOutForTest(): void {
	sessionOptOut.clear();
	const config = getConfig();
	config.bond_opt_out = undefined;
	config.bond_legacy_out = undefined;
	config.bond_pair_vid = undefined;
	config.bond_pair_connector = undefined;
	config.bond_connector_choice = undefined;
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
