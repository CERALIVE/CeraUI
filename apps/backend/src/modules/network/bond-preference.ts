import { getConfig, saveConfig } from "../config.ts";
import {
	listPresentPhysicalDevices,
	type PhysicalBondKeys,
} from "../modems/physical-identity.ts";
import {
	peekBondKeys,
	resolveBondPhysicalIdentity,
} from "../streaming/bond-entry.ts";

type Preferences = Pick<
	ReturnType<typeof getConfig>,
	"bond_opt_out" | "bond_legacy_out" | "bond_pair_vid" | "bond_connector_choice"
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
	const choice =
		connector === undefined
			? undefined
			: stored.bond_connector_choice?.[connector];
	if (choice === undefined || keys.vid !== choice.vid) return undefined;
	if (!choice.enabled) return choice;
	const group = keys.sharedSerial ? keys.legacyLinkId : undefined;
	return choice.group === undefined ||
		group === undefined ||
		choice.group === group
		? choice
		: undefined;
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
	const present = listPresentPhysicalDevices();
	for (const peer of [keys, ...present]) {
		if (
			peer.legacyLinkId !== undefined &&
			peer.vid !== undefined &&
			(out[peer.legacyLinkId] || defaults[peer.legacyLinkId])
		)
			pairVids[peer.legacyLinkId] = peer.vid;
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
			delete out[previous.legacyExact];
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
				delete out[legacyExact];
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
			bond_connector_choice: {
				...prefs.bond_connector_choice,
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
	if (
		pair !== undefined &&
		((!off && (out[pair] || defaults[pair])) ||
			(off && hasLegacyAlias && out[pair] && !defaults[pair]))
	) {
		// A controller without connector identity keeps main's pair migration.
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
		delete out[exact];
		delete defaults[exact];
		delete pairVids[exact];
	}
	const choices = { ...prefs.bond_connector_choice };
	if (
		!off &&
		connector !== undefined &&
		previous?.enabled === false &&
		previous.vid === vid
	) {
		delete choices[connector];
		if (previous.legacyExact !== undefined) delete out[previous.legacyExact];
	}
	return {
		bond_opt_out: nonEmpty(out),
		bond_legacy_out: nonEmpty(defaults),
		bond_pair_vid: nonEmpty(pairVids),
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
	const next = {
		...stored,
		...transition(stored, identity, { off: true, hasLegacyAlias }),
	};
	const knownPairs = Object.entries(stored.bond_pair_vid ?? {}).filter(
		([key]) =>
			stored.bond_opt_out?.[key] === true ||
			stored.bond_legacy_out?.[key] === true,
	);
	const knownPairVids = new Set(knownPairs.map(([, vid]) => vid));
	const possiblyUnclassifiedPair =
		(stored.usb_serial_shared?.length ?? 0) > knownPairs.length &&
		Object.keys(stored.bond_opt_out ?? {}).some(
			(key) => stored.bond_pair_vid?.[key] === undefined,
		);
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
		if (!after || peer?.vid === undefined || peer.anchor === "usb-serial")
			return false;
		return (
			(knownPairVids.has(peer.vid) ||
				(peer.connectorLinkId !== undefined && possiblyUnclassifiedPair)) &&
			peer.sharedSerial !== true &&
			choiceFor(peer, next)?.enabled !== true
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
	config.bond_connector_choice = undefined;
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
