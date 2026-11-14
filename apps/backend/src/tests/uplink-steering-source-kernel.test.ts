import { expect, test } from "bun:test";
import { run, runWithStdin } from "../helpers/run.ts";
import {
	type PreparedSteeringState,
	UplinkSteeringApplier,
} from "../modules/network/uplink-steering/applier.ts";
import {
	discoverOwnedUplinkRoutes,
	ensureUplinkRoute,
	hasFwmarkRule,
	planUplinkRoute,
	removeUplinkRoute,
	rollbackUplinkRoute,
} from "../modules/network/uplink-steering/route-manager.ts";
import {
	inNamespace,
	isKernelChild,
	kernelReceipt,
	preflight,
} from "./helpers/kernel-namespace.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";
import suites from "./kernel-suites.json";

const file = import.meta.filename;
const child = isKernelChild(file);
const probe = child ? { ok: true, detail: "" } : await preflight();
const receipts: string[] = [];
const candidate = {
	identity: "source-owner",
	ifname: "wwan2",
	sourceAddress: "100.64.1.2",
	sourceAddressUnique: true,
	mark: 0xca671a00,
};

async function sourceRule(source: string, table: string, priority = "100") {
	await run("ip", [
		"rule",
		"add",
		"priority",
		priority,
		"from",
		source,
		"lookup",
		table,
	]);
}

async function crashAfterSourceRule(name: string) {
	const result = await runTestCommand(
		[process.execPath, "test", file, "--test-name-pattern", `${name}$`],
		{ env: { CERALIVE_SOURCE_CRASH: "1" } },
	);
	expect(result.code, result.stdout + result.stderr).toBe(73);
	expect(await run("ip", ["rule", "show"])).toContain(
		"from 100.64.1.2 lookup 56393",
	);
}

