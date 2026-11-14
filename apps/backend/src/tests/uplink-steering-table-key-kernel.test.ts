import { expect, test } from "bun:test";
import { run, runWithStdin } from "../helpers/run.ts";
import {
	type PreparedSteeringState,
	type UplinkRoutePlan,
	UplinkSteeringApplier,
} from "../modules/network/uplink-steering/applier.ts";
import {
	discoverOwnedUplinkRoutes,
	ensureUplinkRoute,
	planUplinkRoute,
	removeUplinkRoute,
	rollbackUplinkRoute,
	type UplinkRouteManagerDeps,
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
	identity: "table-key-owner",
	ifname: "wwan2",
	sourceAddress: "100.64.2.2",
	sourceAddressUnique: false,
	mark: 0xca000100,
};

const cases = [
	{ name: "TOS-KEY removes the stale TOS default", kind: "tos" },
	{ name: "installed planned TOS route is a no-op control", kind: "control" },
	{
		name: "single host route cannot override the planned default",
		kind: "host",
	},
	{ name: "second default cannot select the stale modem", kind: "second" },
	{
		name: "second default is removed above the planned metric",
		kind: "second-low",
	},
	{ name: "crash-route is reclaimed by a fresh applier", kind: "crash" },
	{
		name: "P6 converges to planned metric 150 over 50 and 150",
		kind: "higher",
	},
	{ name: "P6 converges to planned metric 50 over 50 and 150", kind: "lower" },
	{
		name: "planned TOS keeps its route over a plain same-metric line",
		kind: "planned",
	},
	{ name: "rollback restores TOS and host route inventory", kind: "rollback" },
	{ name: "typed blackhole default is restored on rollback", kind: "typed" },
	{
		name: "add-before-delete process crash converges on restart",
		kind: "metric-crash",
	},
	{
		name: "partial stale-route deletion failure restores inventory",
		kind: "partial",
	},
] as const;

function state(route: UplinkRoutePlan): PreparedSteeringState {
	return {
		clientZones: [{ ifname: "eth9", ipv4Cidr: "10.90.0.0/24" }],
		uplinks: [{ ...candidate, selectable: true, weight: 100 }],
		routes: [route],
	};
}

function applier(
	deps: UplinkRouteManagerDeps = { run },
	rejectPublication = false,
): UplinkSteeringApplier {
	return new UplinkSteeringApplier({
		discoverRoutes: () => discoverOwnedUplinkRoutes(deps),
		ensureRoute: (route) => ensureUplinkRoute(route, deps),
		rollbackRoute: (receipt) => rollbackUplinkRoute(receipt, deps),
		removeRoute: (route) => removeUplinkRoute(route, deps),
		applyRuleset: async (ruleset) => {
			if (rejectPublication) throw new Error("injected publication failure");
			await runWithStdin("nft", ["-f", "-"], ruleset);
		},
		deactivateSharing: async () => {
			await run("nft", ["delete", "table", "inet", "ceralive_share"]);
		},
		flushConntrack: async () => {
			throw new Error("unexpected conntrack flush");
		},
		setIpForwarding: async () => {},
		publishFlowsReset: () => {
			throw new Error("unexpected flow reset");
		},
	});
}

async function inventory(table: string): Promise<string[]> {
	return (await run("ip", ["route", "show", "table", table]))
		.trim()
		.split("\n")
		.filter(Boolean)
		.sort();
}

async function crashAfter(operation: "add" | "replace", ifname: string) {
	const result = await runTestCommand(
		[
			process.execPath,
			"test",
			file,
			"--test-name-pattern",
			"^process crash boundary$",
		],
		{
			env: {
				CERALIVE_TABLE_CRASH: operation,
				CERALIVE_TABLE_CRASH_IFACE: ifname,
			},
		},
	);
	expect(result.code, result.stdout + result.stderr).toBe(73);
}

if (process.env.CERALIVE_TABLE_CRASH !== undefined) {
	test("process crash boundary", async () => {
		const deps: UplinkRouteManagerDeps = {
			run: async (command, args, ...rest) => {
				const result = await run(command, args, ...rest);
				if (args[0] === "route" && args[1] === process.env.CERALIVE_TABLE_CRASH)
					process.exit(73);
				return result;
			},
		};
		const plan = await planUplinkRoute(
			{
				...candidate,
				ifname: process.env.CERALIVE_TABLE_CRASH_IFACE ?? candidate.ifname,
			},
			deps,
		);
		await ensureUplinkRoute(plan, deps);
		throw new Error("crash boundary was not reached");
	});
}

