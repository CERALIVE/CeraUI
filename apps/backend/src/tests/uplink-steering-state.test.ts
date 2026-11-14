import { describe, expect, test } from "bun:test";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	NETIF_ERR_DUPIPV4,
	NETIF_ERR_HOTSPOT,
	NETIF_ERR_SHAREDLAN,
	type NetworkInterface,
} from "../modules/network/network-interfaces.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import {
	UPLINK_HEALTH_CONFIG,
	UplinkHealthEngine,
	type UplinkHealthOutcome,
	type UplinkHealthRecord,
} from "../modules/network/uplink-health/model.ts";
import {
	planUplinkRoute,
	type UplinkRouteCandidate,
} from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import {
	readDesiredSteeringState,
	type SteeringStateBuilderDeps,
} from "../modules/network/uplink-steering/state-builder.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";
import { scripted } from "./uplink-steering-route-test-fixtures.ts";
import { readReadySteeringState } from "./uplink-steering-test-fixtures.ts";

function netif(
	ip: string,
	netmask = "255.255.255.0",
	error = 0,
): NetworkInterface {
	return {
		ip,
		netmask,
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: error === 0,
		error,
	};
}

function health(
	iface: string,
	state: UplinkHealthRecord["state"],
	weight: number,
): UplinkHealthRecord {
	return {
		iface,
		kind: iface.startsWith("wl") ? "wifi" : "cellular",
		state,
		weight,
		lastTransition: 1,
		staleAt: 10,
		probes: { successes: 0, failures: 0 },
		signals: {},
	};
}

function harness(
	overrides: Partial<SteeringStateBuilderDeps> = {},
): SteeringStateBuilderDeps & { planned: UplinkRouteCandidate[] } {
	const planned: UplinkRouteCandidate[] = [];
	return {
		netifReady: () => true,
		discoverRoutes: async () => [],
		zonesReady: () => true,
		identityCovered: () => true,
		identityDeadlineExpired: () => false,
		interfaces: () => ({
			"clap-wlan0": netif("10.42.0.1", "255.255.255.0", NETIF_ERR_HOTSPOT),
			eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
			wlan0: netif("192.168.2.8"),
			wwan0: netif("100.64.1.2"),
			wwan1: netif("100.64.2.2"),
			br0: netif("172.20.0.1"),
		}),
		health: () => [
			health("wlan0", "degraded", 25),
			health("wwan0", "up", 100),
			health("wwan1", "down", 0),
		],
		wifiIdentity: (ifname) =>
			ifname === "wlan0" ? "wifi-mac:00:11:22:33:44:55" : undefined,
		physicalIdentity: (ifname) => `id-path:${ifname}`,
		markForIdentity: stableUplinkMark,
		isBondCandidate: () => false,
		isClientZone: (ifname) => ifname === "clap-wlan0" || ifname === "eth9",
		planRoute: async (candidate) => {
			planned.push(candidate);
			return { ...candidate, table: candidate.ifname, managed: false };
		},
		...overrides,
		planned,
	};
}

