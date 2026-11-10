import { describe, expect, test } from "bun:test";

import {
	ensureUplinkRoute,
	planUplinkRoute,
} from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import { scripted } from "./uplink-steering-route-test-fixtures.ts";

describe("uplink steering route planning", () => {
	test.each([
		[
			"wwu1c2",
			"default via 10.5.4.129 proto static metric 700",
			["default", "via", "10.5.4.129", "proto", "static", "metric", "700"],
		],
		[
			"ppp0",
			"default scope link metric 700",
			["default", "scope", "link", "metric", "700"],
		],
	] as const)(
		"plans the interface-filtered %s default with exactly one device clause",
		async (ifname, defaultRoute, routeTokens) => {
			const plan = await planUplinkRoute(
				{
					identity: `filtered-${ifname}`,
					ifname,
					sourceAddress: "10.5.4.130",
					sourceAddressUnique: true,
					mark: 0xca000100,
				},
				scripted({
					"ip rule show":
						"0: from all lookup local\n32766: from all lookup main\n",
					[`ip -4 route show default dev ${ifname}`]: defaultRoute,
				}),
			);

			expect(plan.defaultRouteArgv).toEqual([
				"route",
				"replace",
				"table",
				"30001",
				...routeTokens,
				"dev",
				ifname,
			]);
		},
	);

	test.each(["wwu1c2", "wlan1"])(
		"refuses a conflicting device in an interface-filtered %s default",
		async (ifname) => {
			await expect(
				planUplinkRoute(
					{
						identity: `filtered-${ifname}`,
						ifname,
						sourceAddress: "10.5.4.130",
						sourceAddressUnique: true,
						mark: 0xca000100,
					},
					scripted({
						"ip rule show":
							"0: from all lookup local\n32766: from all lookup main\n",
						[`ip -4 route show default dev ${ifname}`]:
							"default via 10.5.4.129 dev wwan9 proto static metric 700",
					}),
				),
			).rejects.toMatchObject({
				name: "SteeringUnavailableError",
				reason: "policy_route_missing",
				message: `${ifname}: interface default route was unusable`,
			});
		},
	);

	test("does not infer an interface from an unfiltered table default", async () => {
		await expect(
			planUplinkRoute(
				{
					identity: "wifi-a",
					ifname: "wlan0",
					sourceAddress: "10.5.4.130",
					sourceAddressUnique: true,
					mark: 0xca000100,
				},
				scripted({
					"ip rule show": "100: from 10.5.4.130 lookup 30001\n",
					"ip route show table 30001":
						"default via 10.5.4.129 proto static metric 700",
				}),
			),
		).rejects.toMatchObject({ reason: "policy_route_missing" });
	});

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
});
