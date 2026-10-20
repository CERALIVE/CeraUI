/// <reference lib="es2022" />
import { describe, expect, test } from "bun:test";
import type { run } from "../helpers/run.ts";
import { setDefaultRoute } from "../modules/network/default-route.ts";
import { GatewayRoutePreference } from "../modules/network/gateway-route-lifecycle.ts";
import {
	DefaultRouteTable,
	KernelRouteCommandError,
} from "./helpers/default-route-table.ts";

const FOREIGN = "default dev eth0 proto 16 metric 0";
const MODEM = "default dev modem0 proto 16 metric 702";
const OWNED = "default dev modem0 proto 242 metric 0";

describe("board-kernel preference semantics", () => {
	for (const family of [4, 6] as const) {
		test(`IPv${family} duplicate add fails EEXIST even with a different endpoint and protocol`, async () => {
			// Given: a priority already exists, regardless of attribute spelling.
			const rows = ["default dev eth0 proto 242 metric 49"];
			const table = new DefaultRouteTable(
				family === 4 ? rows : [],
				family === 6 ? rows : [],
			);
			// When: ordinary add attempts to reuse its priority for another device/protocol.
			const error: unknown = await table
				.runner("ip", [
					...(family === 6 ? ["-6"] : []),
					"route",
					"add",
					"default",
					"dev",
					"modem0",
					"proto",
					"243",
					"metric",
					"49",
				])
				.catch((error: unknown) => error);
			// Then: fake matches iproute2's nonzero exit and EEXIST, not set insertion.
			expect(error).toBeInstanceOf(KernelRouteCommandError);
			expect(error).toMatchObject({ exitCode: 2, errno: "EEXIST" });
			expect(table.rows(family)).toEqual(rows);
		});
		for (const second of ["hl1", "wlan0"])
			test(`RT3-M1 IPv${family} ${second} switches to modem and back`, async () => {
				// Given: both choices are worse than the natural Rock metric 50 route.
				const rows = [
					"default dev eth0 proto 16 metric 50",
					`default dev ${second} proto 16 metric 702`,
					"default dev modem0 proto 16 metric 703",
				];
				const table = new DefaultRouteTable(
					family === 4 ? rows : [],
					family === 6 ? rows : [],
				);
				// When: independent uplinks win in sequence.
				for (const target of [second, "modem0", second]) {
					await setDefaultRoute(target, { runner: table.runner, family });
					expect(
						await table.runner("ip", [
							...(family === 6 ? ["-6"] : []),
							"route",
							"get",
							family === 6 ? "2001:db8::1" : "8.8.8.8",
							"fibmatch",
						]),
					).toContain(`dev ${target} proto 24`);
				}
				await setDefaultRoute(undefined, { runner: table.runner });
				// Then: the original foreign order survives every switch.
				expect(table.orderedRows(family)).toEqual(rows);
				if (family === 6)
					expect(
						table.mutations.every((args) => !args.includes("prepend")),
					).toBe(true);
			});
	}
	test("board mode drops realms and classid and rejects identical prepend", async () => {
		// Given: CONFIG_IP_ROUTE_CLASSID is absent on the board.
		const table = new DefaultRouteTable([]);
		// When: an attribute-bearing command is acknowledged.
		await table.runner("ip", [
			"route",
			"prepend",
			...OWNED.split(" "),
			"realm",
			"1",
			"classid",
			"2",
		]);
		// Then: the dump erases attributes; another realm cannot create a generation.
		expect(table.rows()).toEqual([OWNED]);
		await expect(
			table.runner("ip", [
				"route",
				"prepend",
				...OWNED.split(" "),
				"realm",
				"2",
			]),
		).rejects.toMatchObject({ exitCode: 2, errno: "EEXIST" });
	});
	test("RT3-M3 metric-zero election wins without realm round-trip and 100 elections write once", async () => {
		// Given: a HiLink no-metric lease outranks a usable modem.
		const table = new DefaultRouteTable([
			FOREIGN.replace(" metric 0", ""),
			MODEM,
		]);
		// When: unchanged election is reconciled repeatedly.
		for (let i = 0; i < 100; i++)
			await setDefaultRoute("modem0", { runner: table.runner });
		// Then: only one mutation and a real realized fake FIB winner.
		expect(table.mutations).toHaveLength(1);
		expect(
			await table.runner("ip", ["route", "get", "8.8.8.8", "fibmatch"]),
		).toBe(OWNED);
		expect(table.mutations.flat()).not.toContain("realm");
	});
	test("RT3-M2 matching generations retain the FIB winner and remove the interior copy", async () => {
		// Given: a process died after staging a new generation in front of the old one.
		const winner = OWNED.replace("242", "243");
		const table = new DefaultRouteTable([winner, FOREIGN, OWNED, MODEM]);
		// When: the same identity is elected without startup first.
		await setDefaultRoute("modem0", { runner: table.runner });
		// Then: only the losing generation is deleted; the winning row never moved.
		expect(table.orderedRows()).toEqual([winner, FOREIGN, MODEM]);
		expect(table.mutations).toEqual([["route", "del", ...OWNED.split(" ")]]);
	});
	test("IPv6 election retires an interior IPv4 preference only after the IPv6 proof", async () => {
		// Given: a floor alias lost position, but the new family's priority is independent.
		const tail = "default dev tail proto 17 metric 0";
		const v6 = [
			"default dev eth0 proto 9 metric 37",
			"default dev modem0 proto 9 metric 83",
		];
		const table = new DefaultRouteTable([FOREIGN, OWNED, tail, MODEM], v6);
		// When: the election changes families.
		await setDefaultRoute("modem0", { runner: table.runner, family: 6 });
		// Then: IPv4 is released after the independently realized IPv6 preference.
		expect(table.orderedRows()).toEqual([FOREIGN, tail, MODEM]);
		expect(table.orderedRows(6)[0]).toBe(
			"default dev modem0 proto 242 metric 36",
		);
		expect(
			table.mutations.map((args) => args[args.indexOf("route") + 1]),
		).toEqual(["add", "del"]);
	});
	test("RT3-M2 every lifecycle boundary sweeps a two-generation crash residue", async () => {
		// Given: a replacement at the front and old row in the interior.
		const table = new DefaultRouteTable([
			OWNED.replace("242", "243"),
			FOREIGN,
			OWNED,
			MODEM,
		]);
		const controller = new GatewayRoutePreference(table.runner);
		// When: start, apply, release and stop run in their normal order.
		await controller.start();
		expect(table.orderedRows()).toEqual([FOREIGN, MODEM]);
		await controller.apply("modem0");
		expect(table.orderedRows()[0]).toBe(OWNED);
		await controller.apply(undefined);
		await controller.stop();
		// Then: no residue survived, and the foreign order is exact.
		expect(table.orderedRows()).toEqual([FOREIGN, MODEM]);
	});
	test("release aggregates errors while attempting later rows and the other family", async () => {
		// Given: two deletes fail independently; a third deletion must still run.
		const table = new DefaultRouteTable(
			[OWNED, FOREIGN, OWNED.replace("242", "243"), MODEM],
			["default dev stale6 proto 242 metric 7"],
		);
		const runner: typeof run = (bin, args, opts) =>
			args.includes("del") && !args.includes("-6")
				? Promise.reject(new Error("delete refused"))
				: table.runner(bin, args, opts);
		// When: release cannot delete either IPv4 row.
		const error: unknown = await setDefaultRoute(undefined, { runner }).catch(
			(error: unknown) => error,
		);
		// Then: both failures are reported and IPv6 still cleans up.
		if (!(error instanceof Error) || !(error.cause instanceof AggregateError))
			throw new Error("aggregate missing");
		expect(error.cause.errors).toHaveLength(2);
		expect(table.rows(6)).toEqual([]);
		await setDefaultRoute(undefined, { runner: table.runner });
		expect(table.orderedRows()).toEqual([FOREIGN, MODEM]);
	});
	for (const tag of ["realm 3", "realm 4", "realm 65535", "realms 5/1"]) {
		test(`RT3-S2/S3 legacy ${tag} is cleaned with its exact observed selector`, async () => {
			// Given: host-only old attributes must never be interpreted as new generations.
			const row = `${OWNED} ${tag}`;
			const table = new DefaultRouteTable(
				[row, OWNED, OWNED.replace("242", "243"), FOREIGN, MODEM],
				[],
				"host",
			);
			// When: release sweeps legacy attributes before any wildcard realm-zero row.
			await setDefaultRoute(undefined, { runner: table.runner });
			// Then: selector retains the observed attribute, and foreign routes alone survive.
			expect(table.mutations[0]).toEqual(["route", "del", ...row.split(" ")]);
			expect(table.orderedRows()).toEqual([FOREIGN, MODEM]);
		});
	}
	test("a failed legacy deletion cannot turn the later zero-realm delete into a wildcard", async () => {
		// Given: a tagged alias precedes a realm-zero alias with the same protocol.
		const table = new DefaultRouteTable(
			[`${OWNED} realm 1`, OWNED, FOREIGN, MODEM],
			[],
			"host",
		);
		const runner: typeof run = (bin, args, opts) =>
			args.includes("realm")
				? Promise.reject(new Error("legacy delete refused"))
				: table.runner(bin, args, opts);
		// When: exact legacy deletion fails inside the best-effort release.
		await expect(setDefaultRoute(undefined, { runner })).rejects.toMatchObject({
			reason: "apply-failed",
		});
		// Then: the wildcard cannot delete a different generation; repair retries exact cleanup.
		expect(table.mutations).toEqual([]);
		expect(table.orderedRows()).toEqual([
			`${OWNED} realm 1`,
			OWNED,
			FOREIGN,
			MODEM,
		]);
		await setDefaultRoute(undefined, { runner: table.runner });
		expect(table.orderedRows()).toEqual([FOREIGN, MODEM]);
	});
});
