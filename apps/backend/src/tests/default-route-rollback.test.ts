/// <reference lib="es2022" />
import { describe, expect, test } from "bun:test";
import type { run } from "../helpers/run.ts";
import { setDefaultRoute } from "../modules/network/default-route.ts";
import { fibChoosesPreference } from "../modules/network/default-route-acquisition.ts";
import {
	GatewayRouteError,
	readDefaultRoutes,
} from "../modules/network/default-route-model.ts";
import { DefaultRouteTable } from "./helpers/default-route-table.ts";

const FOREIGN = "default via 192.0.2.1 dev routea proto 16 metric 0";
const SECOND = "default via 198.51.100.1 dev routeb proto 16 metric 83";
const OWNED = "default via 198.51.100.1 dev routeb proto 242 metric 0";
const THIRD = "default via 203.0.113.1 dev routec proto 16 metric 100";
const STALE6 = "default dev absent proto 242 metric 36";
const FIB = ["route", "get", "203.0.113.254", "fibmatch"];

describe("ordered host preference rollback", () => {
	test("the fake distinguishes equal sets with different FIB winners", async () => {
		// Given: foreign precedes owned at the same metric.
		const table = new DefaultRouteTable([FOREIGN, OWNED, SECOND]);
		const before = table.orderedRows();
		const set = table.rows();
		const winner = await table.runner("ip", FIB);
		// When: the same row is deleted and wrongly prepended by a rollback.
		await table.runner("ip", ["route", "del", ...OWNED.split(" ")]);
		await table.runner("ip", ["route", "prepend", ...OWNED.split(" ")]);
		// Then: a set-only assertion misses the regression; ordered/FIB assertions see it.
		expect(table.rows()).toEqual(set);
		expect(table.orderedRows()).not.toEqual(before);
		expect(await table.runner("ip", FIB)).not.toBe(winner);
	});

	test("distinct staging preserves the old losing position on verification rejection", async () => {
		// Given: renewal overtook the old preference, and another NIC can be staged.
		const table = new DefaultRouteTable([FOREIGN, OWNED, SECOND, THIRD]);
		const before = table.orderedRows();
		const runner: typeof run = (bin, args, opts) =>
			args.includes("get")
				? Promise.resolve(FOREIGN)
				: table.runner(bin, args, opts);
		// When: verification rejects the distinct replacement.
		await expect(setDefaultRoute("routec", { runner })).rejects.toMatchObject({
			reason: "apply-failed",
		});
		// Then: the old row was never removed, and both order and winner survive.
		expect(table.orderedRows()).toEqual(before);
		expect(await table.runner("ip", FIB)).toBe(FOREIGN);
		expect(table.mutations.map((args) => args[1])).toEqual(["prepend", "del"]);
	});

	for (const position of ["first", "last"] as const)
		test(`same-identity rejection restores the old ${position} endpoint`, async () => {
			// Given: proof is overridden while the old row occupies a representable endpoint.
			const rows =
				position === "first"
					? [OWNED, FOREIGN, SECOND]
					: [FOREIGN, OWNED, SECOND];
			const table = new DefaultRouteTable(rows);
			const before = table.orderedRows();
			const runner: typeof run = (bin, args, opts) =>
				args.includes("get")
					? Promise.resolve(FOREIGN)
					: table.runner(bin, args, opts);
			// When: re-prepend succeeds but its verification rejects.
			await expect(setDefaultRoute("routeb", { runner })).rejects.toMatchObject(
				{ reason: "apply-failed" },
			);
			// Then: restoration uses the snapshot's position, not its metric alone.
			expect(table.orderedRows()).toEqual(before);
			expect(table.mutations.at(-1)?.[1]).toBe(
				position === "first" ? "prepend" : "append",
			);
		});

	test("verification rejection with no prior preference leaves no ownership behind", async () => {
		// Given: only the original foreign defaults exist.
		const table = new DefaultRouteTable([FOREIGN, SECOND]);
		const before = table.orderedRows();
		const runner: typeof run = (bin, args, opts) =>
			args.includes("get")
				? Promise.reject(new Error("FIB unreadable"))
				: table.runner(bin, args, opts);
		// When: the new preference cannot be verified.
		await expect(setDefaultRoute("routeb", { runner })).rejects.toMatchObject({
			reason: "apply-failed",
		});
		// Then: successful acquisition is undone rather than restoring a nonexistent old row.
		expect(table.orderedRows()).toEqual(before);
	});

	for (const realm of [1, 2] as const)
		test(`generation ${realm} preserves an interior old row after rejected same-winner repair`, async () => {
			// Given: tagged ownership is between two foreign equal-metric anchors.
			const table = new DefaultRouteTable([
				FOREIGN,
				`${OWNED} realm ${realm}`,
				"default dev tail proto 17 metric 0",
				SECOND,
			]);
			const before = table.orderedRows();
			const runner: typeof run = (bin, args, opts) =>
				args.includes("get")
					? Promise.resolve(FOREIGN)
					: table.runner(bin, args, opts);
			// When: proof rejects the alternate generation before any old-row retirement.
			await expect(setDefaultRoute("routeb", { runner })).rejects.toMatchObject(
				{ reason: "apply-failed" },
			);
			// Then: deleting only the new generation restores the exact interior position.
			expect(table.orderedRows()).toEqual(before);
			expect(table.mutations.map((args) => args[1])).toEqual([
				"prepend",
				"del",
			]);
		});

	test("a last irreversible deletion failure unwinds earlier deletions in order", async () => {
		// Given: release puts the interior row last because no insertion can restore it.
		const table = new DefaultRouteTable(
			[
				FOREIGN,
				`${OWNED} realm 1`,
				"default dev tail proto 17 metric 0",
				SECOND,
			],
			[STALE6],
		);
		const before = [table.orderedRows(), table.orderedRows(6)];
		table.failMutation = 2;
		// When: the final deletion fails atomically after the IPv6 row was removed.
		await expect(
			setDefaultRoute(undefined, { runner: table.runner }),
		).rejects.toMatchObject({ reason: "apply-failed" });
		// Then: the interior row never moved and the earlier IPv6 deletion was undone.
		expect([table.orderedRows(), table.orderedRows(6)]).toEqual(before);
	});

	test("a later retirement failure restores the old endpoint across families", async () => {
		// Given: distinct staging will succeed before the final IPv6 deletion fails.
		const table = new DefaultRouteTable(
			[FOREIGN, OWNED, SECOND, THIRD],
			[STALE6],
		);
		const before = [table.orderedRows(), table.orderedRows(6)];
		table.failMutation = 3;
		// When: the transaction unwinds the staged replacement and earlier deletion.
		await expect(
			setDefaultRoute("routec", { runner: table.runner }),
		).rejects.toMatchObject({ reason: "apply-failed" });
		// Then: the full ordered pre-state and its unrelated winner are restored.
		expect([table.orderedRows(), table.orderedRows(6)]).toEqual(before);
		expect(await table.runner("ip", FIB)).toBe(FOREIGN);
	});

	for (const failure of ["staged-delete", "old-append"] as const)
		test(`${failure} rollback failure retains both causes without claiming restoration`, async () => {
			// Given: verification fails, and its undo operation will also be refused.
			const table = new DefaultRouteTable([FOREIGN, OWNED, SECOND, THIRD]);
			const runner: typeof run = (bin, args, opts) => {
				if (args.includes("get")) return Promise.resolve(FOREIGN);
				if (
					(failure === "old-append" && args.includes("append")) ||
					(failure === "staged-delete" &&
						args.includes("del") &&
						args.includes("routec"))
				)
					return Promise.reject(new Error("rollback refused"));
				return table.runner(bin, args, opts);
			};
			// When: acquisition rejects and rollback fails inside that failure.
			const error: unknown = await setDefaultRoute(
				failure === "old-append" ? "routeb" : "routec",
				{ runner },
			).catch((cause: unknown) => cause);
			// Then: both causes are visible; all foreign routes remain exactly intact.
			expect(error).toBeInstanceOf(GatewayRouteError);
			if (
				!(error instanceof GatewayRouteError) ||
				!(error.cause instanceof AggregateError)
			)
				throw new Error("aggregate missing");
			expect(error.cause.errors).toHaveLength(2);
			expect(table.rows().filter((row) => !row.includes("proto 242"))).toEqual(
				[FOREIGN, SECOND, THIRD].sort(),
			);
		});

	for (const topology of ["interior", "multiple-owned", "IPv6-tie"] as const)
		test(`${topology} refuses before mutation when exact restoration is unavailable`, async () => {
			// Given: this snapshot has no safe supported insertion operation for an owned row.
			const tail = "default dev tail proto 17 metric 0";
			const table =
				topology === "IPv6-tie"
					? new DefaultRouteTable(
							[FOREIGN, SECOND],
							[
								"default dev routea proto 9 metric 36",
								STALE6,
								STALE6.replace("absent", "second"),
							],
						)
					: new DefaultRouteTable([
							FOREIGN,
							OWNED,
							SECOND,
							topology === "interior" ? tail : tail.replace("17", "242"),
						]);
			const before = [table.orderedRows(), table.orderedRows(6)];
			// When: release would need an unprovable rollback on a later failure.
			await expect(
				setDefaultRoute(topology === "interior" ? "routeb" : undefined, {
					runner: table.runner,
				}),
			).rejects.toMatchObject({ reason: "rollback-order-unavailable" });
			// Then: the refusal leaves the entire ordered snapshot unmodified.
			expect(table.mutations).toEqual([]);
			expect([table.orderedRows(), table.orderedRows(6)]).toEqual(before);
		});

	for (const tableName of [undefined, "254", "100001", "main"] as const)
		test(`FIB proof admits only main-table numeric notation (${tableName ?? "omitted"})`, async () => {
			// Given: all preference attributes match; only table provenance differs.
			const [route] = readDefaultRoutes(OWNED, 4);
			if (!route) throw new Error("fixture missing");
			const runner: typeof run = async () =>
				`${OWNED}${tableName === undefined ? "" : ` table ${tableName}`}`;
			// When: the production FIB predicate reads this result.
			const selected = await fibChoosesPreference(route, { runner, family: 4 });
			// Then: private tables cannot impersonate the reserved main-table preference.
			expect(selected).toBe(tableName === undefined || tableName === "254");
		});
});
