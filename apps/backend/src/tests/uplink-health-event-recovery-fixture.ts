import { onTestFinished } from "bun:test";

import {
	NETIF_ERR_SHAREDLAN,
	type NetworkInterface,
	onNetworkInterfacesChange,
	triggerNetworkInterfacesChange,
} from "../modules/network/network-interfaces.ts";
import { UplinkHealthEngine } from "../modules/network/uplink-health/model.ts";
import { UplinkHealthRuntime } from "../modules/network/uplink-health/runtime.ts";
import { setUplinkHealthEngineForTest } from "../modules/network/uplink-health/state.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import { readDesiredSteeringState } from "../modules/network/uplink-steering/state-builder.ts";

export async function eventRecoveryFixture(
	state: "down" | "up" = "down",
	peers: readonly string[] = [],
) {
	const uplink: NetworkInterface = {
		ip: "192.0.2.2",
		netmask: "255.255.255.0",
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
	};
	const interfaces: Record<string, NetworkInterface> = {};
	for (const iface of peers) interfaces[iface] = { ...uplink };
	interfaces.wwan0 = { ...uplink };
	interfaces.eth9 = {
		...uplink,
		ip: "10.42.0.1",
		error: NETIF_ERR_SHAREDLAN,
	};
	const clock = { now: 1_000 };
	const gate: { iface: string | undefined } = { iface: undefined };
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const calls = new Map<string, number>();
	const pending: Promise<void>[] = [];
	const engine = new UplinkHealthEngine();
	engine.observe({
		iface: "wwan0",
		kind: "cellular",
		outcome: state === "down" ? "definitive_loss" : "success",
		now: clock.now,
	});
	setUplinkHealthEngineForTest(engine);
	const runtime = new UplinkHealthRuntime({
		now: () => clock.now,
		interfaces: () => interfaces,
		onInterfacesChange: onNetworkInterfacesChange,
		streaming: () => false,
		telemetry: () => null,
		resolveTarget: async () => "198.51.100.1",
		probe: async (iface) => {
			calls.set(iface, (calls.get(iface) ?? 0) + 1);
			if (iface === gate.iface) {
				entered.resolve();
				await release.promise;
			}
			return "success";
		},
		publish: () => undefined,
	});
	onTestFinished(async () => {
		release.resolve();
		await Promise.all(pending);
		runtime.dispose();
		setUplinkHealthEngineForTest(null);
	});
	const tick = () => {
		const round = runtime.tick();
		pending.push(round);
		return round;
	};
	const selected = async () =>
		(
			await readDesiredSteeringState({
				interfaces: () => interfaces,
				health: () => engine.list(),
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
	const change = (update: () => void) => {
		clock.now++;
		update();
		triggerNetworkInterfacesChange();
	};
	const removeReturn = () => {
		change(() => {
			delete interfaces.wwan0;
		});
		change(() => {
			interfaces.wwan0 = { ...uplink };
		});
		return clock.now;
	};
	for (let round = 1; round <= 4; round++) {
		clock.now += 5_000;
		await tick();
	}
	return {
		clock,
		gate,
		entered,
		release,
		calls,
		engine,
		interfaces,
		tick,
		selected,
		change,
		removeReturn,
	};
}
