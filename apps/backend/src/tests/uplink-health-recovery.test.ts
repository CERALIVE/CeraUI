import { afterEach, describe, expect, test } from "bun:test";

import {
	NETIF_ERR_SHAREDLAN,
	type NetworkInterface,
} from "../modules/network/network-interfaces.ts";
import {
	UPLINK_HEALTH_CONFIG,
	UplinkHealthEngine,
	type UplinkHealthOutcome,
} from "../modules/network/uplink-health/model.ts";
import { UplinkHealthRuntime } from "../modules/network/uplink-health/runtime.ts";
import { setUplinkHealthEngineForTest } from "../modules/network/uplink-health/state.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import { readDesiredSteeringState } from "../modules/network/uplink-steering/state-builder.ts";

afterEach(() => setUplinkHealthEngineForTest(null));

function fixture() {
	const uplink: NetworkInterface = {
		ip: "192.0.2.2",
		netmask: "255.255.255.0",
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
	};
	const interfaces: Record<string, NetworkInterface> = {
		wwan0: uplink,
		eth9: { ...uplink, ip: "10.42.0.1", error: NETIF_ERR_SHAREDLAN },
	};
	const clock = { now: 1_000 };
	const evidence: { streaming: boolean; outcome: UplinkHealthOutcome } = {
		streaming: false,
		outcome: "success",
	};
	const engine = new UplinkHealthEngine();
	engine.observe({
		iface: "wwan0",
		kind: "cellular",
		outcome: "definitive_loss",
		now: clock.now,
	});
	setUplinkHealthEngineForTest(engine);
	const runtime = new UplinkHealthRuntime({
		now: () => clock.now,
		interfaces: () => interfaces,
		streaming: () => evidence.streaming,
		telemetry: () => ({
			links: [
				{
					conn_id: "1",
					iface: "wwan0",
					rtt_ms: 1_200,
					nak_count: 0,
					weight_percent: 100,
					bitrate_bps: 2_000_000,
					stale: false,
				},
			],
			measured_bps: 2_000_000,
			lastReadMs: clock.now - 1,
		}),
		resolveTarget: async () => "198.51.100.1",
		probe: async () => evidence.outcome,
		publish: () => undefined,
	});
	const steering = async () =>
		(
			await readDesiredSteeringState({
				interfaces: () => interfaces,
				health: () => runtime.records(),
				wifiIdentity: () => undefined,
				physicalIdentity: (ifname) => `id-path:${ifname}`,
				markForIdentity: stableUplinkMark,
				isBondCandidate: () => false,
				isClientZone: (ifname) => ifname === "eth9",
				planRoute: async (candidate) => ({
					...candidate,
					table: candidate.ifname,
					managed: false,
				}),
			})
		).uplinks.map(({ ifname, weight }) => ({ ifname, weight }));
	const tick = async () => {
		clock.now += UPLINK_HEALTH_CONFIG.probeRoundCadenceMs;
		await runtime.tick();
	};
	return { evidence, engine, interfaces, uplink, steering, tick };
}

async function expectRecovery(h: ReturnType<typeof fixture>) {
	for (
		let round = 1;
		round < UPLINK_HEALTH_CONFIG.successfulRoundsUp;
		round++
	) {
		await h.tick();
		expect(await h.steering()).toEqual([]);
		expect(h.engine.get("wwan0")).toMatchObject({
			state: "down",
			weight: 0,
			probes: { successes: round, failures: 0 },
		});
	}
	await h.tick();
	expect(await h.steering()).toEqual([{ ifname: "wwan0", weight: 100 }]);
	expect(h.engine.get("wwan0")?.state).toBe("up");
}

describe("known-down recovery across observation paths (#476)", () => {
	test("keeps a captive portal out of steering until five new successful probes", async () => {
		const h = fixture();
		await h.tick();
		await h.tick();
		h.evidence.outcome = "captive_portal";

		await h.tick();

		expect(await h.steering()).toEqual([]);
		expect(h.engine.get("wwan0")).toMatchObject({
			state: "down",
			reason: "captive_portal",
			weight: 0,
			lastTransition: 1_000,
			probes: { successes: 0, failures: 0 },
		});
		h.evidence.outcome = "success";
		await expectRecovery(h);
	});

	test("keeps a briefly missing uplink out before and during a fresh recovery streak", async () => {
		const h = fixture();
		await h.tick();
		await h.tick();
		delete h.interfaces.wwan0;

		await h.tick();
		h.interfaces.wwan0 = h.uplink;

		expect(await h.steering()).toEqual([]);
		await expectRecovery(h);
	});

	test("recovers a streaming uplink by active probes despite degraded passive metrics", async () => {
		const h = fixture();
		h.evidence.streaming = true;

		await expectRecovery(h);

		await h.tick();
		expect(h.engine.get("wwan0")).toMatchObject({
			state: "degraded",
			reason: "passive_congestion",
			weight: 25,
		});
		expect(await h.steering()).toEqual([{ ifname: "wwan0", weight: 25 }]);
	});
});
