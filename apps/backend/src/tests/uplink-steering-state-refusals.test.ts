import { describe, expect, test } from "bun:test";
import {
	NETIF_ERR_DUPIPV4,
	NETIF_ERR_HOTSPOT,
	NETIF_ERR_SHAREDLAN,
} from "../modules/network/network-interfaces.ts";
import { planUplinkRoute } from "../modules/network/uplink-steering/route-manager.ts";
import { readDesiredSteeringState } from "../modules/network/uplink-steering/state-builder.ts";
import { scripted } from "./uplink-steering-route-test-fixtures.ts";
import {
	harness,
	health,
	netif,
} from "./uplink-steering-state-test-fixtures.ts";
import { readReadySteeringState } from "./uplink-steering-test-fixtures.ts";

describe("readDesiredSteeringState", () => {
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

	test("prepares wlan1 with no source rules through the managed route planner", async () => {
		const routeDeps = scripted({
			"ip rule show":
				"0: from all lookup local\n32766: from all lookup main\n32767: from all lookup default\n",
			"ip -4 route show default dev wlan1":
				"default via 192.168.1.1 proto dhcp src 192.168.1.50 metric 600",
		});
		const h = harness({
			interfaces: () => ({
				eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
				wlan1: netif("192.168.1.50"),
			}),
			health: () => [health("wlan1", "up", 100)],
			wifiIdentity: () => "wifi-mac:00:11:22:33:44:55",
			markForIdentity: () => 0xca000100,
			isClientZone: (ifname) => ifname === "eth9",
			planRoute: (candidate) => planUplinkRoute(candidate, routeDeps),
		});
		const state = await readReadySteeringState(h);
		expect(state.uplinks.map((uplink) => uplink.ifname)).toEqual(["wlan1"]);
		expect(state.routes).toHaveLength(1);
		expect(state.routes[0]).toMatchObject({
			ifname: "wlan1",
			managed: true,
			sourceRulePriority: 100,
			defaultRouteArgv: [
				"route",
				"replace",
				"table",
				"30001",
				"default",
				"via",
				"192.168.1.1",
				"proto",
				"dhcp",
				"src",
				"192.168.1.50",
				"metric",
				"600",
				"dev",
				"wlan1",
			],
		});
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
});
