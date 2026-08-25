import { describe, expect, test } from "bun:test";

import {
	ensureUplinkRoute,
	planUplinkRoute,
	type UplinkRouteManagerDeps,
} from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import { scripted } from "./uplink-steering-route-test-fixtures.ts";

describe("uplink steering route planning", () => {
	test("provisions an interface-specific Ethernet table when no source rule exists", async () => {
		const mark = stableUplinkMark("onboard-eth0");
		const baseRules =
			"0: from all lookup local\n32766: from all lookup main\n32767: from all lookup default\n";
		const h = scripted({
			"ip rule show": baseRules,
			"ip -4 route show default dev eth0":
				"default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.20 metric 100\n",
		});
		const plan = await planUplinkRoute(
			{
				identity: "onboard-eth0",
				ifname: "eth0",
				sourceAddress: "192.168.1.20",
				sourceAddressUnique: true,
				mark,
			},
			h,
		);
		expect(plan.managed).toBe(true);
		expect(plan.sourceRulePriority).toBe(100);
		expect(plan.defaultRouteArgv).toEqual([
			"route",
			"replace",
			"table",
			plan.table,
			"default",
			"via",
			"192.168.1.1",
			"dev",
			"eth0",
			"proto",
			"dhcp",
			"src",
			"192.168.1.20",
			"metric",
			"100",
		]);

		await ensureUplinkRoute(plan, h);
		expect(h.calls).toContainEqual(["ip", ...(plan.defaultRouteArgv ?? [])]);
		expect(h.calls).toContainEqual(
			expect.arrayContaining([
				"rule",
				"add",
				"priority",
				"100",
				"from",
				"192.168.1.20/32",
			]),
		);
	});

	test("provisions a private Ethernet table without modifying a broken source rule", async () => {
		const mark = stableUplinkMark("ethernet-b");
		const h = scripted({
			"ip rule show":
				"100: from 192.168.5.20 lookup 155\n32766: from all lookup main\n",
			"ip route show table 155": "default via 192.168.5.1 dev eth9\n",
			"ip -4 route show default dev eth0": "default via 192.168.5.1 dev eth0\n",
		});
		const plan = await planUplinkRoute(
			{
				identity: "ethernet-b",
				ifname: "eth0",
				sourceAddress: "192.168.5.20",
				sourceAddressUnique: true,
				mark,
			},
			h,
		);

		expect(plan).toMatchObject({ managed: true, ifname: "eth0" });
		expect(plan.table).not.toBe("155");
		expect(plan.sourceRulePriority).toBeUndefined();
	});

	test("provisions managed tables for otherwise-unmapped wired and ppp uplinks", async () => {
		for (const [ifname, sourceAddress, gateway] of [
			["enx001122334455", "192.168.7.2", "192.168.7.1"],
			["wwan0", "100.64.1.2", "100.64.1.1"],
			["ppp0", "10.64.64.2", "10.64.64.1"],
		] as const) {
			const mark = stableUplinkMark(`managed-${ifname}`);
			const h = scripted({
				"ip rule show":
					"0: from all lookup local\n32766: from all lookup main\n32767: from all lookup default\n",
				[`ip -4 route show default dev ${ifname}`]: `default via ${gateway} dev ${ifname}\n`,
			});
			const plan = await planUplinkRoute(
				{
					identity: `managed-${ifname}`,
					ifname,
					sourceAddress,
					sourceAddressUnique: true,
					mark,
				},
				h,
			);

			expect(plan).toMatchObject({ managed: true, sourceRulePriority: 100 });
		}
	});

	test("withholds a source rule when a managed uplink address is ambiguous", async () => {
		const mark = stableUplinkMark("duplicate-wwan");
		const h = scripted({
			"ip rule show":
				"0: from all lookup local\n32766: from all lookup main\n32767: from all lookup default\n",
			"ip -4 route show default dev wwan0":
				"default via 100.64.1.1 dev wwan0\n",
		});
		const plan = await planUplinkRoute(
			{
				identity: "duplicate-wwan",
				ifname: "wwan0",
				sourceAddress: "100.64.1.2",
				sourceAddressUnique: false,
				mark,
			},
			h,
		);

		expect(plan.managed).toBe(true);
		expect(plan.sourceRulePriority).toBeUndefined();
	});

	test("refuses a non-Ethernet uplink with no source-route table", async () => {
		const h = scripted({
			"ip rule show": "0: from all lookup local\n32766: from all lookup main\n",
		});

		await expect(
			planUplinkRoute(
				{
					identity: "wifi-a",
					ifname: "wlan0",
					sourceAddress: "192.168.2.10",
					sourceAddressUnique: true,
					mark: stableUplinkMark("wifi-a"),
				},
				h,
			),
		).rejects.toMatchObject({ reason: "policy_route_missing" });
	});

	test("refuses an existing table whose default route leaves by another interface", async () => {
		const h = scripted({
			"ip rule show":
				"100: from 192.168.2.10 lookup 120\n32766: from all lookup main\n",
			"ip route show table 120": "default via 192.168.2.1 dev wlan1\n",
		});

		await expect(
			planUplinkRoute(
				{
					identity: "wifi-a",
					ifname: "wlan0",
					sourceAddress: "192.168.2.10",
					sourceAddressUnique: true,
					mark: stableUplinkMark("wifi-a"),
				},
				h,
			),
		).rejects.toMatchObject({ reason: "policy_route_missing" });
	});

	test("maps route-read failures onto the typed policy-route refusal", async () => {
		const h: UplinkRouteManagerDeps = {
			run: async () => {
				throw new Error("ip unavailable");
			},
		};
		await expect(
			planUplinkRoute(
				{
					identity: "wifi-a",
					ifname: "wlan0",
					sourceAddress: "192.168.2.10",
					sourceAddressUnique: true,
					mark: stableUplinkMark("wifi-a"),
				},
				h,
			),
		).rejects.toMatchObject({
			reason: "policy_route_missing",
			message: "wlan0: ip unavailable",
		});
	});
});
