import {
	NETIF_ERR_HOTSPOT,
	NETIF_ERR_SHAREDLAN,
	type NetworkInterface,
} from "../modules/network/network-interfaces.ts";
import type { UplinkHealthRecord } from "../modules/network/uplink-health/model.ts";
import type { UplinkRouteCandidate } from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import type { SteeringStateBuilderDeps } from "../modules/network/uplink-steering/state-builder.ts";

export function netif(
	ip: string,
	netmask = "255.255.255.0",
	error = 0,
): NetworkInterface {
	return {
		ip,
		netmask,
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: error === 0,
		error,
	};
}

export function health(
	iface: string,
	state: UplinkHealthRecord["state"],
	weight: number,
): UplinkHealthRecord {
	return {
		iface,
		kind: iface.startsWith("wl") ? "wifi" : "cellular",
		state,
		weight,
		lastTransition: 1,
		staleAt: 10,
		probes: { successes: 0, failures: 0 },
		signals: {},
	};
}

export function harness(
	overrides: Partial<SteeringStateBuilderDeps> = {},
): SteeringStateBuilderDeps & { planned: UplinkRouteCandidate[] } {
	const planned: UplinkRouteCandidate[] = [];
	return {
		netifReady: () => true,
		zonesReady: () => true,
		identityCovered: () => true,
		identityDeadlineExpired: () => false,
		interfaces: () => ({
			"clap-wlan0": netif("10.42.0.1", "255.255.255.0", NETIF_ERR_HOTSPOT),
			eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
			wlan0: netif("192.168.2.8"),
			wwan0: netif("100.64.1.2"),
			wwan1: netif("100.64.2.2"),
			br0: netif("172.20.0.1"),
		}),
		health: () => [
			health("wlan0", "degraded", 25),
			health("wwan0", "up", 100),
			health("wwan1", "down", 0),
		],
		wifiIdentity: (ifname) =>
			ifname === "wlan0" ? "wifi-mac:00:11:22:33:44:55" : undefined,
		physicalIdentity: (ifname) => `id-path:${ifname}`,
		markForIdentity: stableUplinkMark,
		isBondCandidate: () => false,
		isClientZone: (ifname) => ifname === "clap-wlan0" || ifname === "eth9",
		planRoute: async (candidate) => {
			planned.push(candidate);
			return { ...candidate, table: candidate.ifname, managed: false };
		},
		...overrides,
		planned,
	};
}
