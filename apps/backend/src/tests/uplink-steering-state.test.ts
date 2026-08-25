import { describe, expect, test } from "bun:test";

import {
	NETIF_ERR_DUPIPV4,
	NETIF_ERR_HOTSPOT,
	NETIF_ERR_SHAREDLAN,
	type NetworkInterface,
} from "../modules/network/network-interfaces.ts";
import type { UplinkHealthRecord } from "../modules/network/uplink-health/model.ts";
import type { UplinkRouteCandidate } from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import {
	readDesiredSteeringState,
	type SteeringStateBuilderDeps,
} from "../modules/network/uplink-steering/state-builder.ts";

function netif(
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

function health(
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

function harness(
	overrides: Partial<SteeringStateBuilderDeps> = {},
): SteeringStateBuilderDeps & { planned: UplinkRouteCandidate[] } {
	const planned: UplinkRouteCandidate[] = [];
	return {
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
		policyRouteVerdict: () => undefined,
		planRoute: async (candidate) => {
			planned.push(candidate);
			return { ...candidate, table: candidate.ifname, managed: false };
		},
		...overrides,
		planned,
	};
}

describe("readDesiredSteeringState", () => {
	test("derives both client zones and consumes health weights", async () => {
		const h = harness();
		const state = await readDesiredSteeringState(h);

		expect(state.clientZones).toEqual([
			{ ifname: "clap-wlan0", ipv4Cidr: "10.42.0.0/24" },
			{ ifname: "eth9", ipv4Cidr: "10.43.0.0/24" },
		]);
		expect(
			state.uplinks.map(({ ifname, weight }) => ({ ifname, weight })),
		).toEqual([
			{ ifname: "wlan0", weight: 25 },
			{ ifname: "wwan0", weight: 100 },
		]);
		expect(
			state.uplinks.find((item) => item.ifname === "wlan0")?.identity,
		).toBe("wifi-mac:00:11:22:33:44:55");
		expect(h.planned.map((candidate) => candidate.ifname)).toEqual([
			"wlan0",
			"wwan0",
		]);
	});

	test("defaults an unobserved uplink to full weight during health startup", async () => {
		const h = harness({ health: () => [] });
		const state = await readDesiredSteeringState(h);

		expect(state.uplinks.map((item) => item.weight)).toEqual([100, 100, 100]);
	});

	test("withholds WiFi until its permanent identity is available", async () => {
		const h = harness({ wifiIdentity: () => undefined });
		const state = await readDesiredSteeringState(h);

		expect(state.uplinks.map((item) => item.ifname)).toEqual(["wwan0"]);
	});

	test("refuses a client zone that is still a bond candidate", async () => {
		const h = harness({
			isBondCandidate: (ifname) => ifname === "eth9",
		});

		await expect(readDesiredSteeringState(h)).rejects.toMatchObject({
			reason: "bond_candidate_client_zone",
		});
		expect(h.planned).toEqual([]);
	});

	test("refuses overlapping client and uplink subnets before route mutation", async () => {
		const h = harness({
			interfaces: () => ({
				eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
				wwan0: netif("10.43.0.22"),
			}),
			health: () => [health("wwan0", "up", 100)],
			isClientZone: (ifname) => ifname === "eth9",
		});

		await expect(readDesiredSteeringState(h)).rejects.toMatchObject({
			reason: "overlapping_subnet",
		});
		expect(h.planned).toEqual([]);
	});

	test("refuses overlapping client zones before route mutation", async () => {
		const h = harness({
			interfaces: () => ({
				"clap-wlan0": netif("10.42.0.1", "255.255.255.0", NETIF_ERR_HOTSPOT),
				eth9: netif("10.42.0.2", "255.255.255.0", NETIF_ERR_SHAREDLAN),
				wwan0: netif("100.64.1.2"),
			}),
			health: () => [health("wwan0", "up", 100)],
			isClientZone: (ifname) => ifname === "clap-wlan0" || ifname === "eth9",
		});

		await expect(readDesiredSteeringState(h)).rejects.toMatchObject({
			reason: "overlapping_subnet",
		});
		expect(h.planned).toEqual([]);
	});

	test("propagates a typed policy-route refusal without partial output", async () => {
		const h = harness({
			planRoute: async () => {
				throw Object.assign(new Error("missing table"), {
					reason: "policy_route_missing",
				});
			},
		});

		await expect(readDesiredSteeringState(h)).rejects.toMatchObject({
			reason: "policy_route_missing",
		});
	});

	test("refuses a self-check failure unless the module owns that uplink's table", async () => {
		const refused = harness({
			interfaces: () => ({
				eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
				wlan0: netif("192.168.2.8"),
			}),
			health: () => [health("wlan0", "up", 100)],
			isClientZone: (ifname) => ifname === "eth9",
			policyRouteVerdict: (ifname) => ifname === "wlan0",
		});
		await expect(readDesiredSteeringState(refused)).rejects.toMatchObject({
			reason: "policy_route_missing",
		});
		expect(refused.planned).toEqual([]);

		const provisioned = harness({
			interfaces: () => ({
				eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
				wwan0: netif("100.64.1.2"),
			}),
			health: () => [health("wwan0", "up", 100)],
			isClientZone: (ifname) => ifname === "eth9",
			policyRouteVerdict: (ifname) => ifname === "wwan0",
		});
		await readDesiredSteeringState(provisioned);
		expect(provisioned.planned.map((candidate) => candidate.ifname)).toEqual([
			"wwan0",
		]);
	});

	test("withholds module-owned source rules for duplicate uplink addresses", async () => {
		const h = harness({
			interfaces: () => ({
				eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
				wwan0: netif("100.64.1.2", "255.255.255.0", NETIF_ERR_DUPIPV4),
				wwan1: netif("100.64.1.2", "255.255.255.0", NETIF_ERR_DUPIPV4),
			}),
			health: () => [health("wwan0", "up", 100), health("wwan1", "up", 100)],
			isClientZone: (ifname) => ifname === "eth9",
		});
		await readDesiredSteeringState(h);

		expect(h.planned).toHaveLength(2);
		expect(h.planned.every((candidate) => !candidate.sourceAddressUnique)).toBe(
			true,
		);
	});

	test("refuses a non-contiguous subnet mask instead of guessing overlap", async () => {
		const h = harness({
			interfaces: () => ({
				eth9: netif("10.43.0.1", "255.0.255.0", NETIF_ERR_SHAREDLAN),
				wwan0: netif("100.64.1.2"),
			}),
			isClientZone: (ifname) => ifname === "eth9",
		});

		await expect(readDesiredSteeringState(h)).rejects.toMatchObject({
			reason: "overlapping_subnet",
		});
	});

	test("refuses two active identities that collide in the mark namespace", async () => {
		const h = harness({ markForIdentity: () => 0xca001100 });

		await expect(readDesiredSteeringState(h)).rejects.toMatchObject({
			reason: "mark_collision",
		});
		expect(h.planned).toEqual([]);
	});
});