for (const { name, kind } of cases) {
	test(name, async () => {
		expect(probe.ok, probe.detail).toBe(true);
		if (!child) {
			await inNamespace(file, name);
			receipts.push(name);
			return;
		}
		for (const [iface, address] of [
			["wwan0", "100.64.1.2/24"],
			["wwan2", "100.64.2.2/24"],
		] as const) {
			await run("ip", ["link", "add", iface, "type", "dummy"]);
			await run("ip", ["link", "set", iface, "up"]);
			await run("ip", ["addr", "add", address, "dev", iface]);
		}
		const metric = ["lower", "second-low"].includes(kind) ? "50" : "150";
		const tos = ["control", "planned"].includes(kind) ? ["tos", "0x10"] : [];
		await run("ip", [
			"route",
			"add",
			"default",
			...tos,
			"via",
			"100.64.2.1",
			"dev",
			"wwan2",
			"proto",
			"static",
			"metric",
			metric,
			"onlink",
		]);
		await run("ip", [
			"route",
			"add",
			"default",
			...(kind === "crash" ? ["tos", "0x10"] : []),
			"via",
			"100.64.1.1",
			"dev",
			"wwan0",
			"metric",
			["lower", "second-low"].includes(kind) ? "1000" : "50",
			"onlink",
		]);
		const plan = await planUplinkRoute(candidate);
		const planned = plan.defaultRouteArgv;
		if (planned === undefined) throw new Error("missing planned route");
		const tableRoute = async (line: string) =>
			run("ip", ["route", "add", "table", plan.table, ...line.split(" ")]);
		const old = "default via 100.64.1.1 dev wwan0 metric";
		const host = "203.0.113.1 via 100.64.1.1 dev wwan0 onlink";
		await run("ip", [
			"route",
			"add",
			"table",
			"30002",
			"198.51.100.0/24",
			"dev",
			"wwan0",
		]);
		const sentinel = await inventory("30002");
		// Capture iproute2's canonical rendering of the actual planner output.
		await run("ip", ["route", "add", ...planned.slice(2)]);
		const expected = await inventory(plan.table);
		await run("ip", ["route", "del", ...planned.slice(2)]);
		if (
			[
				"tos",
				"control",
				"second",
				"second-low",
				"higher",
				"lower",
				"planned",
				"metric-crash",
			].includes(kind)
		)
			await run("ip", ["route", "add", ...planned.slice(2)]);
		switch (kind) {
			case "tos":
				await tableRoute(`${old} 150 tos 0x10 onlink`);
				break;
			case "host":
				await tableRoute(host);
				break;
			case "second":
				await tableRoute(`${old} 50 onlink`);
				break;
			case "second-low":
				await tableRoute(`${old} 150 onlink`);
				break;
			case "higher":
				await tableRoute(
					"default via 100.64.2.1 dev wwan2 proto static metric 50 onlink",
				);
				break;
			case "lower":
				await tableRoute(
					"default via 100.64.2.1 dev wwan2 proto static metric 150 onlink",
				);
				break;
			case "planned":
				await tableRoute(`${old} 150 onlink`);
				break;
			case "rollback":
			case "partial":
				await tableRoute(`${old} 150 onlink`);
				await tableRoute(`${old} 150 tos 0x10 onlink`);
				await tableRoute(host);
				break;
			case "typed":
				await tableRoute("blackhole default metric 150");
				break;
			case "crash":
				await crashAfter("replace", "wwan0");
				expect(await inventory(plan.table)).toHaveLength(1);
				break;
			case "metric-crash":
				await run("ip", ["route", "del", ...planned.slice(2)]);
				await tableRoute(
					"default via 100.64.2.1 dev wwan2 proto static metric 50 onlink",
				);
				await crashAfter("add", "wwan2");
				expect(await inventory(plan.table)).toHaveLength(2);
				break;
			case "control":
				break;
		}
		const before = await inventory(plan.table);
		const beforeRules = await run("ip", ["rule", "show"]);
		if (kind === "rollback" || kind === "typed") {
			await expect(
				applier({ run }, true).apply(undefined, state(plan)),
			).rejects.toThrow("injected publication failure");
			expect(await inventory(plan.table)).toEqual(before);
			expect(await run("ip", ["rule", "show"])).toBe(beforeRules);
		} else if (kind === "partial") {
			let injected = false;
			const deps: UplinkRouteManagerDeps = {
				run: async (command, args, ...rest) => {
					if (
						args[0] === "route" &&
						args[1] === "del" &&
						args.includes("203.0.113.1")
					) {
						injected = true;
						throw new Error("injected host deletion failure");
					}
					return run(command, args, ...rest);
				},
			};
			await expect(applier(deps).apply(undefined, state(plan))).rejects.toThrow(
				"injected host deletion failure",
			);
			expect(injected).toBe(true);
			expect(await inventory(plan.table)).toEqual(before);
			expect(await run("ip", ["rule", "show"])).toBe(beforeRules);
		} else {
			if (kind === "control") {
				await ensureUplinkRoute(plan);
				const calls: string[][] = [];
				const receipt = await ensureUplinkRoute(plan, {
					run: async (command, args, ...rest) => {
						calls.push([command, ...args]);
						return run(command, args, ...rest);
					},
				});
				expect(receipt.changed).toBe(false);
				expect(calls).toEqual([
					["ip", "rule", "show"],
					["ip", "route", "show", "table", plan.table],
				]);
			} else {
				await applier().apply(undefined, state(plan));
			}
			for (const value of tos.length === 0 ? ["0", "0x10"] : ["0x10"]) {
				const lookup = await run("ip", [
					"route",
					"get",
					"203.0.113.1",
					"mark",
					"0xca000100",
					"tos",
					value,
				]);
				expect(lookup).toContain("dev wwan2");
				expect(lookup).toContain(`table ${plan.table}`);
			}
			expect(await inventory(plan.table)).toEqual(expected);
		}
		expect(await inventory("30002")).toEqual(sentinel);
		console.log(kernelReceipt(file, name));
	}, 30_000);
}

if (!child) {
	test("kernel scenario receipt set", () => {
		expect(probe.ok, probe.detail).toBe(true);
		expect([...receipts].sort()).toEqual(
			[...suites["uplink-steering-table-key-kernel.test.ts"]].sort(),
		);
	});
}
