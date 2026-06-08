/*
 * Tests for the gateways.ts `ip route` argv migration (Task 10).
 *
 * Security property under test: the gateway line discovered by
 * `ip route show ... default` is tokenized into SEPARATE argv elements before
 * reaching the runner — it is never re-interpolated as a single shell string.
 * The interface name is validated against the ifname charset (ID_RE).
 */

import { describe, expect, mock, test } from "bun:test";

import {
	buildRouteAddArgv,
	setDefaultRoute,
} from "../modules/network/gateways.ts";

describe("buildRouteAddArgv — gateway line tokenization", () => {
	test("splits a default-route line into separate argv elements", () => {
		const gw = "default via 192.168.1.1 dev eth0\n";

		expect(buildRouteAddArgv(gw)).toEqual([
			"route",
			"add",
			"default",
			"via",
			"192.168.1.1",
			"dev",
			"eth0",
		]);
	});

	test("collapses extra whitespace and never yields one shell string", () => {
		const gw = "  default   via 10.0.0.1   dev   wwan0  \n";
		const argv = buildRouteAddArgv(gw);

		expect(argv).toEqual([
			"route",
			"add",
			"default",
			"via",
			"10.0.0.1",
			"dev",
			"wwan0",
		]);
		// No element is the whole re-interpolated route string.
		expect(argv).not.toContain("default via 10.0.0.1 dev wwan0");
		for (const token of argv) {
			expect(token).not.toContain(" ");
		}
	});
});

describe("setDefaultRoute — argv-only add path", () => {
	test("passes tokenized argv to run() for both show and add, in order", async () => {
		const calls: Array<[string, string[]]> = [];
		const runner = mock(async (bin: string, args: string[]) => {
			calls.push([bin, args]);
			if (args[0] === "route" && args[1] === "show") {
				return "default via 10.0.0.1 dev wwan0\n";
			}
			return "";
		});

		await setDefaultRoute("wwan0", {
			runner: runner as never,
			clearDefaultGws: async () => {},
		});

		expect(calls[0]?.[0]).toBe("ip");
		expect(calls[0]?.[1]).toEqual([
			"route",
			"show",
			"table",
			"wwan0",
			"default",
		]);

		const add = calls.find((c) => c[1][0] === "route" && c[1][1] === "add");
		expect(add?.[0]).toBe("ip");
		expect(add?.[1]).toEqual([
			"route",
			"add",
			"default",
			"via",
			"10.0.0.1",
			"dev",
			"wwan0",
		]);
		// The gateway never reaches the runner as a single shell string.
		expect(add?.[1]).not.toContain("default via 10.0.0.1 dev wwan0");
	});

	test("clears existing default routes before adding the new one", async () => {
		const order: string[] = [];
		const runner = mock(async (_bin: string, args: string[]) => {
			if (args[1] === "add") order.push("add");
			return args[0] === "route" && args[1] === "show"
				? "default via 10.0.0.1 dev wwan0\n"
				: "";
		});
		const clearDefaultGws = mock(async () => {
			order.push("clear");
		});

		await setDefaultRoute("wwan0", {
			runner: runner as never,
			clearDefaultGws,
		});

		expect(order).toEqual(["clear", "add"]);
	});

	test("rejects an interface name outside the ifname charset", async () => {
		const runner = mock(async () => "");

		await expect(
			setDefaultRoute("eth0; reboot", { runner: runner as never }),
		).rejects.toThrow("invalid argument");
		expect(runner).not.toHaveBeenCalled();
	});

	test("rejects a leading-dash interface name (flag injection)", async () => {
		const runner = mock(async () => "");

		await expect(
			setDefaultRoute("-rf", { runner: runner as never }),
		).rejects.toThrow("invalid argument");
		expect(runner).not.toHaveBeenCalled();
	});
});
