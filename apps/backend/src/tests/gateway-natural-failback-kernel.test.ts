import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parseDefaultRouteInterface } from "../modules/network/connectivity-candidates.ts";
import type { DefaultRouteReleaseCondition } from "../modules/network/default-route.ts";
import { GatewayRoutePreference } from "../modules/network/gateway-route-lifecycle.ts";
import {
	type GatewayElectionDeps,
	updateGw,
} from "../modules/network/gateways.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";
import {
	kernelRouteRunner as run,
	setupKernelRoutes,
} from "./helpers/default-route-kernel.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_FAILBACK_CHILD === "1";
const probe = child
	? undefined
	: await runTestCommand(["unshare", "-Urn", "true"]);
const unavailable = probe !== undefined && probe.code !== 0;

for (const scenario of [
	"recovered",
	"interrupted",
	"topology-change",
	"stale-gap",
	"rapid-checks",
	"final-clock",
	"final-topology",
] as const) {
	const name = `natural failback ${scenario}`;
	(unavailable ? test.skip : test)(
		unavailable ? `${name}: ${probe?.stderr}` : name,
		async () => {
			if (!child) {
				const result = await runTestCommand(
					[
						"unshare",
						"-Urn",
						process.execPath,
						"test",
						fileURLToPath(import.meta.url),
						"-t",
						`${name}$`,
					],
					{ env: { CERALIVE_FAILBACK_CHILD: "1" } },
				);
				expect(result.code, result.stdout + result.stderr).toBe(0);
				return;
			}
			// Given: real foreign defaults and an owned preference masking the natural route.
			await setupKernelRoutes();
			await run("ip", [
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
				"50",
			]);
			await run("ip", [
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
				"600",
			]);
			const controller = new GatewayRoutePreference(run);
			await controller.start();
			await controller.apply("routeb");
			let now = 1_000;
			let healthy = true;
			let clockReads = 0;
			const observed: string[] = [];
			const deps = {
				isRealDevice: async () => true,
				resolve: async () => ({ addrs: [], fromCache: true }),
				validateDns: () => {},
				checkConnectivity: async () => true,
				interfaces: () =>
					Object.fromEntries(
						["routea", "routeb"].map((name) => [
							name,
							{
								ip: name === "routea" ? "192.0.2.2" : "198.51.100.2",
								error: 0,
								enabled: true,
								tp: 0,
								txb: 0,
								rxb: 0,
							},
						]),
					),
				eligible: () => true,
				defaultInterface: async () =>
					parseDefaultRouteInterface(
						await run("ip", ["-N", "route", "show", "default"]),
					),
				installRoute: (name: string, family: 4 | 6) =>
					controller.apply(name, family),
				releaseRoutes: (condition?: DefaultRouteReleaseCondition) =>
					condition
						? controller.release(condition)
						: controller.apply(undefined),
				routeRunner: run,
				now: () => {
					clockReads++;
					return scenario === "final-clock" && clockReads === 4
						? now + 30_001
						: now;
				},
				probes: {
					probeRepository: async (name: string) => {
						observed.push(name);
						if (
							scenario === "final-topology" &&
							name === "routea" &&
							observed.filter((name) => name === "routea").length === 3
						)
							await run("ip", [
								"route",
								"change",
								"default",
								"via",
								"192.0.2.1",
								"dev",
								"routea",
								"proto",
								"16",
								"metric",
								"50",
								"src",
								"192.0.2.2",
							]);
						return deriveVerdict([
							{
								origin: {
									url: "https://repository.test",
									host: "repository.test",
									scheme: "https",
									probeUrl: "https://repository.test",
								},
								ipv4: name === "routea" && !healthy ? "blocked" : "ok",
								ipv6: "no_route",
							},
						]);
					},
					probeViaSourceIp: async () => false,
					probeViaDevice: async () => false,
				},
			} satisfies GatewayElectionDeps & {
				routeRunner: typeof run;
				now: () => number;
			};
			const foreign = async () =>
				(await run("ip", ["-N", "route", "show", "default"]))
					.split("\n")
					.filter((row) => !/proto 24[23]\b/.test(row))
					.join("\n");
			const baseline = await foreign();
			const rules = await run("ip", ["rule", "show"]);
			// When: completed observations cross the recovery threshold (or reset it).
			for (const timestamp of [1_000, 6_000]) {
				now = timestamp;
				expect(await updateGw(deps)).toBe(true);
				expect(await run("ip", ["-N", "route", "show", "default"])).toContain(
					"proto 242",
				);
			}
			if (scenario === "interrupted") {
				healthy = false;
				now = 8_000;
				await updateGw(deps);
				healthy = true;
			}
			if (scenario === "topology-change")
				await run("ip", [
					"route",
					"change",
					"default",
					"via",
					"192.0.2.1",
					"dev",
					"routea",
					"proto",
					"16",
					"metric",
					"50",
					"src",
					"192.0.2.2",
				]);
			now =
				scenario === "stale-gap"
					? 40_001
					: scenario === "rapid-checks"
						? 6_001
						: 11_000;
			expect(await updateGw(deps)).toBe(true);
			// Then: only continuous recovery releases; foreign defaults and rules are preserved.
			const released = scenario === "recovered";
			expect(
				(await run("ip", ["-N", "route", "show", "default"])).includes(
					"proto 242",
				),
			).toBe(!released);
			expect(
				observed.filter((name) => name === "routea").length,
			).toBeGreaterThanOrEqual(3);
			if (scenario !== "topology-change" && scenario !== "final-topology")
				expect(await foreign()).toBe(baseline);
			expect(await run("ip", ["rule", "show"])).toBe(rules);
			if (released) {
				expect(
					await run("ip", ["-N", "route", "get", "203.0.113.254", "fibmatch"]),
				).toContain("dev routea proto 16");
				const before = await run("ip", ["-N", "route", "show", "default"]);
				await controller.apply(undefined);
				expect(await run("ip", ["-N", "route", "show", "default"])).toBe(
					before,
				);
			}
		},
		30_000,
	);
}
