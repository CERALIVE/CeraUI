import { describe, expect, test } from "bun:test";

import { FWMARK_RULE_PRIORITY } from "../modules/network/uplink-steering/contracts.ts";
import {
	discoverOwnedUplinkRoutes,
	ensureUplinkRoute,
	hasForeignFwmarkPriorityRule,
	planUplinkRoute,
} from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import { hexMark, scripted } from "./uplink-steering-route-test-fixtures.ts";

describe("uplink steering route recovery", () => {
	test("recovers owned fwmark support across a backend restart", async () => {
		const imageMark = stableUplinkMark("wifi-image-table");
		const managedMark = stableUplinkMark("wwan-managed-table");
		const rules = `0: from all lookup local
100: from 100.64.1.2 lookup 30123
${FWMARK_RULE_PRIORITY}: from all fwmark ${hexMark(imageMark)}/0xffffff00 lookup 120
${FWMARK_RULE_PRIORITY}: from all fwmark ${hexMark(managedMark)}/0xffffff00 lookup 30123
32766: from all lookup main
`;
		const h = scripted({
			"ip rule show": rules,
			"ip route show table 120": "default via 192.168.2.1 dev wlan0\n",
			"ip route show table 30123": "default via 100.64.1.1 dev wwan0\n",
		});

		const recovered = await discoverOwnedUplinkRoutes(h);

		expect(recovered).toEqual([
			{
				identity: `recovered:${imageMark.toString(16)}`,
				ifname: "wlan0",
				sourceAddress: "0.0.0.0",
				mark: imageMark,
				table: "120",
				managed: false,
			},
			{
				identity: `recovered:${managedMark.toString(16)}`,
				ifname: "wwan0",
				sourceAddress: "100.64.1.2",
				mark: managedMark,
				table: "30123",
				managed: true,
				sourceRulePriority: 100,
			},
		]);
	});

	test("reuses the source-route table and adds a lower-precedence fwmark rule", async () => {
		const mark = stableUplinkMark("cellular-a");
		const ruleOutput = `0: from all lookup local
100: from 100.64.1.2 lookup 120
32766: from all lookup main
32767: from all lookup default
`;
		const h = scripted({
			"ip rule show": ruleOutput,
			"ip route show table 120": "default via 100.64.1.1 dev wwan0\n",
		});
		const plan = await planUplinkRoute(
			{
				identity: "cellular-a",
				ifname: "wwan0",
				sourceAddress: "100.64.1.2",
				sourceAddressUnique: true,
				mark,
			},
			h,
		);

		expect(plan).toMatchObject({ table: "120", managed: false });
		await ensureUplinkRoute(plan, h);
		expect(FWMARK_RULE_PRIORITY).toBeGreaterThan(100);
		expect(h.calls[h.calls.length - 1]).toEqual([
			"ip",
			"rule",
			"add",
			"priority",
			String(FWMARK_RULE_PRIORITY),
			"fwmark",
			`${hexMark(mark)}/0xffffff00`,
			"lookup",
			"120",
		]);
	});

	test("refuses a foreign rule occupying the reserved fwmark priority", async () => {
		const output = `0: from all lookup local
${FWMARK_RULE_PRIORITY}: from all lookup main
32766: from all lookup main
`;
		expect(hasForeignFwmarkPriorityRule(output)).toBe(true);
		expect(
			hasForeignFwmarkPriorityRule(
				`${FWMARK_RULE_PRIORITY}: from all fwmark 0xca123400/0xffffff00 lookup 120\n`,
			),
		).toBe(false);
		const h = scripted({ "ip rule show": output });

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
});
