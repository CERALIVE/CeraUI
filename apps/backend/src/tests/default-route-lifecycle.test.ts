import { describe, expect, test } from "bun:test";
import {
	GatewayRouteError,
	HOST_ROUTE_PROTOCOL,
	setDefaultRoute,
} from "../modules/network/default-route.ts";
import { readDefaultRoutes } from "../modules/network/default-route-model.ts";
import { GatewayRoutePreference } from "../modules/network/gateway-route-lifecycle.ts";
import { DefaultRouteTable } from "./helpers/default-route-table.ts";

const BASELINE = [
	"default via 192.0.2.1 dev uplink-a proto 16 src 192.0.2.2 metric 37",
	"default via 198.51.100.1 dev uplink-b proto 16 src 198.51.100.2 metric 83",
	"default via 192.0.2.1 dev uplink-c proto 16 src 192.0.2.2 metric 51",
] as const;
const V6 = [
	"default via fe80::1 dev uplink-a proto 9 metric 37 expires 120sec pref medium",
	"default via fe80::2 dev uplink-b proto 9 metric 83 expires 180sec pref high",
] as const;
const STALE = `default via 203.0.113.1 dev absent proto ${HOST_ROUTE_PROTOCOL} metric 10`;

describe("owned host preference lifecycle", () => {
	test("the route-table fake enforces exact add/delete and isolates address families", async () => {
		// Given: independent route tables.
		const table = new DefaultRouteTable(BASELINE, V6);
		// When: the injected runner mutates an IPv6 row.
		await table.runner("ip", ["-6", "route", "del", ...V6[0].split(" ")]);
		// Then: IPv4 is untouched and duplicate deletion fails like a kernel command.
		expect(table.rows()).toEqual([...BASELINE].sort());
		expect(table.rows(6)).toEqual([V6[1]]);
		await expect(
			table.runner("ip", ["-6", "route", "del", ...V6[0].split(" ")]),
		).rejects.toThrow("route absent");
	});

	for (const family of [4, 6] as const) {
		test(`IPv${family} keeps foreign routes and gives the winner the lowest metric`, async () => {
			// Given: DHCP/RA defaults including an otherwise lower-metric competitor.
			const table = new DefaultRouteTable(BASELINE, V6);
			const baseline = table.rows(family);
			// When: repository ranking elects uplink-b.
			await setDefaultRoute("uplink-b", { runner: table.runner, family });
			// Then: only one proven-owned route differs, and lowest-metric selection wins.
			const routes = readDefaultRoutes(table.rows(family).join("\n"), family);
			expect(
				routes
					.filter((route) => !route.owned)
					.map((route) => route.tokens.join(" ")),
			).toEqual(baseline);
			expect(routes.filter((route) => route.owned)).toHaveLength(1);
			expect([...routes].sort((a, b) => a.metric - b.metric)[0]?.ifname).toBe(
				"uplink-b",
			);
		});

		test(`IPv${family} re-election performs zero mutations`, async () => {
			// Given: an applied owned preference.
			const table = new DefaultRouteTable(BASELINE, V6);
			await setDefaultRoute("uplink-b", { runner: table.runner, family });
			table.mutations.length = 0;
			// When: the same winner is reconciled again.
			await setDefaultRoute("uplink-b", { runner: table.runner, family });
			// Then: no ip write is submitted.
			expect(table.mutations).toEqual([]);
		});

		test(`IPv${family} partial failure restores the exact pre-state`, async () => {
			// Given: both families have stale owned rows; a later retirement will fail.
			const table = new DefaultRouteTable(
				[...BASELINE, STALE],
				[
					...V6,
					`default via fe80::9 dev absent proto ${HOST_ROUTE_PROTOCOL} metric 10`,
				],
			);
			const before = [table.rows(), table.rows(6)];
			const ordered = [table.orderedRows(), table.orderedRows(6)];
			table.failMutation = 3;
			// When: the staged preference cannot finish retiring the old rows.
			await expect(
				setDefaultRoute("uplink-b", { runner: table.runner, family }),
			).rejects.toBeInstanceOf(GatewayRouteError);
			// Then: successful earlier operations are undone across both families.
			expect([table.rows(), table.rows(6)]).toEqual(before);
			expect([table.orderedRows(), table.orderedRows(6)]).toEqual(ordered);
		});
	}

	test("startup sweeps crash residue in both families before any election", async () => {
		// Given: a fresh controller over defaults left by a prior process.
		const table = new DefaultRouteTable(
			[...BASELINE, STALE],
			[
				...V6,
				`default via fe80::9 dev absent proto ${HOST_ROUTE_PROTOCOL} metric 10`,
			],
		);
		const preference = new GatewayRoutePreference(table.runner);
		// When: backend route initialization completes.
		await preference.start();
		// Then: only the original DHCP/RA rows survive.
		expect([table.rows(), table.rows(6)]).toEqual([
			[...BASELINE].sort(),
			[...V6].sort(),
		]);
	});

	test("release removes the preference when its interface disappears", async () => {
		// Given: a winning interface is removed along with its foreign kernel route.
		const table = new DefaultRouteTable(BASELINE);
		await setDefaultRoute("uplink-b", { runner: table.runner });
		table.routes.get(4)?.delete(BASELINE[1]);
		// When: an empty election releases the backend preference.
		await setDefaultRoute(undefined, { runner: table.runner });
		// Then: no ghost default remains for the removed NIC.
		expect(table.rows()).toEqual([BASELINE[0], BASELINE[2]].sort());
	});

	test("family change retires the old-family preference", async () => {
		// Given: IPv4 previously won.
		const table = new DefaultRouteTable(BASELINE, V6);
		await setDefaultRoute("uplink-b", { runner: table.runner });
		// When: the election changes to IPv6.
		await setDefaultRoute("uplink-b", { runner: table.runner, family: 6 });
		// Then: IPv4 is exactly its baseline; only IPv6 carries a preference.
		expect(table.rows()).toEqual([...BASELINE].sort());
		expect(
			readDefaultRoutes(table.rows(6).join("\n"), 6).filter(
				(route) => route.owned,
			),
		).toHaveLength(1);
	});

	test("shutdown drains an in-flight election and refuses late applications", async () => {
		// Given: an initialized controller with a queued election.
		const table = new DefaultRouteTable(BASELINE);
		const preference = new GatewayRoutePreference(table.runner);
		await preference.start();
		const apply = preference.apply("uplink-b");
		// When: shutdown overlaps the pending apply continuation.
		const stop = preference.stop();
		await Promise.allSettled([apply, stop]);
		// Then: baseline survives and late work cannot recreate a preference.
		expect(table.rows()).toEqual([...BASELINE].sort());
		await expect(preference.apply("uplink-b")).rejects.toBeInstanceOf(
			GatewayRouteError,
		);
	});

	test("many seeded random election flips never ratchet and release returns to baseline", async () => {
		// Given: fixed foreign metrics and a repeatable pseudo-random sequence.
		const table = new DefaultRouteTable(BASELINE, V6);
		let seed = 379;
		// When: 512 random winner/family/release transitions occur.
		for (let index = 0; index < 512; index++) {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			const family = seed % 2 ? 4 : 6;
			const winner = [undefined, "uplink-a", "uplink-b"][seed % 3];
			await setDefaultRoute(winner, { runner: table.runner, family });
			for (const current of [4, 6] as const) {
				const routes = readDefaultRoutes(
					table.rows(current).join("\n"),
					current,
				);
				expect(
					routes
						.filter((route) => !route.owned)
						.map((route) => route.tokens.join(" ")),
				).toEqual([...(current === 4 ? BASELINE : V6)].sort());
				expect(routes.every((route) => route.metric <= 83)).toBe(true);
				const expectedPreference = current === family && winner === "uplink-b";
				expect(
					routes
						.filter((route) => route.owned)
						.map((route) => ({
							ifname: route.ifname,
							family: route.family,
							metric: route.metric,
						})),
				).toEqual(
					expectedPreference
						? [{ ifname: "uplink-b", family, metric: 36 }]
						: [],
				);
				if (current === family && winner !== undefined)
					expect(
						[...routes].sort((a, b) => a.metric - b.metric)[0]?.ifname,
					).toBe(winner);
			}
			expect(
				[...table.rows(), ...table.rows(6)].filter((row) =>
					row.includes(`proto ${HOST_ROUTE_PROTOCOL}`),
				).length,
			).toBeLessThanOrEqual(1);
		}
		await setDefaultRoute(undefined, { runner: table.runner });
		// Then: no historical preference remains in either family.
		expect([table.rows(), table.rows(6)]).toEqual([
			[...BASELINE].sort(),
			[...V6].sort(),
		]);
	});

	for (const family of [4, 6] as const)
		test(`IPv${family} handles the competitor metric floor without editing foreign routes`, async () => {
			// Given: a competitor already at the kernel metric floor.
			const routes =
				family === 4
					? [BASELINE[0].replace("37", "0"), BASELINE[1]]
					: [V6[0].replace("37", "1"), V6[1]];
			const table = new DefaultRouteTable(
				family === 4 ? routes : [],
				family === 6 ? routes : [],
			);
			// When: the otherwise losing uplink is elected.
			if (family === 6) {
				await expect(
					setDefaultRoute("uplink-b", { runner: table.runner, family }),
				).rejects.toMatchObject({ reason: "metric-exhausted" });
				expect(table.mutations).toEqual([]);
			} else {
				await setDefaultRoute("uplink-b", { runner: table.runner, family });
				expect(table.mutations).toEqual([
					[
						"route",
						"prepend",
						"default",
						"via",
						"198.51.100.1",
						"dev",
						"uplink-b",
						"src",
						"198.51.100.2",
						"proto",
						"242",
						"metric",
						"0",
					],
				]);
				expect(
					await table.runner("ip", [
						"route",
						"get",
						"203.0.113.254",
						"fibmatch",
					]),
				).toMatch(/dev uplink-b\b.*proto 242\b/);
			}
			// Then: no competitor or prior preference is touched to fabricate success.
			for (const route of routes) expect(table.rows(family)).toContain(route);
		});
});
