import { logger } from "../../helpers/logger.ts";
import { getConfig, isRuntimeConfigAvailable, saveConfig } from "../config.ts";
import { listPresentPhysicalDevices } from "../modems/physical-identity.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";

const sessionOptOut = new Set<string>();
// A reload replaces the config object, so pending writes cannot cross a reload.
const unsavedScanChanges = new WeakSet<ReturnType<typeof getConfig>>();

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
				next[present.linkId] = true;
				// Baseline migration owns this exact key, not the scan.
				if (typeof groups[present.linkId] === "string") {
					delete groups[present.linkId];
				}
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
	const grant = legacy === undefined ? undefined : groups[legacy];
	if (legacy !== undefined && (next[legacy] === true || Array.isArray(grant))) {
		const enabled = Array.isArray(grant) ? grant : [];
		groups[legacy] = optOut
			? enabled
			: [...new Set([...enabled, physicalId])].sort();
	}
	// Enabling a replacement for which the pin is dormant does not release
	// the original product. A real exact toggle takes ownership of the key.
	if (
		optOut ||
		next[physicalId] === true ||
		Array.isArray(groups[physicalId])
	) {
		delete groups[physicalId];
	}
	if (optOut) next[physicalId] = true;
	else delete next[physicalId];
	if (legacy !== undefined) delete next[legacy];
	config.bond_opt_out = Object.keys(next).length === 0 ? undefined : next;
	config.bond_group_opt_out =
		Object.keys(groups).length === 0 ? undefined : groups;
	saveConfig();
	unsavedScanChanges.delete(config);
	return physicalId;
}

/** Reconcile scan-owned exact exclusions before publishing a USB scan. */
export function excludeResidualGroupMembers(): void {
	if (!isRuntimeConfigAvailable()) return;
	const config = getConfig();
	const groups = config.bond_group_opt_out;
	let next: typeof config.bond_opt_out;
	let nextGroups: typeof groups;
	for (const {
		legacyLinkId,
		anchor,
		linkId,
		vid,
		pid,
	} of listPresentPhysicalDevices()) {
		if (anchor !== "id-path" || vid === undefined || pid === undefined)
			continue;
		const product = `${vid}:${pid}`;
		const evidence = (nextGroups ?? groups)?.[linkId];
		const exact = (next ?? config.bond_opt_out)?.[linkId] === true;
		const enabled =
			legacyLinkId === undefined ? undefined : groups?.[legacyLinkId];
		const fromGroup = Array.isArray(enabled) && !enabled.includes(linkId);

		// Never retire or claim an exact exclusion written by the operator.
		if (exact && typeof evidence !== "string") continue;
		if (fromGroup && evidence !== product) {
			nextGroups ??= { ...groups };
			nextGroups[linkId] = product;
		}
		if (exact === (fromGroup || evidence === product)) continue;
		next ??= { ...config.bond_opt_out };
		if (exact) delete next[linkId];
		else next[linkId] = true;
	}

	if (next !== undefined) config.bond_opt_out = next;
	if (nextGroups !== undefined) config.bond_group_opt_out = nextGroups;
	const retrying = unsavedScanChanges.has(config);
	if (next === undefined && nextGroups === undefined && !retrying) return;
	try {
		saveConfig();
		unsavedScanChanges.delete(config);
	} catch (error) {
		// One save per scan and one warning per failure episode; publish the
		// reconciled state even when the filesystem cannot take the write.
		unsavedScanChanges.add(config);
		if (!retrying)
			logger.warn("bond: could not persist twin port exclusions", { error });
	}
}

export function resetPersistentBondOptOutForTest(): void {
	sessionOptOut.clear();
	const config = getConfig();
	config.bond_opt_out = undefined;
	config.bond_group_opt_out = undefined;
	unsavedScanChanges.delete(config);
}

export function resetSessionBondOptOutForTest(): void {
	sessionOptOut.clear();
}
