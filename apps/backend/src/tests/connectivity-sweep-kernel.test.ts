import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { ProbeCandidate } from "../modules/network/connectivity-candidates.ts";
import { electConnectivityCandidate } from "../modules/network/connectivity-election.ts";
import {
	checkConnectivityViaDevice,
	defaultDeviceBoundProbeDeps,
} from "../modules/network/device-bound-probe.ts";
import {
	defaultAptReachabilityDeps,
	probeAptReachability,
} from "../modules/system/apt-reachability.ts";
import { kernelRouteRunner as run } from "./helpers/default-route-kernel.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_SWEEP_CHILD === "1";
const probe = child
	? undefined
	: await runTestCommand(["unshare", "-Urn", "true"]);
const unavailable = probe !== undefined && probe.code !== 0;

(unavailable ? test.skip : test)(
	unavailable
		? `five blackholed kernel uplinks: ${probe?.stderr}`
		: "five blackholed kernel uplinks finish within one candidate transfer budget",
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
				{
					env: {
						CERALIVE_SWEEP_CHILD: "1",
						HTTP_PROXY: "",
						HTTPS_PROXY: "",
						ALL_PROXY: "",
						http_proxy: "",
						https_proxy: "",
						all_proxy: "",
						CURL_HOME: "/nonexistent",
					},
				},
			);
			expect(result.code, result.stdout + result.stderr).toBe(0);
			console.info(result.stdout.trim());
			return;
		}
		// Given: five real kernel interfaces with a route but no answering external peer.
		const names = ["eth0", "wlan0", "modem0", "twin0", "twin1"];
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
		}
		const routes = await run("ip", ["-N", "route", "show", "table", "all"]);
		const rules = await run("ip", ["rule", "show"]);
		const candidates = names.map((name, index) => ({
			name,
			ip: `192.0.${index}.2`,
			binding: { kind: "device", ifname: name },
		})) satisfies readonly ProbeCandidate[];
		const started = performance.now();
		// When: the production repository and generic curl paths exhaust their real timers.
		const result = await electConnectivityCandidate(
			["203.0.113.10"],
			candidates,
			{
				probeRepository: (ifname) =>
					probeAptReachability({
						...defaultAptReachabilityDeps,
						readSources: async () =>
							"URIs: https://203.0.113.10/repo\nSuites: stable",
						ifname,
					}),
				probeViaDevice: (addr, ifname) =>
					checkConnectivityViaDevice(addr, ifname, {
						...defaultDeviceBoundProbeDeps,
						shouldUseMocks: () => false,
					}),
				probeViaSourceIp: async () => {
					throw new Error("production candidate must name its device");
				},
			},
		);
		const elapsed = performance.now() - started;
		console.info(
			JSON.stringify({
				scenario: "five-blackholed-uplinks",
				elapsed_ms: elapsed,
			}),
		);
		// Then: five failed paths consume one parallel transfer budget, with exact attribution.
		expect(elapsed).toBeLessThan(15_000);
		expect(result.elected).toBeUndefined();
		expect(
			result.results.map(({ candidate, reachable }) => [
				candidate.name,
				reachable,
			]),
		).toEqual(names.map((name) => [name, false]));
		expect(await run("ip", ["-N", "route", "show", "table", "all"])).toBe(
			routes,
		);
		expect(await run("ip", ["rule", "show"])).toBe(rules);
	},
	45_000,
);
