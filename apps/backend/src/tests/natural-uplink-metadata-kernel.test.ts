import { afterAll, expect, test } from "bun:test";
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

const ready = Promise.withResolvers<void>();
const proc =
	!child && !unavailable
		? Bun.spawn(
				[
					"unshare",
					"-Urn",
					process.execPath,
					"test",
					fileURLToPath(import.meta.url),
				],
				{
					env: { ...process.env, CERALIVE_METADATA_CHILD: "1" },
					stdout: "pipe",
					stderr: "pipe",
					ipc(message: unknown) {
						if (message === "ready") ready.resolve();
					},
					onExit(_child, code, signal, error) {
						ready.reject(
							error ??
								new TypeError(
									`metadata child exited before readiness: ${code}/${signal}`,
								),
						);
					},
				},
			)
		: undefined;
const result = proc
	? Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		])
	: undefined;
if (proc) {
	afterAll(async () => {
		proc.kill();
		await proc.exited;
	});
	// Measured child import/setup took 36.9 s; only the operation spends the 20 s guard.
	await ready.promise;
}

let realmSupported = true;
if (child) {
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
		"realm",
		"7",
	]);
	realmSupported = (
		await run("ip", ["-N", "route", "show", "default"])
	).includes("realm 7");
	await run("ip", [
		"route",
		"del",
		"default",
		"dev",
		"routea",
		"proto",
		"16",
		"metric",
		"50",
	]);
	if (!realmSupported)
		console.warn(
			"SKIP legacy realm capability: kernel erased realm 7 (CONFIG_IP_ROUTE_CLASSID unsupported)",
		);
	if (!process.send || !process.disconnect)
		throw new TypeError("missing metadata fixture IPC");
	const release = Promise.withResolvers<void>();
	process.once("message", (message: unknown) => {
		if (message === "run") release.resolve();
		else release.reject(new TypeError("invalid metadata fixture request"));
	});
	process.send("ready");
	await release.promise;
	process.disconnect();
}

(unavailable || !realmSupported ? test.skip : test)(
	unavailable
		? `legacy route metadata: ${probe?.stderr}`
		: !realmSupported
			? "legacy realm capability: kernel erases realm/classid"
			: "legacy realm metadata cannot identify a recovered natural uplink",
	async () => {
		if (!child) {
			if (!proc || !result) throw new TypeError("missing metadata child");
			await using operation = proc;
			operation.send("run");
			const [stdout, stderr, code] = await result;
			expect(code, stdout + stderr).toBe(0);
			console.info(stdout + stderr);
			return;
		}
		// Given: the same natural path across three healthy completed observations.
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
