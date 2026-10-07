import { describe, expect, test } from "bun:test";
import { HOST_ROUTE_PROTOCOL } from "../modules/network/default-route.ts";
import { setDefaultRoute } from "../modules/network/gateways.ts";
import { DefaultRouteTable } from "./helpers/default-route-table.ts";

const OLD = "default via 192.0.2.1 dev uplink-a metric 37";
const GOOD = "default via 198.51.100.1 dev uplink-b metric 83";

describe("host route application", () => {
	test("a successful repair retains other NIC defaults for a later failback", async () => {
		// Given: no legacy tables, and a runner modelling the main-table route set.
		const table = new DefaultRouteTable([OLD, GOOD]);
		const runner = table.runner;
		// When: the preferred path changes in both directions.
		await setDefaultRoute("uplink-b", { runner });
		expect(table.rows()).toContain(OLD);
		await setDefaultRoute("uplink-a", { runner });
		// Then: neither NIC loses the route needed by its next bound probe.
		expect(table.rows()).toEqual([OLD, GOOD].sort());
	});

	test("uses a candidate's main-table default without requiring a retired named table", async () => {
		// Given: DHCP provided both defaults, but no named routing tables.
		const calls: string[][] = [];
		const runner = async (_bin: string, args: string[]) => {
			calls.push(args);
			if (args.includes("table")) throw new Error("table id value is invalid");
			return args[args.indexOf("route") + 1] === "show" && !args.includes("-6")
				? `${OLD}\n${GOOD}\n`
				: "";
		};
		// When: the HTTPS-working NIC is installed using the existing ip mechanism.
		await setDefaultRoute("uplink-b", { runner });
		// Then: its observed gateway/device/metric, not a fabricated route, is applied.
		expect(calls.filter((args) => args.includes("del"))).toEqual([]);
		expect(calls).toContainEqual([
			"route",
			"add",
			"default",
			"via",
			"198.51.100.1",
			"dev",
			"uplink-b",
			"proto",
			HOST_ROUTE_PROTOCOL,
			"metric",
			"36",
		]);
		expect(calls).not.toContainEqual(["route", "del", ...GOOD.split(" ")]);
		expect(calls.some((args) => args.includes("table"))).toBe(false);
	});

	test("an invalid route is rejected before clearing any working default", async () => {
		// Given: no valid route can be prepared.
		const calls: string[][] = [];
		// When: the discovered candidate route is malformed.
		await expect(
			setDefaultRoute("uplink-b", {
				runner: async (_bin, args) => {
					calls.push(args);
					return "garbled route";
				},
			}),
		).rejects.toThrow();
		// Then: the current uplink has not been removed.
		expect(
			calls.every((args) => args[args.indexOf("route") + 1] === "show"),
		).toBe(true);
	});

	test("a failed preference change restores previous defaults and still rejects", async () => {
		// Given: retirement will fail after the distinct replacement is staged.
		const owned = `default via 203.0.113.1 dev uplink-c proto ${HOST_ROUTE_PROTOCOL} metric 36`;
		const table = new DefaultRouteTable([OLD, GOOD, owned]);
		const before = table.orderedRows();
		table.failMutation = 2;
		// When: route application fails.
		await expect(
			setDefaultRoute("uplink-b", { runner: table.runner }),
		).rejects.toThrow();
		// Then: the failure stays visible and both prior defaults are restored.
		expect(table.rows()).toEqual([OLD, GOOD, owned].sort());
		expect(table.orderedRows()).toEqual(before);
		expect(table.mutations).not.toContainEqual([
			"route",
			"del",
			...GOOD.split(" "),
		]);
	});

	test("IPv6 repository success installs the IPv6 default, not an IPv4 route", async () => {
		// Given: the candidate reaches repositories only over IPv6.
		const route = "default via fe80::1 dev uplink-a metric 37";
		const selected = "default via fe80::2 dev uplink-b metric 83";
		const calls: string[][] = [];
		// When: applying the election's chosen family.
		await setDefaultRoute("uplink-b", {
			family: 6,
			runner: async (_bin, args) => {
				calls.push(args);
				return args[args.indexOf("route") + 1] === "show" && args.includes("-6")
					? `${route}\n${selected}`
					: "";
			},
		});
		// Then: every route operation is explicitly IPv6.
		expect(
			calls
				.filter((args) => args[args.indexOf("route") + 1] !== "show")
				.every((args) => args[0] === "-6"),
		).toBe(true);
		expect(
			calls.filter((args) => args[args.indexOf("route") + 1] === "show"),
		).toEqual([
			["-N", "route", "show", "default"],
			["-6", "-N", "route", "show", "default"],
		]);
		expect(calls).toContainEqual([
			"-6",
			"route",
			"add",
			"default",
			"via",
			"fe80::2",
			"dev",
			"uplink-b",
			"proto",
			HOST_ROUTE_PROTOCOL,
			"metric",
			"36",
		]);
	});
});
