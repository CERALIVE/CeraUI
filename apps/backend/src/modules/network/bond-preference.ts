import {
	getConfig,
	isRuntimeConfigAvailable,
	saveConfig,
	saveConfigInBackground,
} from "../config.ts";
import { listPresentPhysicalDevices } from "../modems/physical-identity.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";
import { getUsbPhysicalDescriptor } from "./usb-physical-descriptors.ts";

const sessionOptOut = new Set<string>();

export function bondPhysicalId(ifname: string): string | undefined {
	const identity = resolveBondPhysicalIdentity(ifname);
	if (identity === undefined || identity.anchor === "ifname") return undefined;
	return identity.linkId;
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

type GroupEntries = NonNullable<
	ReturnType<typeof getConfig>["bond_group_opt_out"]
>;
type Pin = Exclude<GroupEntries[string], string | string[]>;

function pinObservation(ifname: string) {
	const descriptor = getUsbPhysicalDescriptor(ifname);
	return descriptor === undefined
		? undefined
		: {
				sku: `${descriptor.vid}:${descriptor.pid}`,
				manufacturer: descriptor.pinManufacturer,
				product: descriptor.pinProduct,
			};
}

function matchesPin(
	pin: Pin | string,
	observed: ReturnType<typeof pinObservation>,
): boolean {
	if (observed === undefined) return false;
	if (typeof pin === "string") return pin === observed.sku;
	// A missing string proves nothing. Only a positively different descriptor
	// can release a scan pin when the original USB serial is unavailable.
	return (
		pin.sku === observed.sku &&
		(pin.manufacturer === undefined ||
			observed.manufacturer === undefined ||
			pin.manufacturer === observed.manufacturer) &&
		(pin.product === undefined ||
			observed.product === undefined ||
			pin.product === observed.product)
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

	const config = getConfig();
	const next = { ...config.bond_opt_out };
	const groups = { ...config.bond_group_opt_out };
	const identity = resolveBondPhysicalIdentity(ifname);
	const legacy = identity?.legacyLinkId;
	if (legacy !== undefined && next[legacy] === true) {
		for (const present of listPresentPhysicalDevices()) {
			if (present.legacyLinkId === legacy && present.anchor !== "ifname") {
				const observed = pinObservation(present.ifname);
				const existing = groups[present.linkId];
				if (typeof existing === "object" && !Array.isArray(existing)) {
					groups[present.linkId] = { ...existing, portWide: true };
				} else if (observed !== undefined) {
					// Keep main's port-wide migration, but remember which split
					// supplied it if the operator enables the port without a serial.
					groups[present.linkId] = {
						group: legacy,
						...observed,
						portWide: true,
					};
				}
				next[present.linkId] = true;
			}
		}
	}
	if (optOut) {
		// The same port may have been enabled under a different serial.
		for (const [group, enabled] of Object.entries(groups)) {
			if (Array.isArray(enabled) && enabled.includes(physicalId)) {
				groups[group] = enabled.filter((id) => id !== physicalId);
			}
		}
	}
	const pin = groups[physicalId];
	const pinnedGroup =
		!optOut &&
		next[physicalId] === true &&
		typeof pin === "object" &&
		!Array.isArray(pin) &&
		matchesPin(pin, pinObservation(ifname))
			? pin.group
			: undefined;
	for (const group of new Set([legacy, pinnedGroup])) {
		if (group === undefined) continue;
		const grant = groups[group];
		if (next[group] !== true && !Array.isArray(grant)) continue;
		const enabled = Array.isArray(grant) ? grant : [];
		groups[group] = optOut
			? enabled
			: [...new Set([...enabled, physicalId])].sort();
	}
	// Enabling a replacement for which the pin is dormant does not release
	// the original product. A real exact toggle takes ownership of the key.
	if (optOut || next[physicalId] === true || Array.isArray(pin)) {
		delete groups[physicalId];
	}
	if (optOut) next[physicalId] = true;
	else delete next[physicalId];
	if (legacy !== undefined) delete next[legacy];
	config.bond_opt_out = Object.keys(next).length === 0 ? undefined : next;
	config.bond_group_opt_out =
		Object.keys(groups).length === 0 ? undefined : groups;
	saveConfig();
	return physicalId;
}

/** Reconcile scan-owned exact exclusions before publishing a USB scan. */
export function excludeResidualGroupMembers(): boolean {
	if (!isRuntimeConfigAvailable()) return false;
	const config = getConfig();
	const groups = config.bond_group_opt_out;
	let next: typeof config.bond_opt_out;
	let nextGroups: typeof groups;
	for (const {
		legacyLinkId,
		anchor,
		linkId,
		ifname,
	} of listPresentPhysicalDevices()) {
		if (anchor !== "id-path") continue;
		const observed = pinObservation(ifname);
		if (observed === undefined) continue;
		const entry = (nextGroups ?? groups)?.[linkId];
		const evidence = Array.isArray(entry) ? undefined : entry;
		const exact = (next ?? config.bond_opt_out)?.[linkId] === true;
		const enabled =
			legacyLinkId === undefined ? undefined : groups?.[legacyLinkId];
		// An existing pin owns its evidence, even if a different product happens
		// to show the same rejected group serial.
		if (typeof evidence === "object" && evidence.portWide) continue;
		if (exact && evidence === undefined) continue;
		const fromGroup =
			legacyLinkId !== undefined &&
			Array.isArray(enabled) &&
			!enabled.includes(linkId);
		if (evidence === undefined && fromGroup) {
			nextGroups ??= { ...groups };
			nextGroups[linkId] = { group: legacyLinkId, ...observed };
		}
		const excluded =
			evidence === undefined ? fromGroup : matchesPin(evidence, observed);
		if (exact === excluded) continue;
		next ??= { ...config.bond_opt_out };
		if (exact) delete next[linkId];
		else next[linkId] = true;
	}

	if (next !== undefined) config.bond_opt_out = next;
	if (nextGroups !== undefined) config.bond_group_opt_out = nextGroups;
	saveConfigInBackground(next !== undefined || nextGroups !== undefined);
	return next !== undefined;
}

export function resetPersistentBondOptOutForTest(): void {
	sessionOptOut.clear();
	const config = getConfig();
	config.bond_opt_out = undefined;
	config.bond_group_opt_out = undefined;
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