for (const name of suites["uplink-steering-source-kernel.test.ts"]) {
	test(name, async () => {
		expect(probe.ok, probe.detail).toBe(true);
		if (!child) {
			await inNamespace(file, name);
			receipts.push(name);
			return;
		}
		if (process.env.CERALIVE_SOURCE_CRASH === "1") {
			await ensureUplinkRoute(
				{
					...candidate,
					ifname: "wwan0",
					mark: 0xca671900,
					table: "56393",
					managed: true,
					sourceRulePriority: 100,
					defaultRouteArgv: [
						"route",
						"replace",
						"table",
						"56393",
						"default",
						"via",
						"100.64.1.1",
						"dev",
						"wwan0",
					],
				},
				{
					run: async (bin, args, ...rest) => {
						const output = await run(bin, args, ...rest);
						if (
							args[0] === "rule" &&
							args[1] === "add" &&
							args.includes("from")
						)
							process.exit(73);
						return output;
					},
				},
			);
			throw new Error("crash boundary was not reached");
		}
		for (const iface of ["wwan0", "wwan2"]) {
			await run("ip", ["link", "add", iface, "type", "dummy"]);
			await run("ip", ["link", "set", iface, "up"]);
			await run("ip", ["addr", "add", "100.64.1.2/24", "dev", iface]);
			await run("ip", [
				"route",
				"add",
				"default",
				"via",
				"100.64.1.1",
				"dev",
				iface,
				"metric",
				iface === "wwan0" ? "100" : "150",
			]);
		}
		const flushed: number[] = [];
		const failedSources: string[] = [];
		let failRemoval = name === "orphan-cleanup-retry";
		const applier = new UplinkSteeringApplier({
			discoverRoutes: discoverOwnedUplinkRoutes,
			ensureRoute: ensureUplinkRoute,
			rollbackRoute: rollbackUplinkRoute,
			removeRoute: (route) => {
				if (failRemoval) {
					failedSources.push(route.sourceAddress);
					throw new Error("injected startup removal failure");
				}
				return removeUplinkRoute(route);
			},
			applyRuleset: (ruleset) =>
				runWithStdin("nft", ["-f", "-"], ruleset).then(() => {}),
			deactivateSharing: async () => {},
			flushConntrack: async (mark) => {
				flushed.push(mark);
			},
			setIpForwarding: async () => {},
			publishFlowsReset: () => {},
		});
		const empty: PreparedSteeringState = {
			clientZones: [{ ifname: "eth9", ipv4Cidr: "10.90.0.0/24" }],
			uplinks: [],
			routes: [],
		};
		if (
			name === "CR:crash-source absent claimant" ||
			name === "control present claimant completes interrupted source support"
		) {
			await crashAfterSourceRule(name);
			if (name === "CR:crash-source absent claimant") {
				await applier.apply(undefined, empty);
				expect(await run("ip", ["rule", "show"])).not.toContain("lookup 56393");
				expect(flushed).toEqual([0xca671900]);
			} else {
				const plan = await planUplinkRoute({
					...candidate,
					ifname: "wwan0",
					mark: 0xca671900,
				});
				await applier.apply(undefined, { ...empty, routes: [plan] });
				expect(hasFwmarkRule(await run("ip", ["rule", "show"]), plan)).toBe(
					true,
				);
				expect(
					await run("ip", [
						"route",
						"get",
						"203.0.113.1",
						"from",
						candidate.sourceAddress,
					]),
				).toContain("dev wwan0");
				expect(flushed).toEqual([]);
			}
		} else if (name === "orphan-cleanup-retry") {
			await sourceRule("100.64.1.2", "56393");
			await sourceRule("100.64.3.2", "56393");
			await applier.apply(undefined, empty);
			expect(failedSources.sort()).toEqual(["100.64.1.2", "100.64.3.2"]);
			expect(
				(await run("ip", ["rule", "show"])).match(/lookup 56393/g),
			).toHaveLength(2);
			failRemoval = false;
			await applier.retryPendingCleanup();
			expect(await run("ip", ["rule", "show"])).not.toContain("lookup 56393");
			expect(flushed).toEqual(Array(4).fill(0xca671900));
		} else {
			await sourceRule(candidate.sourceAddress, "56393");
			if (name === "CR:dual-source")
				await sourceRule(candidate.sourceAddress, "56394");
			if (name === "P12 multiple stale managed tables")
				await sourceRule(candidate.sourceAddress, "56392");
			if (name === "control own plus foreign remains ambiguous") {
				await sourceRule(candidate.sourceAddress, "56394");
				await sourceRule(candidate.sourceAddress, "120");
				await expect(planUplinkRoute(candidate)).rejects.toMatchObject({
					reason: "policy_route_missing",
					message: expect.stringContaining(
						"source address selects several tables",
					),
				});
			} else {
				// Another address in our table is also stale; priority 99 remains foreign.
				await sourceRule("100.64.3.2", "56394");
				await sourceRule("100.64.4.2", "56394", "99");
				const twin = name === "P11 unique to twin removes source rules";
				const plan = await planUplinkRoute({
					...candidate,
					sourceAddressUnique: !twin,
				});
				expect(plan).toMatchObject({ table: "56394", managed: true });
				const before = await run("ip", ["rule", "show"]);
				const receipt = await ensureUplinkRoute(plan);
				const rules = await run("ip", ["rule", "show"]);
				expect(rules).not.toContain("lookup 56393");
				expect(rules).not.toContain("lookup 56392");
				expect(rules).not.toContain("100:	from 100.64.3.2");
				expect(rules).toContain("99:	from 100.64.4.2 lookup 56394");
				if (twin) {
					expect(rules).not.toContain(`from ${candidate.sourceAddress} lookup`);
				} else {
					expect(
						await run("ip", [
							"route",
							"get",
							"203.0.113.1",
							"from",
							candidate.sourceAddress,
						]),
					).toContain("dev wwan2");
				}
				if (name === "rollback restores removed source inventory") {
					expect(receipt.changed).toBe(true);
					await rollbackUplinkRoute(receipt);
					expect(
						(await run("ip", ["rule", "show"])).trim().split("\n").sort(),
					).toEqual(before.trim().split("\n").sort());
				}
			}
		}
		console.log(kernelReceipt(file, name));
	}, 30_000);
}

if (!child) {
	test("kernel scenario receipt set", () => {
		expect(probe.ok, probe.detail).toBe(true);
		expect([...receipts].sort()).toEqual(
			[...suites["uplink-steering-source-kernel.test.ts"]].sort(),
		);
	});
}
