import { afterEach, expect, test } from "bun:test";

import {
	NETIF_ERR_SHAREDLAN,
	type NetworkInterface,
} from "../modules/network/network-interfaces.ts";
import {
	UPLINK_HEALTH_CONFIG,
	UplinkHealthEngine,
} from "../modules/network/uplink-health/model.ts";
import { UplinkHealthRuntime } from "../modules/network/uplink-health/runtime.ts";
import { setUplinkHealthEngineForTest } from "../modules/network/uplink-health/state.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import { readDesiredSteeringState } from "../modules/network/uplink-steering/state-builder.ts";

afterEach(() => setUplinkHealthEngineForTest(null));

test("requires five fresh probes after a missing tick discards an in-flight recovery success (#476 R1)", async () => {
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
		eth0: uplink,
		eth1: uplink,
		eth2: uplink,
		wwan0: uplink,
		eth9: { ...uplink, ip: "10.42.0.1", error: NETIF_ERR_SHAREDLAN },
	};
	let now = 1_000;
	let gateProbe = false;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const engine = new UplinkHealthEngine();
	engine.observe({
		iface: "wwan0",
		kind: "cellular",
		outcome: "definitive_loss",
		now,
	});
	setUplinkHealthEngineForTest(engine);
	const runtime = new UplinkHealthRuntime({
		now: () => now,
		interfaces: () => interfaces,
		streaming: () => false,
		telemetry: () => null,
		resolveTarget: async () => "198.51.100.1",
		probe: async (iface) => {
			if (gateProbe && iface === "wwan0") {
				entered.resolve();
				await release.promise;
			}
			return "success";
		},
		publish: () => undefined,
	});
	const selected = async () =>
		(
			await readDesiredSteeringState({
				interfaces: () => interfaces,
				health: () => runtime.records(),
				wifiIdentity: () => undefined,
				physicalIdentity: (iface) => `id-path:${iface}`,
				markForIdentity: stableUplinkMark,
				isBondCandidate: () => false,
				isClientZone: (iface) => iface === "eth9",
				planRoute: async (candidate) => ({
					...candidate,
					table: candidate.ifname,
					managed: false,
				}),
			})
		).uplinks.some(({ ifname }) => ifname === "wwan0");
	for (let round = 1; round <= 4; round++) {
		now += UPLINK_HEALTH_CONFIG.probeRoundCadenceMs;
		await runtime.tick();
	}
	expect(engine.get("wwan0")?.probes.successes).toBe(4);
	now += UPLINK_HEALTH_CONFIG.probeRoundCadenceMs;
	gateProbe = true;
	const older = runtime.tick();

	try {
		await entered.promise;
		delete interfaces.wwan0;
		now += UPLINK_HEALTH_CONFIG.probeRoundCadenceMs;
		await runtime.tick();
		expect(engine.get("wwan0")?.probes.successes).toBe(0);
		release.resolve();
		await older;
		expect(engine.get("wwan0")?.probes.successes).toBe(0);

		interfaces.wwan0 = uplink;
		gateProbe = false;
		for (let round = 1; round <= 4; round++) {
			now += UPLINK_HEALTH_CONFIG.probeRoundCadenceMs;
			await runtime.tick();
			expect(engine.get("wwan0")?.probes.successes).toBe(round);
			expect(await selected()).toBe(false);
		}
		now += UPLINK_HEALTH_CONFIG.probeRoundCadenceMs;
		await runtime.tick();
		expect(engine.get("wwan0")?.probes.successes).toBe(5);
		expect(await selected()).toBe(true);
	} finally {
		release.resolve();
		await older;
		runtime.dispose();
	}
});
