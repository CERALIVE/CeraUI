import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { GatewayRoutePreference } from "../modules/network/gateway-route-lifecycle.ts";
import {
	kernelRouteRunner as runner,
	setupKernelRoutes,
	waitForKernelLinkdown,
} from "./helpers/default-route-kernel.ts";
import { cleanupKernelScenarios } from "./helpers/default-route-kernel-cleanup.ts";
import { oracle4KernelScenarios } from "./helpers/default-route-kernel-oracle4.ts";
import { rollbackKernelScenarios } from "./helpers/default-route-kernel-rollback.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_ROUTE_KERNEL_CHILD === "1";
const probe = child
	? undefined
	: await runTestCommand(["unshare", "-Urn", "true"]);
const unavailable = probe !== undefined && probe.code !== 0;
const reason = `user/network namespace unavailable: ${probe?.stderr.trim()}`;
async function defaults(): Promise<string> {
	return runner("ip", ["-N", "route", "show", "default"]);
}

async function fib(): Promise<string> {
	return runner("ip", ["-N", "route", "get", "203.0.113.254", "fibmatch"]);
}

const scenarios: Readonly<Record<string, () => Promise<void>>> = {
	...rollbackKernelScenarios,
	...oracle4KernelScenarios,
	...cleanupKernelScenarios,
	"metric-zero FIB elections": async () => {
		// Given: two foreign defaults, one at the floor.
		await runner("ip", [
			"route",
			"add",
			"default",
			"via",
			"192.0.2.1",
			"dev",
			"routea",
			"proto",
			"16",
		]);
		await runner("ip", [
			"route",
			"add",
			"default",
			"via",
			"198.51.100.1",
			"dev",
			"routeb",
			"proto",
			"16",
			"metric",
			"83",
		]);
		const baseline = await defaults();
		const controller = new GatewayRoutePreference(runner);
		await controller.start();
		// When: acquire, re-elect, reorder with a foreign prepend, fail back, and release.
		await controller.apply("routeb");
		expect(await fib()).toMatch(/dev routeb proto 24[23]\b/);
		const applied = await defaults();
		await controller.apply("routeb");
		expect(await defaults()).toBe(applied);
		await runner("ip", [
			"route",
			"prepend",
			"default",
			"dev",
			"routea",
			"proto",
			"17",
		]);
		expect(await fib()).toMatch(/dev routea proto 17\b/);
		await controller.apply("routeb");
		expect(await fib()).toMatch(/dev routeb proto 24[23]\b/);
		await controller.apply("routea");
		expect(await fib()).toMatch(/dev routea proto 17\b/);
		expect(await defaults()).not.toContain("proto 242");
		await controller.apply("routeb");
		expect(await fib()).toMatch(/dev routeb proto 242\b/);
		await controller.stop();
		// Then: protocol-qualified deletion leaves all three foreign routes intact.
		const rows = await defaults();
		expect(rows).not.toContain("proto 242");
		for (const row of baseline.trim().split("\n")) expect(rows).toContain(row);
		expect(rows).toContain("default dev routea proto 17");
	},
	...Object.fromEntries(
		["failback", "startup", "shutdown"].map((action) => [
			`carrier-loss ${action}`,
			async () => {
				// Given: an owned default on a real veth loses carrier, not its address.
				await runner("ip", [
					"route",
					"add",
					"default",
					"via",
					"192.0.2.1",
					"dev",
					"routea",
					"proto",
					"16",
					"metric",
					"37",
				]);
				await runner("ip", [
					"route",
					"add",
					"default",
					"via",
					"198.51.100.1",
					"dev",
					"routeb",
					"proto",
					"16",
					"metric",
					"83",
				]);
				const controller = new GatewayRoutePreference(runner);
				await controller.start();
				await controller.apply("routeb");
				await runner("ip", ["link", "set", "peerb", "down"]);
				expect(await waitForKernelLinkdown(defaults)).toMatch(
					/proto 242.*linkdown/,
				);
				const foreign = (await defaults())
					.split("\n")
					.filter((row) => !row.includes("proto 242"))
					.join("\n");
				// When: a product lifecycle boundary removes the carrier-lost preference.
				switch (action) {
					case "failback":
						await controller.apply("routea");
						break;
					case "startup":
						await new GatewayRoutePreference(runner).start();
						break;
					case "shutdown":
						await controller.stop();
						break;
				}
				// Then: the kernel accepted cleanup and foreign rows remain identical.
				expect(await defaults()).toBe(foreign);
			},
		]),
	),
	...Object.fromEntries(
		["source-specific", "multipath"].map((shape) => [
			`foreign ${shape} cleanup`,
			async () => {
				// Given: a foreign IPv6 route shape unsupported for host election.
				const tail =
					shape === "source-specific"
						? [
								"from",
								"2001:db8::/64",
								"via",
								"fe80::1",
								"dev",
								"routea",
								"proto",
								"9",
								"metric",
								"1024",
							]
						: [
								"proto",
								"9",
								"metric",
								"1024",
								"nexthop",
								"via",
								"fe80::1",
								"dev",
								"routea",
								"weight",
								"1",
								"nexthop",
								"via",
								"fe80::2",
								"dev",
								"routeb",
								"weight",
								"1",
							];
				await runner("ip", ["-6", "route", "add", "default", ...tail]);
				const foreign = await runner("ip", [
					"-6",
					"-N",
					"route",
					"show",
					"default",
				]);
				const controller = new GatewayRoutePreference(runner);
				await runner("ip", [
					"route",
					"add",
					"default",
					"dev",
					"routeb",
					"proto",
					"242",
					"metric",
					"36",
				]);
				// When: startup sweeps and later shutdown releases another stale preference.
				await controller.start();
				expect(await defaults()).toBe("");
				await runner("ip", [
					"route",
					"add",
					"default",
					"dev",
					"routeb",
					"proto",
					"242",
					"metric",
					"36",
				]);
				await controller.stop();
				// Then: unsupported foreign routes blocked neither lifecycle boundary.
				expect(await defaults()).toBe("");
				expect(
					await runner("ip", ["-6", "-N", "route", "show", "default"]),
				).toBe(foreign);
			},
		]),
	),
};

describe("real kernel host preferences", () => {
	for (const [name, scenario] of Object.entries(scenarios)) {
		const title = unavailable ? `${name} (SKIP: ${reason})` : name;
		(unavailable ? test.skip : test)(
			title,
			async () => {
				if (child) {
					await setupKernelRoutes();
					await scenario();
					return;
				}
				const result = await runTestCommand(
					[
						"unshare",
						"-Urn",
						process.execPath,
						"test",
						fileURLToPath(import.meta.url),
						"--test-name-pattern",
						name,
					],
					{ env: { CERALIVE_ROUTE_KERNEL_CHILD: "1" } },
				);
				expect(result.code, result.stdout + result.stderr).toBe(0);
			},
			30_000,
		);
	}
});
