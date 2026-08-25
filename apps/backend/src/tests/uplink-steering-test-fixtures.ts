import type {
	PreparedSteeringState,
	UplinkRoutePlan,
} from "../modules/network/uplink-steering/applier.ts";
import type { SteeringUplink } from "../modules/network/uplink-steering/contracts.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";

const ZONE = { ifname: "eth9", ipv4Cidr: "10.90.0.0/24" } as const;

export function uplink(
	identity: string,
	ifname: string,
	weight: number,
): SteeringUplink {
	return {
		identity,
		ifname,
		mark: stableUplinkMark(identity),
		selectable: weight > 0,
		weight,
	};
}

export function prepared(
	uplinks: readonly SteeringUplink[],
	clientZones = [ZONE],
): PreparedSteeringState {
	return {
		clientZones,
		uplinks,
		routes: uplinks.map(
			(u): UplinkRoutePlan => ({
				identity: u.identity,
				ifname: u.ifname,
				sourceAddress: `192.0.2.${u.ifname.length}`,
				mark: u.mark,
				table: `${20_000 + ((u.mark >>> 8) & 0xffff)}`,
				managed: false,
			}),
		),
	};
}
