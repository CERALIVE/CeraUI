/// <reference lib="es2022" />
import { describe, expect, test } from "bun:test";
import type { run } from "../helpers/run.ts";
import {
	GatewayRouteError,
	HOST_ROUTE_PROTOCOL,
	setDefaultRoute,
} from "../modules/network/default-route.ts";
import { GatewayRoutePreference } from "../modules/network/gateway-route-lifecycle.ts";
import { DefaultRouteTable } from "./helpers/default-route-table.ts";

const BASELINE = [
	"default dev uplink-a proto 16 metric 37",
	"default dev uplink-b proto 16 metric 83",
] as const;

describe("host preference boundary and transaction edges", () => {
	test("an already strictly-lowest winner needs no owned route", async () => {
		// Given: the elected NIC already wins naturally.
		const table = new DefaultRouteTable(BASELINE);
		// When: it is elected.
		await setDefaultRoute("uplink-a", { runner: table.runner });
		// Then: no route mutation occurs, even on the first election.
		expect(table.mutations).toEqual([]);
	});

	test("equal metrics create a strictly-lower owned preference", async () => {
		// Given: default-route order alone would otherwise settle an equal-metric tie.
		const table = new DefaultRouteTable([
			BASELINE[0],
			BASELINE[1].replace("83", "37"),
		]);
		// When: the second interface is elected.
		await setDefaultRoute("uplink-b", { runner: table.runner });
		// Then: the backend preference beats both originals without changing them.
		expect(table.rows()).toContain(
			`default dev uplink-b proto ${HOST_ROUTE_PROTOCOL} metric 36`,
		);
		expect(table.rows()).toContain(BASELINE[0]);
	});

	test("a named-table fallback gains provable ownership rather than an unmarked replay", async () => {
		// Given: only the elected NIC's legacy table has its default.
		const table = new DefaultRouteTable([BASELINE[0]]);
		const runner: typeof run = (bin, args, opts) =>
			args.includes("table")
				? Promise.resolve(BASELINE[1])
				: table.runner(bin, args, opts);
		// When: the legacy default is imported into main.
		await setDefaultRoute("uplink-b", { runner });
		// Then: release can remove precisely the backend's copy.
		expect(table.rows()).toContain(
			`default dev uplink-b proto ${HOST_ROUTE_PROTOCOL} metric 36`,
		);
		await setDefaultRoute(undefined, { runner });
		expect(table.rows()).toEqual([BASELINE[0]]);
	});

	test("a duplicate DHCP renewal cannot produce a second competitor route", async () => {
		// Given: NM retains or reasserts its original while a preference is active.
		const table = new DefaultRouteTable(BASELINE);
		await setDefaultRoute("uplink-b", { runner: table.runner });
		table.routes.get(4)?.add(BASELINE[0]);
		// When: NM's naturally-lowest NIC wins again.
		await setDefaultRoute("uplink-a", { runner: table.runner });
		// Then: the exact two foreign routes survive, with no stray metric copy.
		expect(table.rows()).toEqual([...BASELINE].sort());
	});

	test("failure deleting a later owned row restores every earlier deletion", async () => {
		// Given: two owned rows from a crash and an injected second-delete failure.
		const rows = [
			...BASELINE,
			`default dev absent-a proto ${HOST_ROUTE_PROTOCOL} metric 10`,
			`default dev absent-b proto ${HOST_ROUTE_PROTOCOL} metric 11`,
		];
		const table = new DefaultRouteTable(rows);
		const before = table.orderedRows();
		table.failMutation = 2;
		// When: startup cleanup cannot finish.
		await expect(
			setDefaultRoute(undefined, { runner: table.runner }),
		).rejects.toBeInstanceOf(GatewayRouteError);
		// Then: even cleanup retains an exact, replayable pre-state.
		expect(table.rows()).toEqual([...rows].sort());
		expect(table.orderedRows()).toEqual(before);
	});

	test("rollback failure remains in the typed cause rather than reporting success", async () => {
		// Given: staging succeeds, but old-route retirement and staged-route rollback fail.
		const owned = `default dev absent proto ${HOST_ROUTE_PROTOCOL} metric 10`;
		const table = new DefaultRouteTable([...BASELINE, owned]);
		const runner: typeof run = (bin, args, opts) =>
			args.includes("del")
				? Promise.reject(new Error("delete refused"))
				: table.runner(bin, args, opts);
		// When: election fails with an unsuccessful rollback.
		const result = await setDefaultRoute("uplink-b", { runner }).catch(
			(error: unknown) => error,
		);
		// Then: both failure causes survive; foreign rows have still not been modified.
		expect(result).toBeInstanceOf(GatewayRouteError);
		if (
			!(result instanceof GatewayRouteError) ||
			!(result.cause instanceof AggregateError)
		)
			throw new Error("typed transaction error missing");
		expect(result.cause.errors).toHaveLength(2);
		expect(table.rows()).toEqual(
			[
				...BASELINE,
				owned,
				`default dev uplink-b proto ${HOST_ROUTE_PROTOCOL} metric 36`,
			].sort(),
		);
	});

	test("shutdown drains an apply already reading the kernel snapshot", async () => {
		// Given: the next apply is parked at the ip read boundary.
		const table = new DefaultRouteTable(BASELINE);
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let hold = false;
		const runner: typeof run = async (bin, args, opts) => {
			if (hold && args.includes("show")) {
				hold = false;
				entered.resolve();
				await resume.promise;
			}
			return table.runner(bin, args, opts);
		};
		const preference = new GatewayRoutePreference(runner);
		await preference.start();
		hold = true;
		const apply = preference.apply("uplink-b");
		await entered.promise;
		// When: shutdown queues behind the submitted apply and that read resumes.
		const stop = preference.stop();
		resume.resolve();
		await Promise.all([apply, stop]);
		// Then: the applied preference was drained and removed before stop returned.
		expect(table.mutations.map((args) => args[1])).toEqual(["add", "del"]);
		expect(table.rows()).toEqual([...BASELINE].sort());
	});
});
