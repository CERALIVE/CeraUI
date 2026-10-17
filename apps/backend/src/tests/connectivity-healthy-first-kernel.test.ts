import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { ProbeCandidate } from "../modules/network/connectivity-candidates.ts";
import { electConnectivityCandidate } from "../modules/network/connectivity-election.ts";
import {
	defaultAptReachabilityDeps,
	deriveVerdict,
	probeAptReachability,
} from "../modules/system/apt-reachability.ts";
import { kernelRouteRunner as run } from "./helpers/default-route-kernel.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_HEALTHY_FIRST_CHILD === "1";
const probe = child
	? undefined
	: await runTestCommand(["unshare", "-Urn", "true"]);
const unavailable = probe !== undefined && probe.code !== 0;
(unavailable ? test.skip : test)(
	unavailable
		? `healthy-first metered counters: ${probe?.stderr}`
		: "healthy-first success sends no probe packets on metered siblings",
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
				{ env: { CERALIVE_HEALTHY_FIRST_CHILD: "1" } },
			);
			expect(result.code, result.stdout + result.stderr).toBe(0);
			console.info(result.stdout.trim());
			return;
		}
		// Given: a working default beside real HiLink/FM350-shaped metered interfaces.
		const names = ["eth0", "wlan0", "hilink", "fm350", "other"];
		await run("nft", ["add", "table", "inet", "q5"]);
		await run("nft", [
			"add",
			"chain",
			"inet",
			"q5",
			"output",
			"{ type filter hook output priority 0; }",
		]);
		for (const [index, name] of names.entries()) {
			await run("ip", ["link", "add", name, "type", "dummy"]);
			await run("ip", ["link", "set", name, "up"]);
			await run("ip", ["addr", "add", `192.0.${index}.2/24`, "dev", name]);
			await run("ip", [
				"route",
				"add",
				"default",
				"dev",
				name,
				"metric",
				String(50 + index),
			]);
			await run("nft", ["add", "counter", "inet", "q5", name]);
			await run("nft", [
				"add",
				"rule",
				"inet",
				"q5",
				"output",
				"oifname",
				name,
				"ip",
				"daddr",
				"203.0.113.10",
				"counter",
				"name",
				name,
			]);
		}
		const routes = await run("ip", ["-N", "route", "show", "table", "all"]);
		const rules = await run("ip", ["rule", "show"]);
		const candidates = names.map((name) => ({
			name,
			ip: "192.0.2.2",
			binding: { kind: "device", ifname: name },
		})) satisfies readonly ProbeCandidate[];
		const started: string[] = [];
		// When: the production election sees a repository-healthy first candidate.
		const result = await electConnectivityCandidate([], candidates, {
			probeRepository: async (ifname) => {
				started.push(ifname);
				if (ifname === "eth0")
					return deriveVerdict([
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
					]);
				return probeAptReachability({
					...defaultAptReachabilityDeps,
					ifname,
					readSources: async () =>
						"URIs: https://203.0.113.10/repo\nSuites: stable",
				});
			},
			probeViaDevice: async () => false,
			probeViaSourceIp: async () => false,
		});
		// Then: no speculative cellular traffic or routing effect occurs.
		expect(result.elected?.name).toBe("eth0");
		for (const name of ["hilink", "fm350"]) {
			const counter = await run("nft", ["list", "counter", "inet", "q5", name]);
			console.info(counter.trim());
			expect(counter).toMatch(/packets 0 bytes 0/);
		}
		expect(started).toEqual(["eth0"]);
		expect(await run("ip", ["-N", "route", "show", "table", "all"])).toBe(
			routes,
		);
		expect(await run("ip", ["rule", "show"])).toBe(rules);
	},
	20_000,
);
