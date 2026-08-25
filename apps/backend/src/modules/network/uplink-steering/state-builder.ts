import { resolveModemPhysicalIdentity } from "../../modems/physical-identity-source.ts";
import { isConcurrentApIfname } from "../../wifi/wifi-concurrent-interface.ts";
import { getWifiInterfacesByMacAddress } from "../../wifi/wifi-connections.ts";
import { isSharedLanPort } from "../ethernet-role.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
	NETIF_ERR_DUPIPV4,
	NETIF_ERR_HOTSPOT,
	NETIF_ERR_SHAREDLAN,
	type NetworkInterface,
} from "../network-interfaces.ts";
import { getPolicyRouteVerdict } from "../policy-route-check.ts";
import type { UplinkHealthRecord } from "../uplink-health/model.ts";
import { getUplinksMessage } from "../uplink-health/state.ts";
import type { PreparedSteeringState, UplinkRoutePlan } from "./applier.ts";
import {
	type ClientZone,
	SteeringUnavailableError,
	type SteeringUplink,
} from "./contracts.ts";
import {
	isModuleProvisionedUplink,
	planUplinkRoute,
	type UplinkRouteCandidate,
} from "./route-manager.ts";
import { stableUplinkMark } from "./ruleset.ts";
import { cidrsOverlap, subnetCidr } from "./subnet.ts";

type NetworkSnapshot = Record<string, NetworkInterface | undefined>;

export interface SteeringStateBuilderDeps {
	readonly interfaces: () => NetworkSnapshot;
	readonly health: () => readonly UplinkHealthRecord[];
	readonly wifiIdentity: (ifname: string) => string | undefined;
	readonly physicalIdentity: (ifname: string) => string;
	readonly markForIdentity: (identity: string) => number;
	readonly isBondCandidate: (
		ifname: string,
		entry: NetworkInterface,
	) => boolean;
	readonly isClientZone: (ifname: string, entry: NetworkInterface) => boolean;
	readonly policyRouteVerdict: (ifname: string) => boolean | undefined;
	readonly planRoute: (
		candidate: UplinkRouteCandidate,
	) => Promise<UplinkRoutePlan>;
}

const defaultDeps: SteeringStateBuilderDeps = {
	interfaces: getNetworkInterfaces,
	health: getUplinksMessage,
	wifiIdentity: wifiIdentity,
	physicalIdentity: (ifname) =>
		resolveModemPhysicalIdentity(ifname).identityKey,
	markForIdentity: stableUplinkMark,
	isBondCandidate,
	isClientZone: (ifname, entry) =>
		isSharedLanPort(ifname) ||
		isConcurrentApIfname(ifname) ||
		(entry.error & (NETIF_ERR_HOTSPOT | NETIF_ERR_SHAREDLAN)) !== 0,
	policyRouteVerdict: getPolicyRouteVerdict,
	planRoute: (candidate) => planUplinkRoute(candidate),
};

export async function readDesiredSteeringState(
	deps: SteeringStateBuilderDeps = defaultDeps,
): Promise<PreparedSteeringState> {
	const interfaces = deps.interfaces();
	const zones = collectClientZones(interfaces, deps);
	if (zones.length === 0) return { clientZones: [], uplinks: [], routes: [] };
	assertClientZonesDisjoint(zones);
	const health = new Map(deps.health().map((record) => [record.iface, record]));
	const candidates = collectUplinkCandidates(interfaces, zones, health, deps);
	assertNoOverlap(zones, candidates);
	assertDistinctMarks(candidates);
	const routes: UplinkRoutePlan[] = [];
	for (const candidate of candidates) {
		routes.push(
			await deps.planRoute({
				identity: candidate.uplink.identity,
				ifname: candidate.uplink.ifname,
				sourceAddress: candidate.sourceAddress,
				sourceAddressUnique: candidate.sourceAddressUnique,
				mark: candidate.uplink.mark,
			}),
		);
	}
	return {
		clientZones: zones,
		uplinks: candidates.map((candidate) => candidate.uplink),
		routes,
	};
}

function collectClientZones(
	interfaces: NetworkSnapshot,
	deps: SteeringStateBuilderDeps,
): ClientZone[] {
	const zones: ClientZone[] = [];
	for (const [ifname, entry] of Object.entries(interfaces)) {
		if (!entry?.ip || !entry.netmask || !deps.isClientZone(ifname, entry))
			continue;
		if (deps.isBondCandidate(ifname, entry)) {
			throw new SteeringUnavailableError(
				"bond_candidate_client_zone",
				`${ifname} is both a client zone and a bond candidate`,
			);
		}
		zones.push({ ifname, ipv4Cidr: subnetCidr(entry.ip, entry.netmask) });
	}
	return zones.sort((a, b) => a.ifname.localeCompare(b.ifname));
}

