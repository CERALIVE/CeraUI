import { logger } from "../../helpers/logger.ts";
import type { PhysicalDeviceRecord } from "../modems/physical-identity.ts";
import { resolveModemPhysicalIdentity } from "../modems/physical-identity-source.ts";
import {
	type BondEntry,
	isMappableEntry,
	unmappableBondEntry,
} from "./bind-map.ts";

export type BondIdentityResolver = typeof resolveModemPhysicalIdentity;

let identityResolver: BondIdentityResolver = resolveModemPhysicalIdentity;

export function setBondIdentityResolverForTest(
	fn: BondIdentityResolver | null,
): void {
	identityResolver = fn ?? resolveModemPhysicalIdentity;
}

export function resolveBondPhysicalIdentity(
	ifname: string,
): PhysicalDeviceRecord | undefined {
	try {
		return identityResolver(ifname);
	} catch {
		return undefined;
	}
}

export function describeBondEntry(
	ifname: string,
	ip: string,
	logFailure = true,
): BondEntry {
	try {
		const record = identityResolver(ifname);
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

export function isBondLinkMappable(ifname: string, ip: string): boolean {
	return isMappableEntry(describeBondEntry(ifname, ip, false));
}
