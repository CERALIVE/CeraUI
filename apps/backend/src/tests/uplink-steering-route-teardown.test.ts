import { describe, expect, test } from "bun:test";

import type { UplinkRoutePlan } from "../modules/network/uplink-steering/applier.ts";
import { FWMARK_RULE_PRIORITY } from "../modules/network/uplink-steering/contracts.ts";
import {
	ensureUplinkRoute,
	hasFwmarkRule,
	removeUplinkRoute,
	type UplinkRouteManagerDeps,
} from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import { hexMark, scripted } from "./uplink-steering-route-test-fixtures.ts";

describe("uplink steering route teardown", () => {
	test("rolls back partial managed provisioning when fwmark installation fails", async () => {
		const mark = stableUplinkMark("managed-failure");
		const plan: UplinkRoutePlan = {
			identity: "managed-failure",
			ifname: "wwan0",
			sourceAddress: "100.64.1.2",
			mark,
			table: "30124",
			managed: true,
			sourceRulePriority: 100,
			defaultRouteArgv: [
				"route",
				"replace",
				"table",
				"30124",
				"default",
				"via",
				"100.64.1.1",
				"dev",
				"wwan0",
			],
		};
		const calls: string[][] = [];
		const h: UplinkRouteManagerDeps = {
			run: async (command, args) => {
				calls.push([command, ...args]);
				if (
					args[0] === "rule" &&
					args[1] === "add" &&
					args.includes("fwmark")
				) {
					throw new Error("fwmark refused");
				}
				return args[0] === "rule" && args[1] === "show"
					? "0: from all lookup local\n32766: from all lookup main\n"
					: "";
			},
		};

		await expect(ensureUplinkRoute(plan, h)).rejects.toMatchObject({
			reason: "policy_route_missing",
		});
		expect(calls).toContainEqual([
			"ip",
			"rule",
			"del",
			"priority",
			"100",
			"from",
			"100.64.1.2/32",
			"lookup",
			"30124",
		]);
		expect(calls[calls.length - 1]).toEqual([
			"ip",
			"route",
			"flush",
			"table",
			"30124",
		]);
	});

	test("recognizes and removes only the exact mark/table rule", async () => {
		const mark = stableUplinkMark("cellular-a");
		const plan: UplinkRoutePlan = {
			identity: "cellular-a",
			ifname: "wwan0",
			sourceAddress: "100.64.1.2",
			mark,
			table: "120",
			managed: false,
		};
		const output = `${FWMARK_RULE_PRIORITY}: from all fwmark ${hexMark(mark)}/0xffffff00 lookup 120\n`;
		expect(hasFwmarkRule(output, plan)).toBe(true);
		const h = scripted({ "ip rule show": output });

		await removeUplinkRoute(plan, h);
		expect(h.calls).toEqual([
			["ip", "rule", "show"],
			[
				"ip",
				"rule",
				"del",
				"priority",
				String(FWMARK_RULE_PRIORITY),
				"fwmark",
				`${hexMark(mark)}/0xffffff00`,
				"lookup",
				"120",
			],
		]);
	});

	test("tears down a managed source rule, fwmark rule, and private table", async () => {
		const mark = stableUplinkMark("managed-wwan");
		const plan: UplinkRoutePlan = {
			identity: "managed-wwan",
			ifname: "wwan0",
			sourceAddress: "100.64.1.2",
			mark,
			table: "30123",
			managed: true,
			sourceRulePriority: 100,
		};
		const output = `100: from 100.64.1.2 lookup 30123
${FWMARK_RULE_PRIORITY}: from all fwmark ${hexMark(mark)}/0xffffff00 lookup 30123
`;
		const h = scripted({ "ip rule show": output });

		await removeUplinkRoute(plan, h);

		expect(h.calls).toEqual([
			["ip", "rule", "show"],
			[
				"ip",
				"rule",
				"del",
				"priority",
				String(FWMARK_RULE_PRIORITY),
				"fwmark",
				`${hexMark(mark)}/0xffffff00`,
				"lookup",
				"30123",
			],
			[
				"ip",
				"rule",
				"del",
				"priority",
				"100",
				"from",
				"100.64.1.2/32",
				"lookup",
				"30123",
			],
			["ip", "route", "flush", "table", "30123"],
		]);
	});
});
