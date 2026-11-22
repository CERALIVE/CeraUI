import { getConfig, saveConfig } from "../config.ts";
import {
	listPresentPhysicalDevices,
	mintLinkId,
	type PhysicalDeviceRecord,
	portIdentityKey,
} from "../modems/physical-identity.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";

// The latest toggle per interface name this session (true = opted out). It is
// the only choice an unlocated device can hold.
const sessionChoice = new Map<string, boolean>();

function serialGroupId(identity: PhysicalDeviceRecord): string | undefined {
	return identity.anchor === "usb-serial"
		? identity.linkId
		: identity.legacyLinkId;
}

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;
	return identity.linkId;
}

export function isBondOptedOut(ifname: string): boolean {
	const session = sessionChoice.get(ifname);
	if (session === true) return true;
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined) return false;
	const legacy = serialGroupId(identity);
	const config = getConfig();
	if (identity.anchor === "ifname") {
		// Known group membership excludes an unlocated twin; only this session's
		// toggle can enable it, because it has no durable key.
		if (legacy === undefined || session === false) return false;
		return (
			config.bond_opt_out?.[legacy] === true ||
			config.bond_legacy_opt_out?.[legacy] !== undefined
		);
	}
	if (config.bond_opt_out?.[identity.linkId] === true) return true;
	if (legacy === undefined) return false;
	if (config.bond_opt_out?.[legacy] === true) return true;
	const enabledLinks = config.bond_legacy_opt_out?.[legacy];
	if (enabledLinks === undefined) return false;

	if (identity.anchor === "usb-serial") {
		// While trusted, the serial identifies one device. A port observation
		// scopes its enable after a split; it is not the current read key.
		return Object.keys(enabledLinks).length === 0;
	}
	return (
		config.bond_port_opt_in?.[identity.linkId] !== true &&
		enabledLinks[identity.linkId] !== true
	);
}

export function setPersistentBondOptOut(
	ifname: string,
	optOut: boolean,
): string | undefined {
	sessionChoice.set(ifname, optOut);
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;

	const physicalId = identity.linkId;
	const legacy = serialGroupId(identity);
	const config = getConfig();
	const next = { ...config.bond_opt_out };
	const enabledLinks =
		legacy === undefined ? undefined : config.bond_legacy_opt_out?.[legacy];
	const migrating =
		legacy !== undefined &&
		next[legacy] === true &&
		(legacy !== physicalId || !optOut);
	// Replace the raw entry, but retain its default: a scan cannot see absent twins.
	if (legacy !== undefined && (migrating || enabledLinks !== undefined)) {
		if (migrating) {
			for (const present of listPresentPhysicalDevices()) {
				if (present.legacyLinkId === legacy && present.anchor !== "ifname") {
					next[present.linkId] = true;
				}
			}
			delete next[legacy];
		}

		let exceptions = { ...enabledLinks };
		if (identity.anchor === "usb-serial") {
			if (optOut) exceptions = {};
			else if (identity.stableKey !== undefined) {
				exceptions = {
					[mintLinkId(portIdentityKey(identity.stableKey))]: true,
				};
			} else if (Object.keys(exceptions).length === 0) {
				// A serial-only enable stops applying once that serial splits.
				exceptions[legacy] = true;
			}
		} else {
			if (optOut) delete exceptions[physicalId];
			else exceptions[physicalId] = true;
		}
		config.bond_legacy_opt_out = {
			...config.bond_legacy_opt_out,
			[legacy]: exceptions,
		};
	}
	if (identity.anchor === "id-path") {
		// Without serial evidence the port is the only key an enable can keep;
		// a group recognized here later must not override it.
		const portEnables = { ...config.bond_port_opt_in };
		if (optOut || legacy !== undefined) delete portEnables[physicalId];
		else portEnables[physicalId] = true;
		config.bond_port_opt_in =
			Object.keys(portEnables).length === 0 ? undefined : portEnables;
	}
	if (optOut) next[physicalId] = true;
	else delete next[physicalId];
	config.bond_opt_out = Object.keys(next).length === 0 ? undefined : next;
	saveConfig();
	return physicalId;
}

export function resetPersistentBondOptOutForTest(): void {
	sessionChoice.clear();
	const config = getConfig();
	config.bond_opt_out = undefined;
	config.bond_legacy_opt_out = undefined;
	config.bond_port_opt_in = undefined;
}

export function resetSessionBondOptOutForTest(): void {
	sessionChoice.clear();
}
