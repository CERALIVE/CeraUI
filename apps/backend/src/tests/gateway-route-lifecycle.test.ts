import { afterEach, describe, expect, test } from "bun:test";
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";
import {
	HOST_ROUTE_PROTOCOL,
	setDefaultRoute,
} from "../modules/network/default-route.ts";
import { GatewayRoutePreference } from "../modules/network/gateway-route-lifecycle.ts";
import {
	type GatewayElectionDeps,
	updateGw,
} from "../modules/network/gateways.ts";
import { DefaultRouteTable } from "./helpers/default-route-table.ts";

const BASELINE = [
	"default via 192.0.2.1 dev uplink-a proto 16 metric 37",
	"default via 198.51.100.1 dev uplink-b proto 16 metric 83",
] as const;

function election(table: DefaultRouteTable): GatewayElectionDeps {
	return {
		isRealDevice: async () => true,
		resolve: async () => ({ addrs: [], fromCache: false }),
		validateDns: () => {},
		checkConnectivity: async () => false,
		interfaces: () => ({}),
		eligible: () => true,
		defaultInterface: async () => "uplink-b",
		installRoute: (name, family) =>
			setDefaultRoute(name, { runner: table.runner, family }),
		releaseRoutes: () => setDefaultRoute(undefined, { runner: table.runner }),
		probes: {
			probeViaSourceIp: async () => false,
			probeViaDevice: async () => false,
			probeRepository: async () => ({
				verdict: "unreachable",
				ipv4: "no_route",
				ipv6: "no_route",
				used: "none",
				detail: [],
			}),
		},
	};
}

afterEach(resetShutdownForTest);

describe("gateway election and shutdown ownership wiring", () => {
	test("an empty election removes its previous preference", async () => {
		// Given: an owned winner whose interface is absent from the candidate roster.
		const table = new DefaultRouteTable(BASELINE);
		await setDefaultRoute("uplink-b", { runner: table.runner });
		// When: the real coordinator completes an empty election.
		await updateGw(election(table));
		// Then: it releases only its own route, leaving the DHCP baseline intact.
		expect(table.rows()).toEqual([...BASELINE].sort());
	});

	test("a failed release reports failure instead of disarming maintenance", async () => {
		// Given: a preference whose deletion will fail.
		const table = new DefaultRouteTable(BASELINE);
		await setDefaultRoute("uplink-b", { runner: table.runner });
		table.failMutation = table.mutations.length + 1;
		// When: the coordinator tries to release on an empty election.
		const result = await updateGw(election(table));
		// Then: retry remains required and the unchanged preference stays observable.
		expect(result).toBe(false);
		expect(
			table
				.rows()
				.filter((row) => row.includes(`proto ${HOST_ROUTE_PROTOCOL}`)),
		).toHaveLength(1);
	});

	test("termination awaits route teardown before exit", async () => {
		// Given: the controller owns a live preference.
		const table = new DefaultRouteTable(BASELINE);
		const preference = new GatewayRoutePreference(table.runner);
		await preference.apply("uplink-b");
		const finished = Promise.withResolvers<void>();
		let atExit: string[] = [];
		// When: the real termination lifecycle is signalled.
		handleTerminationSignal("SIGTERM", {
			stopGatewayRoutes: () => preference.stop(),
			stopSrtIngest: async () => {},
			stopDmesgWatchers: () => {},
			gracefulShutdown: async () => {},
			exit: () => {
				atExit = table.rows();
				finished.resolve();
			},
		});
		await finished.promise;
		// Then: exit observes the baseline rather than an owned preference.
		expect(atExit).toEqual([...BASELINE].sort());
	});

	test("a boot sweep failure retries before allowing an election", async () => {
		// Given: a crash row and an initial failing deletion.
		const stale = `default via 203.0.113.1 dev absent proto ${HOST_ROUTE_PROTOCOL} metric 10`;
		const table = new DefaultRouteTable([...BASELINE, stale]);
		const preference = new GatewayRoutePreference(table.runner);
		table.failMutation = 1;
		await expect(preference.start()).rejects.toThrow();
		// When: the next election retries the failed startup boundary.
		await preference.apply("uplink-b");
		// Then: the stale interface cannot be carried into the winning preference.
		expect(table.rows()).not.toContain(stale);
		expect(
			table
				.rows()
				.filter((row) => row.includes(`proto ${HOST_ROUTE_PROTOCOL}`)),
		).toHaveLength(1);
	});
});
