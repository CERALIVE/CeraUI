import { logger } from "../../helpers/logger.ts";
import type { PhysicalDeviceRecord } from "../modems/physical-identity.ts";
import {
	describeModemPhysicalIdentity,
	resolveModemPhysicalIdentity,
} from "../modems/physical-identity-source.ts";
import {
	type BondEntry,
	isMappableEntry,
	unmappableBondEntry,
} from "./bind-map.ts";

export type BondIdentityResolver = typeof resolveModemPhysicalIdentity;

let identityResolver: BondIdentityResolver = resolveModemPhysicalIdentity;

function bondIdentity(ifname: string, mode: "observe" | "preview") {
	return mode === "preview" && identityResolver === resolveModemPhysicalIdentity
		? describeModemPhysicalIdentity(ifname)
		: identityResolver(ifname);
}

export function setBondIdentityResolverForTest(
	fn: BondIdentityResolver | null,
): void {
	identityResolver = fn ?? resolveModemPhysicalIdentity;
}

export function resolveBondPhysicalIdentity(
	ifname: string,
	mode: "observe" | "preview" = "observe",
): PhysicalDeviceRecord | undefined {
	try {
		return bondIdentity(ifname, mode);
	} catch {
		return undefined;
	}
}

export function describeBondEntry(
	ifname: string,
	ip: string,
	logFailure = true,
	mode: "observe" | "preview" = "observe",
): BondEntry {
	try {
		const record = bondIdentity(ifname, mode);
		return {
			ip,
			iface: ifname,
			linkId: record.linkId,
			...(record.idPath !== undefined ? { idPath: record.idPath } : {}),
		};
	} catch (error) {
		if (logFailure) {
			logger.warn("bind-map: identity resolution failed for a bonded link", {
				ifname,
				error,
			});
		}
		return unmappableBondEntry(ip, ifname);
	}
}

export function isBondLinkMappable(
	ifname: string,
	ip: string,
	mode: "observe" | "preview" = "observe",
): boolean {
	return isMappableEntry(describeBondEntry(ifname, ip, false, mode));
}
