import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { GatewayRoutePreference } from "../modules/network/gateway-route-lifecycle.ts";
import { NaturalUplinkRecovery } from "../modules/network/natural-uplink-recovery.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";
import {
	kernelRouteRunner as run,
	setupKernelRoutes,
} from "./helpers/default-route-kernel.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_UNSUPPORTED_CHILD === "1";
const probe = child
	? undefined
	: await runTestCommand(["unshare", "-Urn", "true"]);
const unavailable = probe !== undefined && probe.code !== 0;

(unavailable ? test.skip : test)(
	unavailable
		? `unsupported failback shape: ${probe?.stderr}`
		: "unsupported foreign IPv6 disables failback without refusing a healthy IPv4 election",
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
				{ env: { CERALIVE_UNSUPPORTED_CHILD: "1" } },
			);
			expect(result.code, result.stdout + result.stderr).toBe(0);
			return;
		}
		// Given: a valid owned IPv4 preference alongside a real source-specific foreign IPv6 default.
		await setupKernelRoutes();
		await run("ip", [
			"route",
			"add",
			"default",
			"dev",
			"routea",
			"metric",
			"50",
		]);
		await run("ip", [
			"route",
			"add",
			"default",
			"dev",
			"routeb",
			"metric",
			"600",
		]);
		await run("ip", [
			"-6",
			"route",
			"add",
			"default",
			"from",
			"2001:db8::/64",
			"via",
			"fe80::1",
			"dev",
			"routea",
			"metric",
			"100",
		]);
		const controller = new GatewayRoutePreference(run);
		await controller.apply("routeb");
		const baseline = await run("ip", ["-6", "-N", "route", "show", "default"]);
		const recovery = new NaturalUplinkRecovery(run);
		// When: recovery cannot model the complete foreign inventory.
		const ready = await recovery.ready(
			[],
			{
				probeRepository: async () => deriveVerdict([]),
				probeViaDevice: async () => false,
				probeViaSourceIp: async () => false,
			},
			() => 1_000,
		);
		await controller.apply("routeb");
		// Then: recovery is withheld, but normal healthy-route maintenance still works.
		expect(ready).toBe(false);
		expect(
			await run("ip", ["-N", "route", "get", "203.0.113.254", "fibmatch"]),
		).toContain("dev routeb proto 242");
		expect(await run("ip", ["-6", "-N", "route", "show", "default"])).toBe(
			baseline,
		);
	},
	20_000,
);
