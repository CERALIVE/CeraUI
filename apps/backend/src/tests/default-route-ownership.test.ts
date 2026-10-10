import { describe, expect, test } from "bun:test";
import { setDefaultRoute } from "../modules/network/default-route.ts";
import { DefaultRouteTable } from "./helpers/default-route-table.ts";

const BASELINE = [
	"default via 192.0.2.1 dev uplink-a proto dhcp src 192.0.2.2 metric 37",
	"default via 198.51.100.1 dev uplink-b proto dhcp src 198.51.100.2 metric 83",
] as const;

describe("F-ROUTE-1 reproduction", () => {
	test("preserves the competitor byte-for-byte when another uplink wins (B1)", async () => {
		// Given: DHCP owns both defaults.
		const table = new DefaultRouteTable(BASELINE);
		// When: the higher-metric interface wins repository election.
		await setDefaultRoute("uplink-b", { runner: table.runner });
		// Then: the competitor's exact original route is still present.
		expect(table.rows()).toContain(BASELINE[0]);
	});

	test("returns to the baseline when election returns to its original winner (B2)", async () => {
		// Given: a preference for the otherwise losing NIC.
		const table = new DefaultRouteTable(BASELINE);
		await setDefaultRoute("uplink-b", { runner: table.runner });
		// When: the baseline's strictly-lowest NIC wins again.
		await setDefaultRoute("uplink-a", { runner: table.runner });
		// Then: neither a demotion nor a redundant preference survives.
		expect(table.rows()).toEqual([...BASELINE].sort());
	});

	test("keeps metrics bounded when elections repeatedly flip (B3)", async () => {
		// Given: an unchanged DHCP baseline and a repeatable flip sequence.
		const table = new DefaultRouteTable(BASELINE);
		// When: many elections alternate without any NM intervention.
		for (let index = 0; index < 32; index++)
			await setDefaultRoute(index % 2 ? "uplink-a" : "uplink-b", {
				runner: table.runner,
			});
		// Then: election history cannot become an ever-increasing metric ceiling.
		expect(
			Math.max(...table.rows().map((row) => Number(row.split("metric ")[1]))),
		).toBeLessThanOrEqual(83);
	});
});
