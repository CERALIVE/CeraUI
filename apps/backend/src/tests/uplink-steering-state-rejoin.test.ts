import { describe, expect, test } from "bun:test";
import {
	UPLINK_HEALTH_CONFIG,
	UplinkHealthEngine,
	type UplinkHealthOutcome,
} from "../modules/network/uplink-health/model.ts";
import { harness, netif } from "./uplink-steering-state-test-fixtures.ts";
import { readReadySteeringState } from "./uplink-steering-test-fixtures.ts";

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
		interfaces.wlan0 = netif("192.168.2.8");
		delete interfaces.wlan0.ip;
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
