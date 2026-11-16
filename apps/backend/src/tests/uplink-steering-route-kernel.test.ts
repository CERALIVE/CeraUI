import { describe, expect, test } from "bun:test";
import { run, runWithStdin } from "../helpers/run.ts";
import {
	type PreparedSteeringState,
	type UplinkRoutePlan,
	UplinkSteeringApplier,
} from "../modules/network/uplink-steering/applier.ts";
import {
	discoverOwnedUplinkRoutes,
	ensureUplinkRoute,
	hasFwmarkRule,
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
const name = "#433 provisions and retires never-created steering tables";

function kernelRefreshTest(
	name: string,
	scenario: (deps: UplinkRouteManagerDeps) => Promise<void>,
): void {
	test(name, async () => {
		expect(probe.ok, probe.detail).toBe(true);
		if (!child) {
			await inNamespace(file, name);
			receipts.push(name);
			return;
		}
		for (const [iface, address] of [
			["wwan0", "10.0.0.2/24"],
			["wwan1", "10.1.0.2/24"],
		] as const) {
			await run("ip", ["link", "add", iface, "type", "dummy"]);
			await run("ip", ["link", "set", iface, "up"]);
			await run("ip", ["addr", "add", address, "dev", iface]);
		}
		await run("ip", [
			"route",
			"add",
			"table",
			"30002",
			"default",
			"via",
			"10.1.0.1",
			"dev",
			"wwan1",
			"onlink",
			"mtu",
			"1350",
		]);
		const sentinel = await run("ip", ["route", "show", "table", "30002"]);
		const calls: string[][] = [];
		const routeStates: string[] = [];
		await scenario({
			run: async (command, args, ...rest) => {
				calls.push([command, ...args]);
				const result = await run(command, args, ...rest);
				if (
					args[0] === "route" &&
					["replace", "add", "del", "flush"].includes(args[1] ?? "")
				) {
					routeStates.push(
						await run("ip", ["route", "show", "table", "30001"]),
					);
				}
				return result;
			},
		});
		for (const state of routeStates) expect(state.trim()).not.toBe("");
		expect(await run("ip", ["route", "show", "table", "30002"])).toBe(sentinel);
		for (const call of calls) {
			if (
				call[1] !== "route" ||
				!["replace", "add", "del", "flush"].includes(call[2] ?? "")
			)
				continue;
			expect(call.includes("flush")).toBe(false);
			expect(call[call.indexOf("table") + 1]).toBe("30001");
		}
		console.log(kernelReceipt(file, name));
	}, 30_000);
}

describe("real kernel managed route refresh", () => {
	for (const metric of [100, 200]) {
		kernelRefreshTest(
			`#534 rename rollback restores a cross-device default with metric ${metric}`,
			async (deps) => {
				await run("ip", [
					"route",
					"add",
					"default",
					"via",
					"10.1.0.1",
					"dev",
					"wwan1",
					"proto",
					"static",
					"metric",
					"100",
				]);
				const candidate = {
					identity: "renamed-modem",
					ifname: "wwan1",
					sourceAddress: "10.1.0.2",
					sourceAddressUnique: false,
					mark: 0xca000100,
				};
				const previousRoute = await planUplinkRoute(candidate, deps);
				const previous: PreparedSteeringState = {
					clientZones: [{ ifname: "eth9", ipv4Cidr: "10.90.0.0/24" }],
					uplinks: [{ ...candidate, selectable: true, weight: 100 }],
					routes: [previousRoute],
				};
				const flushes: number[] = [];
				let rejectReload = false;
				const applier = new UplinkSteeringApplier({
					discoverRoutes: () => discoverOwnedUplinkRoutes(deps),
					ensureRoute: (route) => ensureUplinkRoute(route, deps),
					rollbackRoute: (receipt) => rollbackUplinkRoute(receipt, deps),
					removeRoute: (route) => removeUplinkRoute(route, deps),
					applyRuleset: async (ruleset, mode) => {
						if (rejectReload) {
							expect(mode).toBe("reload");
							expect(
								await run("ip", [
									"route",
									"show",
									"table",
									previousRoute.table,
								]),
							).toContain("dev wwan0");
							throw new Error("injected reload failure");
						}
						await runWithStdin("nft", ["-f", "-"], ruleset);
					},
					deactivateSharing: async () => {
						throw new Error("unexpected deactivation");
					},
					flushConntrack: async (mark) => {
						flushes.push(mark);
					},
					setIpForwarding: async () => {},
					publishFlowsReset: () => {
						throw new Error("unexpected flow reset");
					},
				});
				await applier.apply(undefined, previous);
				const before = await run("ip", [
					"route",
					"show",
					"table",
					previousRoute.table,
				]);
				const beforeRules = await run("ip", ["rule", "show"]);
				const beforeNft = await run("nft", [
					"list",
					"table",
					"inet",
					"ceralive_share",
				]);
				await run("ip", ["route", "del", "default", "dev", "wwan1"]);
				await run("ip", [
					"route",
					"add",
					"default",
					"via",
					"10.0.0.1",
					"dev",
					"wwan0",
					"proto",
					"static",
					"metric",
					String(metric),
				]);
				const nextRoute = await planUplinkRoute(
					{
						...candidate,
						ifname: "wwan0",
						sourceAddress: "10.0.0.2",
					},
					deps,
				);
				const next: PreparedSteeringState = {
					...previous,
					uplinks: [
						{ ...candidate, ifname: "wwan0", selectable: true, weight: 100 },
					],
					routes: [nextRoute],
				};
				rejectReload = true;

				await expect(applier.apply(previous, next)).rejects.toThrow(
					"injected reload failure",
				);

				const after = await run("ip", [
					"route",
					"show",
					"table",
					previousRoute.table,
				]);
				const lookup = await run("ip", [
					"route",
					"get",
					"203.0.113.1",
					"mark",
					"0xca000100",
				]);
				console.log(
					"ROLLBACK_ROUTE",
					JSON.stringify({ metric, before, after, lookup }),
				);
				expect(after).toBe(before);
				expect(lookup).toContain("dev wwan1");
				expect(await run("ip", ["rule", "show"])).toBe(beforeRules);
				expect(
					await run("nft", ["list", "table", "inet", "ceralive_share"]),
				).toBe(beforeNft);
				expect(flushes).toEqual([]);
			},
		);
	}

	kernelRefreshTest(
		"retains usable managed route when live main default is absent",
		async (deps) => {
			await run("ip", [
				"route",
				"add",
				"table",
				"30001",
				..."default via 10.0.0.1 dev wwan0 proto static metric 600 onlink src 10.0.0.2 mtu 1400".split(
					" ",
				),
			]);
			await run("ip", [
				"rule",
				"add",
				"priority",
				"100",
				"from",
				"10.0.0.2/32",
				"lookup",
				"30001",
			]);
			await run("ip", [
				"rule",
				"add",
				"priority",
				"110",
				"fwmark",
				"0xca000100/0xffffff00",
				"lookup",
				"30001",
			]);
			expect(
				await run("ip", ["-4", "route", "show", "default", "dev", "wwan0"]),
			).toBe("");
			const before = await run("ip", ["route", "show", "table", "30001"]);
			const candidate = {
				identity: "no-main-default",
				ifname: "wwan0",
				sourceAddress: "10.0.0.2",
				sourceAddressUnique: true,
				mark: 0xca000100,
			};
			const plan = await planUplinkRoute(candidate, deps);
			expect((await ensureUplinkRoute(plan, deps)).changed).toBe(false);
			expect(await run("ip", ["route", "show", "table", "30001"])).toBe(before);
			await expect(
				planUplinkRoute(candidate, {
					run: async (command, args, ...rest) => {
						if (args[0] === "-4") throw new Error("live query refused");
						return await deps.run(command, args, ...rest);
					},
				}),
			).rejects.toMatchObject({
				reason: "policy_route_missing",
				message: "wwan0: live query refused",
			});
			await run("ip", [
				"rule",
				"del",
				"priority",
				"100",
				"from",
				"10.0.0.2/32",
				"lookup",
				"30001",
			]);
			await expect(planUplinkRoute(candidate, deps)).rejects.toMatchObject({
				reason: "policy_route_missing",
			});
			expect(await run("ip", ["route", "show", "table", "30001"])).toBe(before);
		},
	);

	kernelRefreshTest(
		"same-metric protocol refresh uses one replace",
		async (deps) => {
			const current =
				"default via 10.0.0.1 dev wwan0 proto dhcp src 10.0.0.2 metric 600 onlink mtu 1400";
			await run("ip", [
				"route",
				"add",
				"table",
				"30001",
				...current.split(" "),
			]);
			const before = await run("ip", ["route", "show", "table", "30001"]);
			const plan: UplinkRoutePlan = {
				identity: "same-metric-protocol",
				ifname: "wwan0",
				sourceAddress: "10.0.0.2",
				mark: 0xca000100,
				table: "30001",
				managed: true,
				defaultRouteArgv: [
					"route",
					"replace",
					"table",
					"30001",
					..."default via 10.0.0.1 dev wwan0 proto static metric 600".split(
						" ",
					),
				],
			};
			const writes: string[] = [];
			const tracking: UplinkRouteManagerDeps = {
				run: async (command, args, ...rest) => {
					if (
						args[0] === "route" &&
						["replace", "add", "del"].includes(args[1] ?? "")
					)
						writes.push(args[1] ?? "");
					return await deps.run(command, args, ...rest);
				},
			};
			const receipt = await ensureUplinkRoute(plan, tracking);
			expect(writes).toEqual(["replace"]);
			const after = await run("ip", ["route", "show", "table", "30001"]);
			expect(after).toContain("proto static");
			expect(after.trim().split("\n")).toHaveLength(1);
			await rollbackUplinkRoute(receipt, tracking);
			expect(writes).toEqual(["replace", "replace"]);
			expect(await run("ip", ["route", "show", "table", "30001"])).toBe(before);
			await expect(
				ensureUplinkRoute(plan, {
					run: async (command, args, ...rest) => {
						if (args[0] === "route" && args[1] === "replace")
							throw new Error("injected replace failure");
						return await deps.run(command, args, ...rest);
					},
				}),
			).rejects.toMatchObject({ reason: "policy_route_missing" });
			expect(await run("ip", ["route", "show", "table", "30001"])).toBe(before);
		},
	);

	kernelRefreshTest("replans from the live interface gateway", async (deps) => {
		await run("ip", [
			"route",
			"add",
			"default",
			"via",
			"10.0.0.1",
			"dev",
			"wwan0",
			"proto",
			"static",
			"metric",
			"600",
		]);
		const candidate = {
			identity: "kernel-refresh",
			ifname: "wwan0",
			sourceAddress: "10.0.0.2",
			sourceAddressUnique: true,
			mark: 0xca000100,
		};
		const initial = await planUplinkRoute(candidate, deps);
		await ensureUplinkRoute(initial, deps);
		expect(
			await run("ip", ["route", "show", "table", initial.table]),
		).toContain("via 10.0.0.1");
		await run("ip", [
			"route",
			"replace",
			"default",
			"via",
			"10.0.0.9",
			"dev",
			"wwan0",
			"proto",
			"static",
			"metric",
			"600",
		]);
		const refreshed = await planUplinkRoute(candidate, deps);
		const receipt = await ensureUplinkRoute(refreshed, deps);
		const after = await run("ip", ["route", "show", "table", refreshed.table]);
		expect(after).toContain("via 10.0.0.9");
		expect(after.trim().split("\n")).toHaveLength(1);
		expect(refreshed.defaultRouteArgv).not.toEqual(initial.defaultRouteArgv);
		expect(receipt.changed).toBe(true);
		expect((await ensureUplinkRoute(refreshed, deps)).changed).toBe(false);
	});

	kernelRefreshTest(
		"metric rollback restores only the previous default",
		async (deps) => {
			await run("ip", [
				"route",
				"add",
				"table",
				"30001",
				"default",
				"via",
				"10.0.0.1",
				"dev",
				"wwan0",
				"proto",
				"dhcp",
				"src",
				"10.0.0.2",
				"metric",
				"600",
				"onlink",
				"mtu",
				"1400",
			]);
			const plan: UplinkRoutePlan = {
				identity: "kernel-rollback",
				ifname: "wwan0",
				sourceAddress: "10.0.0.2",
				mark: 0xca000100,
				table: "30001",
				managed: true,
				sourceRulePriority: 100,
				defaultRouteArgv: [
					"route",
					"replace",
					"table",
					"30001",
					"default",
					"via",
					"10.0.0.9",
					"dev",
					"wwan0",
				],
			};
			const before = await run("ip", ["route", "show", "table", plan.table]);
			const beforeRules = await run("ip", ["rule", "show"]);
			let beforeFailedAdd: string | undefined;
			await expect(
				ensureUplinkRoute(plan, {
					run: async (command, args, ...rest) => {
						if (
							args[0] === "rule" &&
							args[1] === "add" &&
							args.includes("fwmark")
						)
							throw new Error("injected later fwmark failure");
						return await deps.run(command, args, ...rest);
					},
				}),
			).rejects.toMatchObject({ reason: "policy_route_missing" });
			expect(await run("ip", ["route", "show", "table", plan.table])).toBe(
				before,
			);
			expect(await run("ip", ["rule", "show"])).toBe(beforeRules);

			const receipt = await ensureUplinkRoute(plan, deps);
			const refreshed = await run("ip", ["route", "show", "table", plan.table]);
			expect(refreshed).toContain("via 10.0.0.9");
			expect(refreshed.trim().split("\n")).toHaveLength(1);
			await rollbackUplinkRoute(receipt, deps);
			expect(await run("ip", ["route", "show", "table", plan.table])).toBe(
				before,
			);
			expect(await run("ip", ["rule", "show"])).toBe(beforeRules);

			await expect(
				ensureUplinkRoute(plan, {
					run: async (command, args, ...rest) => {
						if (
							args[0] === "route" &&
							args[1] === "add" &&
							args.includes("10.0.0.9")
						) {
							beforeFailedAdd = await run("ip", [
								"route",
								"show",
								"table",
								plan.table,
							]);
							throw new Error("injected new route failure");
						}
						return await deps.run(command, args, ...rest);
					},
				}),
			).rejects.toMatchObject({ reason: "policy_route_missing" });
			expect(beforeFailedAdd).toBe(before);
			expect(await run("ip", ["route", "show", "table", plan.table])).toBe(
				before,
			);
			let beforeFailedDelete: string | undefined;
			await expect(
				ensureUplinkRoute(plan, {
					run: async (command, args, ...rest) => {
						if (
							args[0] === "route" &&
							args[1] === "del" &&
							args.includes("10.0.0.1")
						) {
							beforeFailedDelete = await run("ip", [
								"route",
								"show",
								"table",
								plan.table,
							]);
							throw new Error("injected old-route delete failure");
						}
						return await deps.run(command, args, ...rest);
					},
				}),
			).rejects.toMatchObject({ reason: "policy_route_missing" });
			expect(beforeFailedDelete?.trim().split("\n")).toHaveLength(2);
			expect(await run("ip", ["route", "show", "table", plan.table])).toBe(
				before,
			);
			expect(await run("ip", ["rule", "show"])).toBe(beforeRules);
		},
	);
});

describe("real kernel steering route absence", () => {
	test(name, async () => {
		expect(probe.ok, probe.detail).toBe(true);
		if (!child) {
			await inNamespace(file, name);
			receipts.push(name);
			return;
		}
		// Prove absence before any route or rule can create the managed table.
		await expect(
			run("ip", ["route", "show", "table", "30001"]),
		).rejects.toMatchObject({
			code: 2,
			stdout: "",
			stderr: "Error: ipv4: FIB table does not exist.\nDump terminated\n",
		});
		const flush = await runTestCommand([
			"ip",
			"route",
			"flush",
			"table",
			"30001",
		]);
		console.log("ABSENT_TABLE_FLUSH", JSON.stringify(flush));
		expect(flush).toEqual({
			code: 2,
			stdout: "",
			stderr: "Error: ipv4: FIB table does not exist.\nFlush terminated\n",
		});

		await run("ip", ["link", "add", "ww0", "type", "dummy"]);
		await run("ip", ["link", "set", "ww0", "up"]);
		await run("ip", ["addr", "add", "10.64.0.2/24", "dev", "ww0"]);
		await run("ip", [
			"route",
			"add",
			"default",
			"via",
			"10.64.0.1",
			"dev",
			"ww0",
		]);
		const plan = await planUplinkRoute({
			identity: "kernel-modem",
			ifname: "ww0",
			sourceAddress: "10.64.0.2",
			sourceAddressUnique: true,
			mark: 0xca000100,
		});
		await ensureUplinkRoute(plan);
		expect(await run("ip", ["route", "show", "table", plan.table])).toContain(
			"default via 10.64.0.1 dev ww0",
		);
		expect(hasFwmarkRule(await run("ip", ["rule", "show"]), plan)).toBe(true);

		await removeUplinkRoute(plan);
		expect(hasFwmarkRule(await run("ip", ["rule", "show"]), plan)).toBe(false);
		expect(await run("ip", ["route", "show", "table", plan.table])).toBe("");

		// A rule may outlive a table that has never been instantiated.
		await run("ip", [
			"rule",
			"add",
			"priority",
			"110",
			"fwmark",
			"0xca000200/0xffffff00",
			"lookup",
			"30002",
		]);
		const recovered = await discoverOwnedUplinkRoutes();
		expect(recovered).toMatchObject([
			{
				table: "30002",
				mark: 0xca000200,
				ifname: "unknown0",
				managed: true,
			},
		]);
		const [orphan] = recovered;
		if (orphan === undefined) throw new Error("owned rule was not recovered");
		await removeUplinkRoute(orphan);
		expect(await discoverOwnedUplinkRoutes()).toEqual([]);
		console.log(kernelReceipt(file, name));
	}, 30_000);
});

if (!child) {
	test("kernel scenario receipt set", () => {
		expect(probe.ok, probe.detail).toBe(true);
		expect([...receipts].sort()).toEqual(
			[...suites["uplink-steering-route-kernel.test.ts"]].sort(),
		);
	});
}
