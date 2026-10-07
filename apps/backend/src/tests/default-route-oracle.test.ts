import { describe, expect, test } from "bun:test";
import type { run } from "../helpers/run.ts";
import { setDefaultRoute } from "../modules/network/default-route.ts";
import { GatewayRoutePreference } from "../modules/network/gateway-route-lifecycle.ts";
import { DefaultRouteTable } from "./helpers/default-route-table.ts";

const BASE = [
	"default via 192.0.2.1 dev routea proto 16 metric 37",
	"default via 198.51.100.1 dev routeb proto 16 metric 83",
] as const;
const OWNED = "default via 198.51.100.1 dev routeb proto 242 metric 36";
const FOREIGN = [
	"default from 2001:db8::/64 via fe80::1 dev routea proto 9 metric 1024 pref medium",
	"default proto 9 metric 1024 pref medium\n\tnexthop via fe80::1 dev routea weight 1\n\tnexthop via fe80::2 dev routeb weight 1",
] as const;

describe("oracle owned-route regressions", () => {
	for (const action of ["failback", "startup", "shutdown"] as const) {
		test(`removes a linkdown preference on ${action}`, async () => {
			// Given: carrier loss changes the kernel's display, not the route identity.
			const table = new DefaultRouteTable(BASE);
			const controller = new GatewayRoutePreference(table.runner);
			await controller.start();
			table.routes.get(4)?.add(`${OWNED} linkdown dead`);
			// When: the relevant lifecycle boundary releases that preference.
			switch (action) {
				case "failback":
					await controller.apply("routea");
					break;
				case "startup":
					await new GatewayRoutePreference(table.runner).start();
					break;
				case "shutdown":
					await controller.stop();
					break;
			}
			// Then: foreign baseline survives without the dead preference.
			expect(table.rows()).toEqual([...BASE].sort());
		});
	}

	test("rollback re-adds supported attributes without runtime display flags", async () => {
		// Given: a later retirement fails after removing a carrier-lost preference.
		const stale = OWNED.replace("36", "35");
		const table = new DefaultRouteTable(
			[...BASE, `${stale} linkdown`],
			["default dev stale6 proto 242 metric 35"],
		);
		table.failMutation = 3;
		// When: the transaction unwinds.
		await expect(
			setDefaultRoute("routeb", { runner: table.runner }),
		).rejects.toMatchObject({ reason: "apply-failed" });
		// Then: ownership is restored; no mutation attempted to set a runtime flag.
		expect(table.rows()).toContain(stale);
		expect(table.mutations.every((args) => !args.includes("linkdown"))).toBe(
			true,
		);
	});

	for (const foreign of FOREIGN) {
		for (const action of ["startup", "shutdown"] as const) {
			test(`${action} ignores foreign unsupported shape ${foreign.split("\n")[0]}`, async () => {
				// Given: an unrelated source-specific/multipath IPv6 default.
				const table = new DefaultRouteTable(BASE, [foreign]);
				const controller = new GatewayRoutePreference(table.runner);
				await controller.start();
				table.routes.get(4)?.add(OWNED);
				// When: cleanup runs, independently of candidate acquisition.
				if (action === "startup")
					await new GatewayRoutePreference(table.runner).start();
				else await controller.stop();
				// Then: only the marked route is removed.
				expect([table.rows(), table.rows(6)]).toEqual([
					[...BASE].sort(),
					[foreign],
				]);
			});
		}
	}

	test("election still refuses a source-specific competitor in the selected family", async () => {
		// Given: cleanup can inventory ownership but this election cannot model the competitor.
		const table = new DefaultRouteTable(BASE, [
			FOREIGN[0],
			"default dev routeb proto 9 metric 2048",
		]);
		// When: the unsupported family is elected.
		await expect(
			setDefaultRoute("routeb", { runner: table.runner, family: 6 }),
		).rejects.toMatchObject({ reason: "invalid-route" });
		// Then: refusal occurs before any mutation.
		expect(table.mutations).toEqual([]);
	});

	test("IPv4 metric-zero election prepends, retains only while winning, and fails back", async () => {
		// Given: an excluded DHCP competitor is at the IPv4 floor.
		const floor = BASE[0].replace("37", "0");
		const table = new DefaultRouteTable([floor, BASE[1]]);
		// When: routeb wins, stays elected, then loses equal-metric order to a renewal.
		await setDefaultRoute("routeb", { runner: table.runner });
		expect(table.mutations[0]?.[1]).toBe("prepend");
		expect(
			await table.runner("ip", [
				"-N",
				"route",
				"get",
				"203.0.113.254",
				"fibmatch",
			]),
		).toContain("dev routeb proto 242 metric 0 realm 1");
		table.mutations.length = 0;
		await setDefaultRoute("routeb", { runner: table.runner });
		expect(table.mutations).toEqual([]);
		const rows = table.routes.get(4);
		const previous = [...(rows ?? [])];
		rows?.clear();
		rows?.add("default dev renewed proto 16 metric 0");
		for (const row of previous) rows?.add(row);
		await setDefaultRoute("routeb", { runner: table.runner });
		expect(table.mutations.map((args) => args[1])).toEqual(["prepend", "del"]);
		expect(
			await table.runner("ip", ["route", "get", "203.0.113.254", "fibmatch"]),
		).toContain("realm 2");
		expect(
			await table.runner("ip", ["route", "get", "203.0.113.254", "fibmatch"]),
		).toContain("dev routeb");
		await setDefaultRoute("routea", { runner: table.runner });
		expect(
			await table.runner("ip", ["route", "get", "203.0.113.254", "fibmatch"]),
		).toContain("dev routea");
		await setDefaultRoute(undefined, { runner: table.runner });
		// Then: even equal-floor failback/re-election preserved every foreign route.
		expect(table.rows()).toEqual(
			[floor, BASE[1], "default dev renewed proto 16 metric 0"].sort(),
		);
	});

	test("a successful prepend acknowledgement cannot replace FIB winner proof", async () => {
		// Given: a runner acknowledging writes without realizing the elected route.
		const table = new DefaultRouteTable([BASE[0].replace("37", "0"), BASE[1]]);
		const runner: typeof run = (bin, args, opts) =>
			args[args.indexOf("route") + 1] === "get"
				? Promise.resolve(BASE[0].replace("37", "0"))
				: table.runner(bin, args, opts);
		// When: acquisition observes the wrong FIB winner.
		await expect(setDefaultRoute("routeb", { runner })).rejects.toMatchObject({
			reason: "apply-failed",
		});
		// Then: the unproven newly acquired preference is unwound.
		expect(table.rows()).toEqual([BASE[0].replace("37", "0"), BASE[1]].sort());
	});
});
