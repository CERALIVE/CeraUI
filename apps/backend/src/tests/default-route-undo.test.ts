/// <reference lib="es2022" />
import { describe, expect, test } from "bun:test";
import type { run } from "../helpers/run.ts";
import { setDefaultRoute } from "../modules/network/default-route.ts";
import { GatewayRouteError } from "../modules/network/default-route-model.ts";
import { DefaultRouteTable } from "./helpers/default-route-table.ts";

const BASELINE = [
	"default via 192.0.2.1 dev routea proto 16 metric 50",
	"default via 198.51.100.1 dev routeb proto 16 metric 702",
	"default via 198.18.0.1 dev routec proto 16 metric 703",
] as const;
const STALE6 = "default via fe80::2 dev routeb proto 242 metric 7";
const STAGED = "default via 198.18.0.1 dev routec proto 242 metric 49";
const OLD = "default via 198.51.100.1 dev routeb proto 242 metric 49";
const FIB = ["-N", "route", "get", "8.8.8.8", "fibmatch"];

describe("undo-time route priority", () => {
	test("ordinary add rejects the staged priority even for another endpoint", async () => {
		// Given: the replacement still occupies priority 49 during undo.
		const table = new DefaultRouteTable([...BASELINE, STAGED]);
		// When: ordinary add tries to restore a distinct old endpoint at that priority.
		const error: unknown = await table
			.runner("ip", ["route", "add", ...OLD.split(" ")])
			.catch((cause: unknown) => cause);
		// Then: the fake returns the same EEXIST/nonzero exit as the real kernel.
		expect(error).toMatchObject({ errno: "EEXIST", exitCode: 2 });
		expect(table.orderedRows()).toEqual([STAGED, ...BASELINE]);
	});

	test("RT4-M1 a late IPv6 refusal restores the untied IPv4 preference and FIB exactly", async () => {
		// Given: routeb owns the sole priority-49 alias and stale IPv6 ownership remains.
		const table = new DefaultRouteTable(BASELINE);
		await setDefaultRoute("routeb", { runner: table.runner });
		table.routes.get(6)?.add(STALE6);
		const before = [table.orderedRows(), table.orderedRows(6)];
		const beforeFib = await table.runner("ip", FIB);
		const runner: typeof run = (bin, args, opts) => {
			if (args.includes("-6") && args.includes("del")) {
				expect(table.orderedRows()[0]).toBe(STAGED);
				expect(table.rows()).not.toContain(OLD);
				return Promise.reject(
					new Error("RTNETLINK answers: Operation not permitted"),
				);
			}
			return table.runner(bin, args, opts);
		};
		// When: stage and proof succeed, old IPv4 retires, then only IPv6 retirement refuses.
		const error: unknown = await setDefaultRoute("routec", { runner }).catch(
			(cause: unknown) => cause,
		);
		// Then: no self-inflicted undo failure occurs; ordered tables and old winner survive.
		expect(error).toBeInstanceOf(GatewayRouteError);
		if (
			!(error instanceof GatewayRouteError) ||
			!(error.cause instanceof AggregateError)
		)
			throw new Error("aggregate missing");
		expect(error.cause.errors).toHaveLength(1);
		expect(error.cause.errors[0]).toMatchObject({
			message: "RTNETLINK answers: Operation not permitted",
		});
		expect([table.orderedRows(), table.orderedRows(6)]).toEqual(before);
		expect(await table.runner("ip", FIB)).toBe(beforeFib);
	});
});