interface UplinkCandidate {
	readonly uplink: SteeringUplink;
	readonly sourceAddress: string;
	readonly sourceAddressUnique: boolean;
	readonly subnet: string;
}

function collectUplinkCandidates(
	interfaces: NetworkSnapshot,
	zones: readonly ClientZone[],
	health: ReadonlyMap<string, UplinkHealthRecord>,
	deps: SteeringStateBuilderDeps,
): UplinkCandidate[] {
	const zoneIfaces = new Set(zones.map((zone) => zone.ifname));
	const sourceAddressCounts = new Map<string, number>();
	for (const entry of Object.values(interfaces)) {
		if (!entry?.ip) continue;
		sourceAddressCounts.set(
			entry.ip,
			(sourceAddressCounts.get(entry.ip) ?? 0) + 1,
		);
	}
	const candidates: UplinkCandidate[] = [];
	for (const [ifname, entry] of Object.entries(interfaces)) {
		if (!entry?.ip || !entry.netmask || zoneIfaces.has(ifname)) continue;
		if (!isSupportedUplink(ifname)) continue;
		if ((entry.error & ~NETIF_ERR_DUPIPV4) !== 0) continue;
		if (
			deps.policyRouteVerdict(ifname) === true &&
			!isModuleProvisionedUplink(ifname)
		) {
			throw new SteeringUnavailableError(
				"policy_route_missing",
				`${ifname}: policy-route self-check reports no usable default`,
			);
		}
		const record = health.get(ifname);
		if (record?.state === "down") continue;
		const wifiId = deps.wifiIdentity(ifname);
		if (ifname.startsWith("wl") && wifiId === undefined) continue;
		const identity = wifiId ?? deps.physicalIdentity(ifname);
		const weight = record?.weight ?? 100;
		candidates.push({
			uplink: {
				identity,
				ifname,
				mark: deps.markForIdentity(identity),
				selectable: weight > 0,
				weight,
			},
			sourceAddress: entry.ip,
			sourceAddressUnique: sourceAddressCounts.get(entry.ip) === 1,
			subnet: subnetCidr(entry.ip, entry.netmask),
		});
	}
	return candidates.sort((a, b) =>
		a.uplink.ifname.localeCompare(b.uplink.ifname),
	);
}

function assertNoOverlap(
	zones: readonly ClientZone[],
	uplinks: readonly UplinkCandidate[],
): void {
	for (const zone of zones) {
		for (const uplink of uplinks) {
			if (!cidrsOverlap(zone.ipv4Cidr, uplink.subnet)) continue;
			throw new SteeringUnavailableError(
				"overlapping_subnet",
				`${zone.ifname} ${zone.ipv4Cidr} overlaps ${uplink.uplink.ifname} ${uplink.subnet}`,
			);
		}
	}
}

function assertClientZonesDisjoint(zones: readonly ClientZone[]): void {
	for (const [index, zone] of zones.entries()) {
		for (const other of zones.slice(index + 1)) {
			if (!cidrsOverlap(zone.ipv4Cidr, other.ipv4Cidr)) continue;
			throw new SteeringUnavailableError(
				"overlapping_subnet",
				`${zone.ifname} ${zone.ipv4Cidr} overlaps ${other.ifname} ${other.ipv4Cidr}`,
			);
		}
	}
}

function assertDistinctMarks(candidates: readonly UplinkCandidate[]): void {
	const owners = new Map<number, string>();
	for (const candidate of candidates) {
		const prior = owners.get(candidate.uplink.mark);
		if (prior !== undefined) {
			throw new SteeringUnavailableError(
				"mark_collision",
				`${prior} and ${candidate.uplink.ifname} resolve to one steering mark`,
			);
		}
		owners.set(candidate.uplink.mark, candidate.uplink.ifname);
	}
}

function wifiIdentity(ifname: string): string | undefined {
	for (const [mac, entry] of Object.entries(getWifiInterfacesByMacAddress())) {
		if (entry?.ifname === ifname) return `wifi-mac:${mac.toLowerCase()}`;
	}
	return undefined;
}

function isSupportedUplink(ifname: string): boolean {
	return /^(?:wl|ww|ppp|usb|eth|en)/.test(ifname);
}
