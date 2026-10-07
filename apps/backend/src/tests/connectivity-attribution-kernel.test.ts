import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { eligibleProbeCandidates } from "../modules/network/connectivity-candidates.ts";
import { buildDeviceBoundProbeArgv } from "../modules/network/device-bound-probe.ts";
import { kernelRouteRunner as run } from "./helpers/default-route-kernel.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_ATTRIBUTION_CHILD === "1";
const probe = child
	? undefined
	: await runTestCommand(["unshare", "-Urn", "true"]);
const unavailable = probe !== undefined && probe.code !== 0;

for (const protocol of [241, 242]) {
	const name = `eth0 probe retains egress against protocol ${protocol}`;
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
						name,
					],
					{ env: { CERALIVE_ATTRIBUTION_CHILD: "1" } },
				);
				expect(result.code, result.stdout + result.stderr).toBe(0);
				return;
			}
			// Given: Rock's dual-address lifeline, duplicate-address twins, and an impaired FIB winner.
			for (const iface of ["eth0", "wlan0", "twin0", "twin1"]) {
				await run("ip", ["link", "add", iface, "type", "dummy"]);
				await run("ip", ["link", "set", iface, "up"]);
			}
			await run("ip", ["addr", "add", "169.254.149.160/16", "dev", "eth0"]);
			await run("ip", ["addr", "add", "192.168.78.131/24", "dev", "eth0"]);
			await run("ip", ["addr", "add", "192.168.78.169/24", "dev", "wlan0"]);
			for (const iface of ["twin0", "twin1"])
				await run("ip", ["addr", "add", "192.168.8.100/24", "dev", iface]);
			await run("ip", [
				"route",
				"add",
				"default",
				"dev",
				"eth0",
				"src",
				"192.168.78.131",
				"metric",
				"50",
			]);
			await run("ip", [
				"route",
				"prepend",
				"default",
				"dev",
				"wlan0",
				"proto",
				String(protocol),
				"metric",
				protocol === 242 ? "49" : "0",
			]);
			const routes = await run("ip", ["-N", "route", "show", "table", "all"]);
			const rules = await run("ip", ["rule", "show"]);
			// A source-bound lookup demonstrably follows wlan0, independent of duplicate addresses.
			expect(
				await run("ip", [
					"route",
					"get",
					"203.0.113.10",
					"from",
					"192.168.78.131",
				]),
			).toContain("dev wlan0");
			const [candidate] = eligibleProbeCandidates({
				eth0: {
					ip: "192.168.78.131",
					error: 0,
					enabled: true,
					tp: 0,
					txb: 0,
					rxb: 0,
				},
			});
			expect(candidate).toBeDefined();
			if (!candidate) throw new Error("missing lifeline candidate");
			await run("nft", ["add", "table", "inet", "probe_test"]);
			await run("nft", ["add", "counter", "inet", "probe_test", "correct"]);
			await run("nft", ["add", "counter", "inet", "probe_test", "wrong"]);
			await run("nft", [
				"add",
				"chain",
				"inet",
				"probe_test",
				"output",
				"{ type filter hook output priority 0; }",
			]);
			for (const [iface, counter] of [
				["eth0", "correct"],
				["wlan0", "wrong"],
			])
				await run("nft", [
					"add",
					"rule",
					"inet",
					"probe_test",
					"output",
					"oifname",
					iface ?? "",
					"ip",
					"daddr",
					"203.0.113.10",
					"counter",
					"name",
					counter ?? "",
				]);
			// When: the candidate's production binding generates a real curl socket/SYN.
			const binding =
				candidate.binding.kind === "device"
					? `if!${candidate.binding.ifname}`
					: candidate.binding.ip;
			const argv = buildDeviceBoundProbeArgv("203.0.113.10", "eth0");
			argv[argv.indexOf("--interface") + 1] = binding;
			argv[argv.indexOf("--max-time") + 1] = "0.2";
			const result = await runTestCommand([
				argv[0] ?? "curl",
				"-q",
				"--noproxy",
				"*",
				...argv.slice(1),
			]);
			expect(result.code).toBe(28);
			// Then: actual kernel packet counters attribute egress, not a fake's argv opinion.
			expect(
				await run("nft", ["list", "counter", "inet", "probe_test", "correct"]),
			).toMatch(/packets [1-9]\d*/);
			expect(
				await run("nft", ["list", "counter", "inet", "probe_test", "wrong"]),
			).toContain("packets 0");
			expect(await run("ip", ["-N", "route", "show", "table", "all"])).toBe(
				routes,
			);
			expect(await run("ip", ["rule", "show"])).toBe(rules);
		},
		20_000,
	);
}
