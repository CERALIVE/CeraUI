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
import {
	NETIF_ERR_HOTSPOT,
	type NetworkInterface,
} from "../modules/network/network-interfaces.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";
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

describe("gateway election current candidates", () => {
	const routes = [
		BASELINE[0].replace("37", "83"),
		BASELINE[1].replace("83", "37"),
	];
	const netif = (ip: string): NetworkInterface => ({
		ip,
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
	});
	const reachable = deriveVerdict([
		{
			origin: {
				url: "https://packages.example.test",
				host: "packages.example.test",
				scheme: "https",
				probeUrl: "https://packages.example.test/",
			},
			ipv4: "ok",
			ipv6: "no_route",
		},
	]);

	test.each([
		"health exclusion",
		"address change",
		"early sweep",
		"release inventory",
		"ordinary election",
	] as const)("discards natural recovery evidence after %s", async (change) => {
		const table = new DefaultRouteTable(BASELINE);
		await setDefaultRoute("uplink-b", { runner: table.runner });
		const before = table.orderedRows();
		table.mutations.length = 0;
		const current = {
			"uplink-a": netif("192.0.2.2"),
			"uplink-b": netif("198.51.100.2"),
		};
		let eligible = true;
		let now = 0;
		let deferred = false;
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const base = election(table);
		let releases = 0;
		const deps: GatewayElectionDeps = {
			...base,
			routeRunner: table.runner,
			now: () => now,
			interfaces: () => current,
			eligible: (name) => name !== "uplink-a" || eligible,
			installRoute: async () => {},
			releaseRoutes: async (condition) => {
				if (change === "release inventory") {
					entered.resolve();
					await resume.promise;
				}
				await setDefaultRoute(undefined, {
					runner: table.runner,
					...(condition ? { releaseCondition: condition } : {}),
				});
				releases++;
			},
			probes: {
				...base.probes,
				probeRepository: async (name) => {
					if (
						deferred &&
						change !== "release inventory" &&
						(change !== "ordinary election" || name === "uplink-b")
					) {
						entered.resolve();
						await resume.promise;
					}
					return reachable;
				},
			},
		};
		if (change !== "early sweep" && change !== "ordinary election") {
			await updateGw(deps);
			now = 5_000;
			await updateGw(deps);
		}
		now = 10_000;
		deferred = true;
		const sweep = updateGw(deps);
		await entered.promise;
		if (change === "address change") current["uplink-a"].ip = "192.0.2.3";
		else eligible = false;
		resume.resolve();
		expect(await sweep).toBe(false);
		expect(releases).toBe(0);
		expect(table.mutations).toEqual([]);
		expect(table.orderedRows()).toEqual(before);
		// Restoring the roster must require three fresh observations and dwell.
		eligible = true;
		deferred = false;
		for (const at of [15_000, 20_000]) {
			now = at;
			await updateGw(deps);
			expect(releases).toBe(0);
		}
		now = 25_000;
		expect(await updateGw(deps)).toBe(true);
		expect(releases).toBe(1);
		expect(table.rows()).toEqual([...BASELINE].sort());
	});

	for (const outcome of ["success", "failure"] as const) {
		test.each([
			"replacement address",
			"in-place address",
			"removed interface",
			"health exclusion",
			"hotspot exclusion",
			"new candidate",
		] as const)(`withholds stale ${outcome} after %s`, async (change) => {
			const table = new DefaultRouteTable(routes);
			await setDefaultRoute("uplink-a", { runner: table.runner });
			const before = table.orderedRows();
			expect(before).toHaveLength(routes.length + 1);
			table.mutations.length = 0;
			const current: Record<string, NetworkInterface> = {
				"uplink-a": netif("192.0.2.2"),
				"uplink-b": netif("198.51.100.2"),
			};
			let eligible = true;
			let validations = 0;
			const actions: string[] = [];
			const base = election(table);
			const entered = Promise.withResolvers<void>();
			const probe =
				Promise.withResolvers<
					Awaited<ReturnType<typeof base.probes.probeRepository>>
				>();
			const deps: GatewayElectionDeps = {
				...base,
				resolve: async () => ({
					addrs: ["203.0.113.10"],
					fromCache: false,
				}),
				validateDns: () => validations++,
				interfaces: () => current,
				eligible: (name) => name !== "uplink-b" || eligible,
				installRoute: async (name, family) => {
					actions.push(`install:${name}:${family}`);
					await base.installRoute(name, family);
				},
				releaseRoutes: async (condition) => {
					actions.push("release");
					await base.releaseRoutes?.(condition);
				},
				probes: {
					...base.probes,
					probeRepository: async (name) => {
						if (name !== "uplink-b") return base.probes.probeRepository(name);
						entered.resolve();
						return probe.promise;
					},
				},
			};
			const sweep = updateGw(deps);
			await entered.promise;
			switch (change) {
				case "replacement address":
					current["uplink-b"] = netif("198.51.100.3");
					break;
				case "in-place address":
					current["uplink-b"].ip = "198.51.100.3";
					break;
				case "removed interface":
					delete current["uplink-b"];
					break;
				case "health exclusion":
					eligible = false;
					break;
				case "hotspot exclusion":
					current["uplink-b"].error = NETIF_ERR_HOTSPOT;
					break;
				case "new candidate":
					current["uplink-c"] = netif("203.0.113.2");
					break;
			}
			probe.resolve(
				outcome === "success"
					? reachable
					: await base.probes.probeRepository("uplink-b"),
			);
			const result = await sweep;
			expect(table.mutations).toEqual([]);
			expect(actions).toEqual([]);
			expect(table.orderedRows()).toEqual(before);
			expect(validations).toBe(0);
			expect(result).toBe(false);
		});
	}

	test.each(["unchanged", "counters", "reordered", "disabled"] as const)(
		"accepts a current winner with %s records",
		async (change) => {
			const table = new DefaultRouteTable(routes);
			await setDefaultRoute("uplink-a", { runner: table.runner });
			table.mutations.length = 0;
			let current: Record<string, NetworkInterface> = {
				"uplink-a": netif("192.0.2.2"),
				"uplink-b": netif("198.51.100.2"),
			};
			const base = election(table);
			const entered = Promise.withResolvers<void>();
			const probe = Promise.withResolvers<typeof reachable>();
			const actions: string[] = [];
			let validations = 0;
			const deps: GatewayElectionDeps = {
				...base,
				resolve: async () => ({
					addrs: ["203.0.113.10"],
					fromCache: false,
				}),
				interfaces: () => current,
				validateDns: () => validations++,
				installRoute: async (name, family) => {
					actions.push(`install:${name}:${family}`);
					await base.installRoute(name, family);
				},
				probes: {
					...base.probes,
					probeRepository: async () => {
						entered.resolve();
						return probe.promise;
					},
				},
			};
			const sweep = updateGw(deps);
			await entered.promise;
			if (change === "counters") {
				current["uplink-b"].txb++;
				current["uplink-b"].rxb++;
			} else if (change === "reordered") {
				current = {
					"uplink-b": current["uplink-b"],
					"uplink-a": current["uplink-a"],
				};
			} else if (change === "disabled") {
				current["uplink-b"].enabled = false;
			}
			probe.resolve(reachable);
			expect(await sweep).toBe(true);
			expect(actions).toEqual(["install:uplink-b:4"]);
			expect(validations).toBe(1);
			expect(table.mutations).toHaveLength(1);
			expect(table.rows()).toEqual([...routes].sort());
		},
	);

	test.each(["known failure", "unknown"] as const)(
		"keeps current %s release semantics",
		async (outcome) => {
			const table = new DefaultRouteTable(routes);
			await setDefaultRoute("uplink-a", { runner: table.runner });
			const before = table.rows();
			table.mutations.length = 0;
			const base = election(table);
			let releases = 0;
			const deps: GatewayElectionDeps = {
				...base,
				interfaces: () => ({ "uplink-b": netif("198.51.100.2") }),
				releaseRoutes: async (condition) => {
					releases++;
					await base.releaseRoutes?.(condition);
				},
				probes: {
					...base.probes,
					probeRepository:
						outcome === "unknown"
							? async () => deriveVerdict([])
							: base.probes.probeRepository,
				},
			};
			expect(await updateGw(deps)).toBe(false);
			expect(releases).toBe(outcome === "known failure" ? 1 : 0);
			expect(table.mutations).toHaveLength(outcome === "known failure" ? 1 : 0);
			expect(table.rows()).toEqual(
				outcome === "known failure" ? [...routes].sort() : before,
			);
		},
	);
});