describe("readDesiredSteeringState", () => {
	test.each(["netif", "zones"] as const)(
		"keeps the first plan pending before %s readiness, even with no client zones",
		async (missing) => {
			const h = harness({
				netifReady: () => missing !== "netif",
				zonesReady: () => missing !== "zones",
				interfaces: () => ({}),
			});
			expect(await readDesiredSteeringState(h)).toEqual({
				pending: true,
				netifReady: missing !== "netif",
				reason: missing,
			});
			expect(h.planned).toEqual([]);
		},
	);

	test("holds the first plan for uncovered identities and omits only new identities after apply", async () => {
		const h = harness({ identityCovered: () => false });
		expect(await readDesiredSteeringState(h)).toMatchObject({
			pending: true,
			reason: "identity",
		});
		expect(h.planned).toEqual([]);
		const state = await readReadySteeringState(h, { hasAppliedState: true });
		expect(state.uplinks.map((entry) => entry.ifname)).toEqual(["wlan0"]);
	});

	test("uses the shared identity deadline to plan an uncovered fallback", async () => {
		const h = harness({
			identityCovered: () => false,
			identityDeadlineExpired: () => true,
			physicalIdentity: (ifname) => `ifname:${ifname}`,
		});
		const state = await readReadySteeringState(h);
		expect(
			state.uplinks.find((entry) => entry.ifname === "wwan0")?.identity,
		).toBe("ifname:wwan0");
	});

	test("a populated snapshot without wlan devices is ready without Wi-Fi discovery", async () => {
		const h = harness({ interfaces: () => ({}) });
		expect(await readDesiredSteeringState(h)).toEqual({
			clientZones: [],
			uplinks: [],
			routes: [],
		});
	});

	test("assigns the constructed Dell placeholders two distinct steering marks", async () => {
		try {
			await refreshUsbNetMarkers(
				constructedTwins.map((d) => d.ifname),
				constructedTwinDeps(),
			);
			const h = harness({
				interfaces: () => ({
					eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
					wwu1u4c2: netif("100.64.1.2"),
					wwu1c2: netif("100.64.2.2"),
				}),
				health: () => [],
				physicalIdentity: (ifname) =>
					resolveModemPhysicalIdentity(ifname).identityKey,
			});
			const state = await readReadySteeringState(h);
			expect(state.uplinks).toHaveLength(2);
			expect(new Set(state.uplinks.map((u) => u.mark)).size).toBe(2);
		} finally {
			resetUsbNetMarkers();
		}
	});
	test("derives both client zones and consumes health weights", async () => {
		const h = harness();
		const state = await readReadySteeringState(h);

		expect(state.clientZones).toEqual([
			{ ifname: "clap-wlan0", ipv4Cidr: "10.42.0.0/24" },
			{ ifname: "eth9", ipv4Cidr: "10.43.0.0/24" },
		]);
		expect(
			state.uplinks.map(({ ifname, weight }) => ({ ifname, weight })),
		).toEqual([
			{ ifname: "wlan0", weight: 25 },
			{ ifname: "wwan0", weight: 100 },
		]);
		expect(
			state.uplinks.find((item) => item.ifname === "wlan0")?.identity,
		).toBe("wifi-mac:00:11:22:33:44:55");
		expect(h.planned.map((candidate) => candidate.ifname)).toEqual([
			"wlan0",
			"wwan0",
		]);
	});

	test("defaults an unobserved uplink to full weight during health startup", async () => {
		const h = harness({ health: () => [] });
		const state = await readReadySteeringState(h);

		expect(state.uplinks.map((item) => item.weight)).toEqual([100, 100, 100]);
	});

	test("withholds WiFi until its permanent identity is available", async () => {
		const h = harness({ wifiIdentity: () => undefined });
		const state = await readReadySteeringState(h);

		expect(state.uplinks.map((item) => item.ifname)).toEqual(["wwan0"]);
	});

	test("refuses a client zone that is still a bond candidate", async () => {
		const h = harness({
			isBondCandidate: (ifname) => ifname === "eth9",
		});

		await expect(readDesiredSteeringState(h)).rejects.toMatchObject({
			reason: "bond_candidate_client_zone",
		});
		expect(h.planned).toEqual([]);
	});

	test("refuses overlapping client and uplink subnets before route mutation", async () => {
		const h = harness({
			interfaces: () => ({
				eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
				wwan0: netif("10.43.0.22"),
			}),
			health: () => [health("wwan0", "up", 100)],
			isClientZone: (ifname) => ifname === "eth9",
		});

		await expect(readDesiredSteeringState(h)).rejects.toMatchObject({
			reason: "overlapping_subnet",
		});
		expect(h.planned).toEqual([]);
	});

	test("refuses overlapping client zones before route mutation", async () => {
		const h = harness({
			interfaces: () => ({
				"clap-wlan0": netif("10.42.0.1", "255.255.255.0", NETIF_ERR_HOTSPOT),
				eth9: netif("10.42.0.2", "255.255.255.0", NETIF_ERR_SHAREDLAN),
				wwan0: netif("100.64.1.2"),
			}),
			health: () => [health("wwan0", "up", 100)],
			isClientZone: (ifname) => ifname === "clap-wlan0" || ifname === "eth9",
		});

		await expect(readDesiredSteeringState(h)).rejects.toMatchObject({
			reason: "overlapping_subnet",
		});
		expect(h.planned).toEqual([]);
	});

	test("propagates a typed policy-route refusal without partial output", async () => {
		const h = harness({
			planRoute: async () => {
				throw Object.assign(new Error("missing table"), {
					reason: "policy_route_missing",
				});
			},
		});

		await expect(readDesiredSteeringState(h)).rejects.toMatchObject({
			reason: "policy_route_missing",
		});
	});

	test("prepares wlan1 with no source rules through the managed route planner", async () => {
		const routeDeps = scripted({
			"ip rule show":
				"0: from all lookup local\n32766: from all lookup main\n32767: from all lookup default\n",
			"ip -4 route show default dev wlan1":
				"default via 192.168.1.1 proto dhcp src 192.168.1.50 metric 600",
		});
		const h = harness({
			interfaces: () => ({
				eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
				wlan1: netif("192.168.1.50"),
			}),
			health: () => [health("wlan1", "up", 100)],
			wifiIdentity: () => "wifi-mac:00:11:22:33:44:55",
			markForIdentity: () => 0xca000100,
			isClientZone: (ifname) => ifname === "eth9",
			planRoute: (candidate) => planUplinkRoute(candidate, routeDeps),
		});
		const state = await readReadySteeringState(h);
		expect(state.uplinks.map((uplink) => uplink.ifname)).toEqual(["wlan1"]);
		expect(state.routes).toHaveLength(1);
		expect(state.routes[0]).toMatchObject({
			ifname: "wlan1",
			managed: true,
			sourceRulePriority: 100,
			defaultRouteArgv: [
				"route",
				"replace",
				"table",
				"30001",
				"default",
				"via",
				"192.168.1.1",
				"proto",
				"dhcp",
				"src",
				"192.168.1.50",
				"metric",
				"600",
				"dev",
				"wlan1",
			],
		});
	});

	test("withholds module-owned source rules for duplicate uplink addresses", async () => {
		const h = harness({
			interfaces: () => ({
				eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
				wwan0: netif("100.64.1.2", "255.255.255.0", NETIF_ERR_DUPIPV4),
				wwan1: netif("100.64.1.2", "255.255.255.0", NETIF_ERR_DUPIPV4),
			}),
			health: () => [health("wwan0", "up", 100), health("wwan1", "up", 100)],
			isClientZone: (ifname) => ifname === "eth9",
		});
		await readDesiredSteeringState(h);

		expect(h.planned).toHaveLength(2);
		expect(h.planned.every((candidate) => !candidate.sourceAddressUnique)).toBe(
			true,
		);
	});

	test("refuses a non-contiguous subnet mask instead of guessing overlap", async () => {
		const h = harness({
			interfaces: () => ({
				eth9: netif("10.43.0.1", "255.0.255.0", NETIF_ERR_SHAREDLAN),
				wwan0: netif("100.64.1.2"),
			}),
			isClientZone: (ifname) => ifname === "eth9",
		});

		await expect(readDesiredSteeringState(h)).rejects.toMatchObject({
			reason: "overlapping_subnet",
		});
	});

	test("resolves two active identities that collide in the mark namespace", async () => {
		const h = harness({ markForIdentity: () => 0xca001100 });

		const outcome = await readDesiredSteeringState(h).then(
			(state) => state,
			(error: unknown) => error,
		);
		expect(outcome).toMatchObject({
			uplinks: [
				{ ifname: "wlan0", mark: 0xca001200 },
				{ ifname: "wwan0", mark: 0xca001100 },
			],
		});
		expect(h.planned.map(({ mark }) => mark)).toEqual([0xca001200, 0xca001100]);
	});

	test("keeps non-colliding marks and route plans byte-identical", async () => {
		const state = await readReadySteeringState(harness());

		expect(JSON.stringify(state)).toMatchSnapshot("non-colliding steering");
	});

	test("steers constructed twin modems whose physical identities hash to the same slot", async () => {
		const identities = ["constructed-twin-322", "constructed-twin-386"];
		expect(identities.map(stableUplinkMark)).toEqual([0xca671800, 0xca671800]);
		const h = harness({
			interfaces: () => ({
				eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
				wwan0: netif("100.64.1.2"),
				wwan1: netif("100.64.2.2"),
			}),
			health: () => [],
			physicalIdentity: (ifname) =>
				ifname === "wwan0" ? "constructed-twin-386" : "constructed-twin-322",
		});

		await expect(readDesiredSteeringState(h)).resolves.toMatchObject({
			uplinks: [
				{ ifname: "wwan0", mark: 0xca671900 },
				{ ifname: "wwan1", mark: 0xca671800 },
			],
			routes: [
				{ ifname: "wwan0", mark: 0xca671900 },
				{ ifname: "wwan1", mark: 0xca671800 },
			],
		});
	});

	test.each([
		{
			name: "two claimants",
			slots: [17, 17],
			expected: [17, 18],
		},
		{
			name: "later natural owner reserves the next slot",
			slots: [17, 17, 18],
			expected: [17, 19, 18],
		},
		{
			name: "multiple probers skip every natural owner",
			slots: [17, 17, 17, 18],
			expected: [17, 19, 20, 18],
		},
		{
			name: "wrap skips zero",
			slots: [0xffff, 0xffff],
			expected: [0xffff, 1],
		},
		{
			name: "wrap skips reserved slot one",
			slots: [0xffff, 0xffff, 1],
			expected: [0xffff, 2, 1],
		},
	])(
		"assigns $name deterministically across input orders and fresh builders",
		async ({ slots, expected }) => {
			const devices = slots.map((slot, index) => ({
				identity: `constructed-${index}`,
				ifname: `wwan${slots.length - index}`,
				mark: (0xca000000 | (slot << 8)) >>> 0,
			}));
			for (const order of [
				devices,
				[...devices].reverse(),
				[...devices.slice(1), ...devices.slice(0, 1)],
			]) {
				const h = harness({
					interfaces: () => ({
						eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
						...Object.fromEntries(
							order.map(({ ifname }) => [ifname, netif("100.64.1.2")]),
						),
					}),
					health: () => [],
					physicalIdentity: (ifname) =>
						devices.find((device) => device.ifname === ifname)?.identity ?? "",
					markForIdentity: (identity) =>
						devices.find((device) => device.identity === identity)?.mark ?? 0,
				});

				await expect(readDesiredSteeringState(h)).resolves.toMatchObject({
					uplinks: devices
						.map(({ identity, ifname }, index) => ({
							identity,
							ifname,
							mark: (0xca000000 | ((expected[index] ?? 0) << 8)) >>> 0,
						}))
						.reverse(),
				});
			}
		},
	);

	test("only probers move when a new natural owner needs their assigned slot", async () => {
		const h = harness({
			interfaces: () => ({
				eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
				wwan0: netif("100.64.1.2"),
				wwan1: netif("100.64.2.2"),
			}),
			health: () => [],
			physicalIdentity: (ifname) => `constructed-${ifname}`,
			markForIdentity: (identity) =>
				identity === "constructed-wwan2" ? 0xca001200 : 0xca001100,
		});
		await expect(readDesiredSteeringState(h)).resolves.toMatchObject({
			uplinks: [
				{ ifname: "wwan0", mark: 0xca001100 },
				{ ifname: "wwan1", mark: 0xca001200 },
			],
		});
		const expanded = {
			...h,
			interfaces: () => ({
				...h.interfaces(),
				wwan2: netif("100.64.3.2"),
			}),
		};

		await expect(readDesiredSteeringState(expanded)).resolves.toMatchObject({
			uplinks: [
				{ ifname: "wwan0", mark: 0xca001100 },
				{ ifname: "wwan1", mark: 0xca001300 },
				{ ifname: "wwan2", mark: 0xca001200 },
			],
		});
		await expect(readDesiredSteeringState(h)).resolves.toMatchObject({
			uplinks: [
				{ ifname: "wwan0", mark: 0xca001100 },
				{ ifname: "wwan1", mark: 0xca001200 },
			],
		});
	});
});

