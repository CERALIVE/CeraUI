import {
	type ClientZone,
	SteeringUnavailableError,
	type SteeringUplink,
} from "./contracts.ts";
import { cidrsOverlap } from "./subnet.ts";

interface PlannedUplink {
	readonly uplink: SteeringUplink;
	readonly subnet: string;
}

export function assertNoOverlap(
	zones: readonly ClientZone[],
	uplinks: readonly PlannedUplink[],
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

export function assertClientZonesDisjoint(zones: readonly ClientZone[]): void {
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

export function assertDistinctMarks(
	candidates: readonly PlannedUplink[],
): void {
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
