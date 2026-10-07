import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { ProbeCandidate } from "../modules/network/connectivity-candidates.ts";
import { GatewayRoutePreference } from "../modules/network/gateway-route-lifecycle.ts";
import { NaturalUplinkRecovery } from "../modules/network/natural-uplink-recovery.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";
import {
	kernelRouteRunner as run,
	setupKernelRoutes,
} from "./helpers/default-route-kernel.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_METADATA_CHILD === "1";
const probe = child
	? undefined
	: await runTestCommand(["unshare", "-Urn", "true"]);
const unavailable = probe !== undefined && probe.code !== 0;

(unavailable ? test.skip : test)(
	unavailable
		? `legacy route metadata: ${probe?.stderr}`
		: "legacy realm metadata cannot identify a recovered natural uplink",
	async () => {
		if (!child) {
			const result = await runTestCommand(
				[
					"unshare",
					"-Urn",
					process.execPath,
					"test",
					fileURLToPath(import.meta.url),
				],
				{ env: { CERALIVE_METADATA_CHILD: "1" } },
			);
			expect(result.code, result.stdout + result.stderr).toBe(0);
			return;
		}
		// Given: the same natural path across three healthy completed observations.
		await setupKernelRoutes();
		await run("ip", [
			"route",
			"add",
			"default",
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
			"dev",
			"routeb",
			"proto",
			"16",
			"metric",
			"600",
		]);
		await new GatewayRoutePreference(run).apply("routeb");
		const recovery = new NaturalUplinkRecovery(run);
		const candidates: readonly ProbeCandidate[] = [
			{
				name: "routea",
				ip: "192.0.2.2",
				binding: { kind: "device", ifname: "routea" },
			},
		];
		const probes = {
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
		};
		expect(await recovery.ready(candidates, probes, () => 1_000)).toBe(false);
		expect(await recovery.ready(candidates, probes, () => 6_000)).toBe(false);
		// When: only host-supported legacy display metadata changes, not gateway/device/protocol/metric.
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
			"realm",
			"7",
		]);
		const routes = await run("ip", ["-N", "route", "show", "default"]);
		expect(routes).toContain("realm 7");
		const ready = await recovery.ready(candidates, probes, () => 11_000);
		// Then: recovery still completes; observation did not modify the kernel inventory.
		expect(ready).toBe(true);
		expect(await run("ip", ["-N", "route", "show", "default"])).toBe(routes);
	},
	20_000,
);
