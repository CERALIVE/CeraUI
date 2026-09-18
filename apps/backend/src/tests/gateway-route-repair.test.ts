import { describe, expect, test } from "bun:test";
import { setDefaultRoute } from "../modules/network/gateways.ts";

const OLD = "default via 192.0.2.1 dev uplink-a metric 37";
const GOOD = "default via 198.51.100.1 dev uplink-b metric 83";

describe("host route application", () => {
	test("a successful repair retains other NIC defaults for a later failback", async () => {
		// Given: no legacy tables, and a runner modelling the main-table route set.
		const routes = new Set([OLD, GOOD]);
		const runner = async (_bin: string, args: string[]) => {
			if (args.includes("table")) throw new Error("no named table");
			if (args[1] === "show") return [...routes].join("\n");
			const route = args.slice(2).join(" ");
			if (args[1] === "del") routes.delete(route);
			else routes.add(route);
			return "";
		};
		// When: the preferred path changes in both directions.
		await setDefaultRoute("uplink-b", { runner });
		expect([...routes].some((route) => route.includes("dev uplink-a"))).toBe(
			true,
		);
		await setDefaultRoute("uplink-a", { runner });
		// Then: neither NIC loses the route needed by its next bound probe.
		expect([...routes].some((route) => route.includes("dev uplink-b"))).toBe(
			true,
		);
		expect(routes.size).toBe(2);
	});

	test("uses a candidate's main-table default without requiring a retired named table", async () => {
		// Given: DHCP provided both defaults, but no named routing tables.
		const calls: string[][] = [];
		const runner = async (_bin: string, args: string[]) => {
			calls.push(args);
			if (args.includes("table")) throw new Error("table id value is invalid");
			return args.includes("show") ? `${OLD}\n${GOOD}\n` : "";
		};
		// When: the HTTPS-working NIC is installed using the existing ip mechanism.
		await setDefaultRoute("uplink-b", { runner });
		// Then: its observed gateway/device/metric, not a fabricated route, is applied.
		expect(calls).toContainEqual(["route", "del", ...OLD.split(" ")]);
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
		expect(calls.every((args) => args[1] === "show")).toBe(true);
	});

	test("a failed demotion restores previous defaults and still rejects", async () => {
		// Given: a later delete fails after the first competing route was demoted.
		const other = "default via 203.0.113.1 dev uplink-c metric 51";
		const calls: string[][] = [];
		const runner = async (_bin: string, args: string[]) => {
			calls.push(args);
			if (args.includes("show")) return `${OLD}\n${other}\n${GOOD}\n`;
			if (args[1] === "del" && args[args.length - 1] === "51")
				throw new Error("injected route delete failure");
			return "";
		};
		// When: route application fails.
		await expect(setDefaultRoute("uplink-b", { runner })).rejects.toThrow();
		// Then: the failure stays visible and both prior defaults are restored.
		expect(calls).toContainEqual(["route", "add", ...OLD.split(" ")]);
		expect(calls).toContainEqual([
			"route",
			"del",
			...OLD.replace("37", "84").split(" "),
		]);
		expect(calls).toContainEqual([
			"route",
			"del",
			...other.replace("51", "85").split(" "),
		]);
		expect(calls).not.toContainEqual(["route", "del", ...GOOD.split(" ")]);
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
				return args.includes("show") ? `${route}\n${selected}` : "";
			},
		});
		// Then: every route operation is explicitly IPv6.
		expect(calls.every((args) => args[0] === "-6")).toBe(true);
		expect(calls).toContainEqual([
			"-6",
			"route",
			"add",
			...route.replace("37", "84").split(" "),
		]);
	});
});
