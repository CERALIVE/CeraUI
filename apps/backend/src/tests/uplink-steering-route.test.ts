import { describe, expect, test } from "bun:test";
import { RunTimeoutError } from "../helpers/run.ts";

import type { UplinkRoutePlan } from "../modules/network/uplink-steering/applier.ts";
import {
	ensureUplinkRoute,
	planUplinkRoute,
	rollbackUplinkRoute,
	type UplinkRouteManagerDeps,
} from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import {
	absentTableError,
	scripted,
} from "./uplink-steering-route-test-fixtures.ts";

describe("uplink steering route planning", () => {
	test("#433 provisions a never-created table before adding its rules", async () => {
		const h = scripted({
			"ip rule show": "0: from all lookup local\n32766: from all lookup main\n",
			"ip -4 route show default dev ww0": "default via 10.64.0.1",
		});
		const plan = await planUplinkRoute(
			{
				identity: "cellular-cold",
				ifname: "ww0",
				sourceAddress: "10.64.0.2",
				sourceAddressUnique: true,
				mark: 0xca000100,
			},
			h,
		);
		expect(await ensureUplinkRoute(plan, h)).toMatchObject({
			changed: true,
			createdTableRoute: true,
			createdSourceRule: true,
			createdFwmarkRule: true,
		});
		expect(h.calls.slice(-3).map((call) => call.slice(1, 3))).toEqual([
			["route", "replace"],
			["rule", "add"],
			["rule", "add"],
		]);
	});

	test("#433 replans a ww uplink whose source-rule table never existed", async () => {
		const plan = await planUplinkRoute(
			{
				identity: "cellular-stale-rule",
				ifname: "ww0",
				sourceAddress: "10.64.0.2",
				sourceAddressUnique: true,
				mark: 0xca000100,
			},
			scripted({
				"ip rule show": "100: from 10.64.0.2 lookup 123\n",
				"ip -4 route show default dev ww0": "default via 10.64.0.1",
			}),
		);
		expect(plan).toMatchObject({ table: "30001", managed: true });
		expect(plan.sourceRulePriority).toBeUndefined();
	});

	test.each([
		Object.assign(absentTableError(), {
			stderr: "Error: Operation not permitted\n",
		}),
		Object.assign(absentTableError(), { stderr: "Error: invalid table ID\n" }),
		Object.assign(absentTableError(), { code: 1 }),
		Object.assign(absentTableError(), { stdout: "default dev ww9\n" }),
		Object.assign(new Error("FIB table does not exist"), {
			code: 2,
			stdout: "",
			stderr: "",
		}),
		new RunTimeoutError("ip route show table 123", "", ""),
	])("#433 preserves unknown read failures %#", async (error) => {
		const h: UplinkRouteManagerDeps = {
			run: async (_bin, args) => {
				if (args[0] === "rule") return "100: from 10.64.0.2 lookup 123\n";
				throw error;
			},
		};
		await expect(
			planUplinkRoute(
				{
					identity: "cellular-error",
					ifname: "ww0",
					sourceAddress: "10.64.0.2",
					sourceAddressUnique: true,
					mark: 0xca000100,
				},
				h,
			),
		).rejects.toMatchObject({ reason: "policy_route_missing" });
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

	test("provisions a wlan1 table when no source rule exists", async () => {
		const h = scripted({
			"ip rule show": "0: from all lookup local\n32766: from all lookup main\n",
			"ip -4 route show default dev wlan1":
				"default via 192.168.1.1 proto dhcp src 192.168.1.50 metric 600",
		});

		const plan = await planUplinkRoute(
			{
				identity: "wifi-a",
				ifname: "wlan1",
				sourceAddress: "192.168.1.50",
				sourceAddressUnique: true,
				mark: 0xca000100,
			},
			h,
		);

		expect(plan).toMatchObject({
			managed: true,
			table: "30001",
			sourceRulePriority: 100,
		});
		expect(plan.defaultRouteArgv).toEqual([
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
		]);
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

describe("managed uplink default route refresh", () => {
	const plan: UplinkRoutePlan = {
		identity: "cellular-refresh",
		ifname: "wwan0",
		sourceAddress: "10.0.0.2",
		mark: 0xca000100,
		table: "30001",
		managed: true,
		sourceRulePriority: 100,
		defaultRouteArgv: [
			"route",
			"replace",
			"table",
			"30001",
			"default",
			"via",
			"10.0.0.9",
			"dev",
			"wwan0",
		],
	};
	const rules = [
		"100: from 10.0.0.2 lookup 30001",
		"110: from all fwmark 0xca000100/0xffffff00 lookup 30001",
		"110: from all fwmark 0xca000200/0xffffff00 lookup 30002",
	].join("\n");

	test.each([
		["gateway", "default via 10.0.0.1 dev wwan0"],
		["metric", "default via 10.0.0.9 dev wwan0 metric 600"],
		["protocol", "default via 10.0.0.9 dev wwan0 proto dhcp"],
		["gateway added", "default dev wwan0"],
	])(
		"replaces a same-device route after a %s change",
		async (_field, current) => {
			const h = scripted({
				"ip rule show": rules,
				"ip route show table 30001": `${current}\n`,
			});

			const provisioning = await ensureUplinkRoute(plan, h);

			expect(h.calls).toEqual([
				["ip", "rule", "show"],
				["ip", "route", "show", "table", "30001"],
				["ip", ...(plan.defaultRouteArgv ?? [])],
			]);
			expect(provisioning).toMatchObject({
				changed: true,
				createdTableRoute: false,
				createdSourceRule: false,
				createdFwmarkRule: false,
				replacedTableRoute: [
					"route",
					"replace",
					"table",
					"30001",
					...current.split(" "),
				],
			});
		},
	);

	test("rollback restores the previous gateway and route attributes without flushing", async () => {
		const current =
			"default via 10.0.0.1 dev wwan0 proto dhcp src 10.0.0.2 metric 600 onlink";
		const h = scripted({
			"ip rule show": rules,
			"ip route show table 30001": `${current}\n`,
		});
		const provisioning = await ensureUplinkRoute(plan, h);
		h.calls.length = 0;

		await rollbackUplinkRoute(provisioning, h);

		expect(h.calls).toEqual([
			["ip", "route", "replace", "table", "30001", ...current.split(" ")],
		]);
	});

	test.each([
		"default via 10.0.0.9 dev wwan0",
		"default dev wwan0 via 10.0.0.9",
	])("leaves an identical route unchanged: %s", async (current) => {
		const h = scripted({
			"ip rule show": rules,
			"ip route show table 30001": `${current}\n`,
		});

		const provisioning = await ensureUplinkRoute(plan, h);

		expect(provisioning.changed).toBe(false);
		expect(provisioning.replacedTableRoute).toBeUndefined();
		expect(h.calls).toEqual([
			["ip", "rule", "show"],
			["ip", "route", "show", "table", "30001"],
		]);
	});

	test("restores a replaced route when a later rule installation fails", async () => {
		const current = "default via 10.0.0.1 dev wwan0";
		const h = scripted({
			"ip rule show": "",
			"ip route show table 30001": `${current}\n`,
		});
		const deps: UplinkRouteManagerDeps = {
			run: async (command, args, ...rest) => {
				const result = await h.run(command, args, ...rest);
				if (args.includes("fwmark")) throw new Error("fwmark refused");
				return result;
			},
		};

		await expect(ensureUplinkRoute(plan, deps)).rejects.toMatchObject({
			reason: "policy_route_missing",
		});

		expect(h.calls.at(-1)).toEqual([
			"ip",
			"route",
			"replace",
			"table",
			"30001",
			...current.split(" "),
		]);
		expect(h.calls.some((call) => call.includes("flush"))).toBe(false);
	});
});
