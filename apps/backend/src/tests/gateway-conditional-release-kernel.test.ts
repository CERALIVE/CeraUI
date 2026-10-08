import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { DefaultRouteReleaseCondition } from "../modules/network/default-route.ts";
import { GatewayRoutePreference } from "../modules/network/gateway-route-lifecycle.ts";
import {
	type GatewayElectionDeps,
	updateGw,
} from "../modules/network/gateways.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";
import { kernelRouteRunner as run } from "./helpers/default-route-kernel.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_CONDITIONAL_CHILD === "1";
const probe = child
	? undefined
	: await runTestCommand(["unshare", "-Urn", "true"]);
const unavailable = probe !== undefined && probe.code !== 0;
for (const scenario of [
	"carrier-loss",
	"queued-carrier-loss",
	"vanished",
	"changed",
	"expired",
] as const) {
	const name = `conditional natural release retains ownership after ${scenario}`;
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
					{ env: { CERALIVE_CONDITIONAL_CHILD: "1" } },
				);
				expect(result.code, result.stdout + result.stderr).toBe(0);
				return;
			}
			// Given: real natural and owned working paths, with recovery nearly ready.
			for (const [dev, peer, addr, metric] of [
				["routea", "peera", "192.0.2.2", "50"],
				["routeb", "peerb", "198.51.100.2", "600"],
			]) {
				if (!dev || !peer || !addr || !metric)
					throw new Error("incomplete fixture");
				await run("ip", [
					"link",
					"add",
					dev,
					"type",
					"veth",
					"peer",
					"name",
					peer,
				]);
				for (const link of [dev, peer])
					await run("ip", ["link", "set", link, "up"]);
				await run("ip", ["addr", "add", `${addr}/24`, "dev", dev]);
				await run("ip", [
					"route",
					"add",
					"default",
					"dev",
					dev,
					"proto",
					"16",
					"metric",
					metric,
				]);
			}
			let blockNext = false;
			const entered = Promise.withResolvers<void>();
			const drain = Promise.withResolvers<void>();
			const runner: typeof run = async (bin, args) => {
				if (blockNext && args.includes("-6")) {
					blockNext = false;
					entered.resolve();
					await drain.promise;
				}
				return run(bin, args);
			};
			const controller = new GatewayRoutePreference(runner);
			await controller.apply("routeb");
			let now = 1_000;
			let expectedRoutes = "";
			let releases = 0;
			const deps = {
				isRealDevice: async () => true,
				resolve: async () => ({ addrs: [], fromCache: true }),
				validateDns: () => {},
				checkConnectivity: async () => false,
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
				defaultInterface: async () => "routeb",
				installRoute: (name: string, family: 4 | 6) =>
					controller.apply(name, family),
				releaseRoutes: async (condition?: DefaultRouteReleaseCondition) => {
					releases++;
					let prior: Promise<void> | undefined;
					let queued: Promise<void> | undefined;
					if (scenario === "queued-carrier-loss") {
						blockNext = true;
						prior = controller.apply("routeb");
						await entered.promise;
						queued = condition
							? controller.release(condition)
							: controller.apply(undefined);
						for (let turn = 0; turn < 16; turn++) await Promise.resolve();
					}
					switch (scenario) {
						case "carrier-loss":
						case "queued-carrier-loss":
							await run("ip", ["link", "set", "peera", "down"]);
							for (let turn = 0; turn < 100; turn++) {
								if (
									(
										await run("ip", ["-N", "route", "show", "default"])
									).includes("metric 50 linkdown")
								)
									break;
							}
							expect(
								await run("ip", ["-N", "route", "show", "default"]),
							).toContain("metric 50 linkdown");
							break;
						case "vanished":
							await run("ip", [
								"route",
								"del",
								"default",
								"dev",
								"routea",
								"metric",
								"50",
							]);
							break;
						case "changed":
							await run("ip", [
								"route",
								"change",
								"default",
								"dev",
								"routea",
								"proto",
								"16",
								"metric",
								"50",
								"src",
								"192.0.2.2",
							]);
							break;
						case "expired":
							now += 30_001;
							break;
						default:
							scenario satisfies never;
					}
					expectedRoutes = await run("ip", ["-N", "route", "show", "default"]);
					drain.resolve();
					await prior;
					if (queued) await queued;
					else if (condition) await controller.release(condition);
					else await controller.apply(undefined);
				},
				routeRunner: runner,
				now: () => now,
				probes: {
					probeRepository: async () =>
						deriveVerdict([
							{
								origin: {
									url: "https://repository.test",
									host: "repository.test",
									scheme: "https",
									probeUrl: "https://repository.test",
								},
								ipv4: "ok",
								ipv6: "no_route",
							},
						]),
					probeViaDevice: async () => false,
					probeViaSourceIp: async () => false,
				},
			} satisfies GatewayElectionDeps;
			await updateGw(deps);
			now = 6_000;
			await updateGw(deps);
			now = 11_000;
			const rules = await run("ip", ["rule", "show"]);
			// When: the natural path changes after readiness, before the writer's inventory.
			const result = await updateGw(deps);
			// Then: the working owned FIB survives, no route is edited, and retry is armed.
			expect(
				await run("ip", ["-N", "route", "get", "203.0.113.254", "fibmatch"]),
			).toContain("dev routeb proto 242");
			expect(await run("ip", ["-N", "route", "show", "default"])).toBe(
				expectedRoutes,
			);
			expect(await run("ip", ["rule", "show"])).toBe(rules);
			expect(result).toBe(false);
			expect(releases).toBe(1);
			if (scenario === "carrier-loss") {
				await run("ip", ["link", "set", "peera", "up"]);
				now++;
				await updateGw(deps);
				expect(releases).toBe(1);
				expect(await run("ip", ["-N", "route", "show", "default"])).toContain(
					"proto 242",
				);
			}
		},
		30_000,
	);
}
