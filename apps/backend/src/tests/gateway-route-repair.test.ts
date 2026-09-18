import { describe, expect, test } from "bun:test";
import { setDefaultRoute } from "../modules/network/gateways.ts";

const OLD = "default via 192.0.2.1 dev uplink-a metric 37";
const GOOD = "default via 198.51.100.1 dev uplink-b metric 83";

describe("host route application", () => {
	test("uses a candidate's main-table default without requiring a retired named table", async () => {
		// Given: DHCP provided both defaults, but no named routing tables.
		const calls: string[][] = [];
		const runner = async (_bin: string, args: string[]) => {
			calls.push(args);
			if (args.includes("table")) throw new Error("table id value is invalid");
			return args.includes("show") ? `${OLD}\n${GOOD}\n` : "";
		};
		// When: the HTTPS-working NIC is installed using the existing ip mechanism.
		await setDefaultRoute("uplink-b", {
			runner,
			clearDefaultGws: async () => {},
		});
		// Then: its observed gateway/device/metric, not a fabricated route, is applied.
		expect(calls).toContainEqual(["route", "add", ...GOOD.split(" ")]);
		expect(calls.some((args) => args.includes("table"))).toBe(false);
	});

	test("an invalid route is rejected before clearing any working default", async () => {
		// Given: no valid route can be prepared.
		let clears = 0;
		// When: the discovered candidate route is malformed.
		await expect(
			setDefaultRoute("uplink-b", {
				runner: async () => "garbled route",
				clearDefaultGws: async () => {
					clears++;
				},
			}),
		).rejects.toThrow();
		// Then: the current uplink has not been removed.
		expect(clears).toBe(0);
	});

	test("a failed add restores previous defaults and still rejects", async () => {
		// Given: the chosen add fails after the previous routes were removed.
		const calls: string[][] = [];
		const runner = async (_bin: string, args: string[]) => {
			calls.push(args);
			if (args.includes("show")) return `${OLD}\n${GOOD}\n`;
			if (args[1] === "add") throw new Error("injected route add failure");
			return "";
		};
		// When: route application fails.
		await expect(
			setDefaultRoute("uplink-b", { runner, clearDefaultGws: async () => {} }),
		).rejects.toThrow();
		// Then: the failure stays visible and both prior defaults are restored.
		expect(calls).toContainEqual(["route", "replace", ...OLD.split(" ")]);
		expect(calls).toContainEqual(["route", "replace", ...GOOD.split(" ")]);
	});

	test("IPv6 repository success installs the IPv6 default, not an IPv4 route", async () => {
		// Given: the candidate reaches repositories only over IPv6.
		const route = "default via fe80::1 dev uplink-b metric 83";
		const calls: string[][] = [];
		// When: applying the election's chosen family.
		await setDefaultRoute("uplink-b", {
			family: 6,
			runner: async (_bin, args) => {
				calls.push(args);
				return args.includes("show") ? route : "";
			},
			clearDefaultGws: async () => {},
		});
		// Then: every route operation is explicitly IPv6.
		expect(calls.every((args) => args[0] === "-6")).toBe(true);
		expect(calls).toContainEqual(["-6", "route", "add", ...route.split(" ")]);
	});
});