describe("known-down uplink rejoin", () => {
	const lostAt = 1_000;
	const dwellAt = lostAt + UPLINK_HEALTH_CONFIG.holdDownMs;

	function fixture() {
		const engine = new UplinkHealthEngine();
		const interfaces = harness().interfaces();
		delete interfaces.wwan1;
		const h = harness({
			interfaces: () => interfaces,
			health: () => engine.list(),
		});
		const observe = (outcome: UplinkHealthOutcome, now: number) =>
			engine.observe({ iface: "wlan0", kind: "wifi", outcome, now });
		observe("success", 0);
		engine.observe({
			iface: "wwan0",
			kind: "cellular",
			outcome: "success",
			now: 0,
		});
		return { engine, h, interfaces, observe };
	}

	test("keeps a returned-address uplink out on passive evidence before and after dwell", async () => {
		const { engine, h, interfaces, observe } = fixture();
		interfaces.wlan0 = { ...netif("192.168.2.8"), ip: undefined };
		observe("definitive_loss", lostAt);
		interfaces.wlan0 = netif("192.168.2.8");

		for (const now of [lostAt + 1_000, dwellAt]) {
			observe("passive_degraded", now);
			h.planned.length = 0;
			const state = await readReadySteeringState(h);
			expect(
				state.uplinks.map(({ ifname, weight }) => ({ ifname, weight })),
			).toEqual([{ ifname: "wwan0", weight: 100 }]);
			expect(h.planned.map(({ ifname }) => ifname)).toEqual(["wwan0"]);
			expect(engine.get("wlan0")).toMatchObject({
				state: "down",
				weight: 0,
				lastTransition: lostAt,
				probes: { successes: 0, failures: 0 },
			});
			expect(engine.isClientSteeringEligible("wlan0")).toBe(false);
			expect(state.clientZones).toEqual([
				{ ifname: "clap-wlan0", ipv4Cidr: "10.42.0.0/24" },
				{ ifname: "eth9", ipv4Cidr: "10.43.0.0/24" },
			]);
		}
	});

	test("resets partial recovery on passive evidence and requires five new successes after dwell", async () => {
		const { engine, h, observe } = fixture();
		observe("definitive_loss", lostAt);
		observe("success", dwellAt);
		observe("success", dwellAt + 1);
		expect(engine.get("wlan0")?.probes.successes).toBe(2);
		observe("passive_degraded", dwellAt + 2);
		expect(engine.get("wlan0")).toMatchObject({
			state: "down",
			weight: 0,
			lastTransition: lostAt,
			probes: { successes: 0, failures: 0 },
		});

		for (
			let round = 1;
			round < UPLINK_HEALTH_CONFIG.successfulRoundsUp;
			round++
		) {
			observe("success", dwellAt + 2 + round);
		}
		expect(engine.get("wlan0")?.probes.successes).toBe(4);
		expect(
			(await readReadySteeringState(h)).uplinks.map(({ ifname }) => ifname),
		).toEqual(["wwan0"]);
		expect(h.planned.map(({ ifname }) => ifname)).toEqual(["wwan0"]);

		observe("success", dwellAt + 2 + UPLINK_HEALTH_CONFIG.successfulRoundsUp);
		expect(engine.get("wlan0")).toMatchObject({ state: "up", weight: 100 });
		h.planned.length = 0;
		expect(
			(await readReadySteeringState(h)).uplinks.map(({ ifname }) => ifname),
		).toEqual(["wlan0", "wwan0"]);
		expect(h.planned.map(({ ifname }) => ifname)).toEqual(["wlan0", "wwan0"]);
	});

	test("withholds five early successes until a success at the original hold-down boundary", async () => {
		const { engine, h, observe } = fixture();
		observe("definitive_loss", lostAt);
		observe("passive_degraded", lostAt + 1);
		for (
			let round = 1;
			round <= UPLINK_HEALTH_CONFIG.successfulRoundsUp;
			round++
		) {
			observe("success", lostAt + 1 + round);
		}
		expect(engine.get("wlan0")?.probes.successes).toBe(5);
		observe("success", dwellAt - 1);
		expect(engine.get("wlan0")).toMatchObject({
			state: "down",
			lastTransition: lostAt,
		});
		expect(
			(await readReadySteeringState(h)).uplinks.map(({ ifname }) => ifname),
		).toEqual(["wwan0"]);

		observe("success", dwellAt);
		expect(engine.get("wlan0")).toMatchObject({
			state: "up",
			weight: 100,
			lastTransition: dwellAt,
		});
		h.planned.length = 0;
		expect(
			(await readReadySteeringState(h)).uplinks.map(({ ifname }) => ifname),
		).toEqual(["wlan0", "wwan0"]);
		expect(h.planned.map(({ ifname }) => ifname)).toEqual(["wlan0", "wwan0"]);
	});

	test("preserves ordinary passive degradation and the existing captive-portal policy", async () => {
		const { engine, h, observe } = fixture();
		observe("passive_degraded", lostAt);
		expect(engine.get("wlan0")).toMatchObject({
			state: "degraded",
			weight: 25,
		});
		observe("definitive_loss", lostAt + 1);
		observe("captive_portal", lostAt + 2);
		expect(engine.get("wlan0")).toMatchObject({
			state: "down",
			reason: "captive_portal",
			weight: 0,
			probes: { successes: 0, failures: 0 },
		});
		expect(engine.isClientSteeringEligible("wlan0")).toBe(false);
		expect(
			(await readReadySteeringState(h)).uplinks.map(({ ifname, weight }) => ({
				ifname,
				weight,
			})),
		).toEqual([{ ifname: "wwan0", weight: 100 }]);
	});
});
