import { getConfig, saveConfig } from "../config.ts";
import {
	listPresentPhysicalDevices,
	mintLinkId,
	type PhysicalDeviceRecord,
	portIdentityKey,
} from "../modems/physical-identity.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";

const sessionOptOut = new Set<string>();

function serialGroupId(identity: PhysicalDeviceRecord): string | undefined {
	return identity.anchor === "usb-serial"
		? identity.linkId
		: identity.legacyLinkId;
}

function enableExceptionId(identity: PhysicalDeviceRecord): string {
	// Keep the exception on the same port when a serial identity splits.
	return identity.anchor === "usb-serial" && identity.stableKey !== undefined
		? mintLinkId(portIdentityKey(identity.stableKey))
		: identity.linkId;
}

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;
	return identity.linkId;
}

export function isBondOptedOut(ifname: string): boolean {
	if (sessionOptOut.has(ifname)) return true;
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return false;
	const config = getConfig();
	if (config.bond_opt_out?.[identity.linkId] === true) return true;
	const legacy = serialGroupId(identity);
	if (legacy === undefined) return false;
	const enabledLinks = config.bond_legacy_opt_out?.[legacy];
	if (config.bond_opt_out?.[legacy] === true) return true;
	if (enabledLinks === undefined) return false;
	const exceptionId = enableExceptionId(identity);
	return (
		config.bond_opt_out?.[exceptionId] === true ||
		enabledLinks[exceptionId] !== true
	);
}

export function setPersistentBondOptOut(
	ifname: string,
	optOut: boolean,
): string | undefined {
	if (optOut) sessionOptOut.add(ifname);
	else sessionOptOut.delete(ifname);
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
		(legacy !== physicalId || !optOut || enabledLinks !== undefined);
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
		const exceptionId = enableExceptionId(identity);
		const exceptions = { ...enabledLinks };
		if (optOut) delete exceptions[exceptionId];
		else exceptions[exceptionId] = true;
		delete next[exceptionId];
		delete next[physicalId];
		config.bond_legacy_opt_out = {
			...config.bond_legacy_opt_out,
			[legacy]: exceptions,
		};
	} else if (optOut) {
		next[physicalId] = true;
	} else {
		delete next[physicalId];
	}
	config.bond_opt_out = Object.keys(next).length === 0 ? undefined : next;
	saveConfig();
	return physicalId;
}

export function resetPersistentBondOptOutForTest(): void {
	sessionOptOut.clear();
	const config = getConfig();
	config.bond_opt_out = undefined;
	config.bond_legacy_opt_out = undefined;
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
