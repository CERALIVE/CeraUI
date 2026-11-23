import { getConfig, saveConfig } from "../config.ts";
import {
	listPresentPhysicalDevices,
	type PhysicalBondKeys,
} from "../modems/physical-identity.ts";
import { peekBondKeys } from "../streaming/bond-entry.ts";

type Preferences = Pick<
	ReturnType<typeof getConfig>,
	"bond_opt_out" | "bond_legacy_out" | "bond_connector_choice"
>;
type Bits = NonNullable<Preferences["bond_opt_out"]>;
const sessionOptOut = new Set<string>();

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = peekBondKeys(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;
	return identity.linkId;
}

function choiceFor(keys: PhysicalBondKeys, stored: Preferences) {
	const connector = keys.connectorLinkId;
	const choice =
		connector === undefined
			? undefined
			: stored.bond_connector_choice?.[connector];
	if (choice?.enabled !== true) return choice;
	const group = keys.sharedSerial ? keys.legacyLinkId : undefined;
	return keys.vid === choice.vid &&
		(choice.group === undefined ||
			group === undefined ||
			choice.group === group)
		? choice
		: undefined;
}

function storedOut(
	keys: PhysicalBondKeys | undefined,
	prefs: Preferences,
): boolean {
	if (keys === undefined) return false;
	const choice = choiceFor(keys, prefs);
	if (choice !== undefined) return !choice.enabled;
	if (keys.anchor === "ifname") return false;
	const excluded = (key: string) =>
		prefs.bond_opt_out?.[key] === true || prefs.bond_legacy_out?.[key] === true;
	return (
		excluded(keys.linkId) ||
		(keys.legacyLinkId !== undefined && excluded(keys.legacyLinkId))
	);
}

function nonEmpty<T extends object>(value: T): T | undefined {
	return Object.keys(value).length > 0 ? value : undefined;
}

function transition(
	prefs: Preferences,
	keys: PhysicalBondKeys | undefined,
	off: boolean,
	hasLegacyAlias: boolean,
): Preferences | undefined {
	if (keys === undefined) return undefined;
	const connector = keys.connectorLinkId;
	const vid = keys.vid;
	if (
		connector !== undefined &&
		vid !== undefined &&
		(keys.anchor !== "usb-serial" ||
			prefs.bond_connector_choice?.[connector] !== undefined)
	) {
		const group = keys.sharedSerial ? keys.legacyLinkId : undefined;
		const legacy = { ...prefs.bond_legacy_out, ...prefs.bond_opt_out };
		// Opaque old keys can hit a later occupant or relabel; keep them only in the new reader.
		return {
			bond_opt_out: undefined,
			bond_legacy_out: nonEmpty(legacy),
			bond_connector_choice: {
				...prefs.bond_connector_choice,
				[connector]: off
					? { enabled: false }
					: {
							enabled: true,
							vid,
							...(group !== undefined ? { group } : {}),
						},
			},
		};
	}
	if (keys.anchor === "ifname") return undefined;
	const protectRollback = prefs.bond_connector_choice !== undefined;
	const out: Bits = protectRollback
		? { ...prefs.bond_legacy_out, ...prefs.bond_opt_out }
		: { ...prefs.bond_opt_out };
	const pair = keys.legacyLinkId;
	if (
		off &&
		hasLegacyAlias &&
		pair !== undefined &&
		prefs.bond_opt_out?.[pair] &&
		prefs.bond_legacy_out?.[pair] !== true
	) {
		// Only the legacy alias OFF keeps main's observed-member migration.
		for (const peer of listPresentPhysicalDevices()) {
			if (peer.legacyLinkId === pair && peer.anchor !== "ifname")
				out[peer.linkId] = true;
		}
		delete out[pair];
	}
	if (off) out[keys.linkId] = true;
	else delete out[keys.linkId];
	return protectRollback
		? { bond_opt_out: undefined, bond_legacy_out: nonEmpty(out) }
		: { bond_opt_out: nonEmpty(out) };
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
		...transition(stored, identity, true, hasLegacyAlias),
	};
	const hasExclusion =
		Object.keys(stored.bond_opt_out ?? {}).length > 0 ||
		Object.keys(stored.bond_legacy_out ?? {}).length > 0 ||
		Object.values(stored.bond_connector_choice ?? {}).some(
			({ enabled }) => !enabled,
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
			peer.connectorLinkId === undefined ||
			(hasExclusion &&
				peer.sharedSerial !== true &&
				choiceFor(peer, next)?.enabled !== true)
		);
	};
}

export function isBondOptedOut(ifname: string): boolean {
	const keys = peekBondKeys(ifname);
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
	const keys = peekBondKeys(ifname);
	if (
		keys === undefined ||
		(keys.anchor === "ifname" && keys.connectorLinkId === undefined)
	) {
		if (off) sessionOptOut.add(ifname);
		else sessionOptOut.delete(ifname);
		return undefined;
	}
	const config = getConfig();
	const next = transition(
		config,
		keys,
		off,
		off && hasLegacyBondAlias(ifname, keys, names),
	);
	if (next !== undefined) {
		const previous: Preferences = {
			bond_opt_out: config.bond_opt_out,
			bond_legacy_out: config.bond_legacy_out,
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
		(keys?.connectorLinkId === undefined ||
			next?.bond_connector_choice === undefined)
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
	config.bond_connector_choice = undefined;
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
