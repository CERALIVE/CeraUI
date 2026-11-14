import { expect, test } from "bun:test";
import { setEventSink } from "../modules/events/emit.ts";
import {
	type GatewayElectionDeps,
	updateGw,
} from "../modules/network/gateways.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";
import { recordNetworkEvents } from "./events-network-recording-fixture.ts";

test("a sink-triggered gateway recovery observes the completed outer connectivity transition", async () => {
	const h = recordNetworkEvents();
	const deps: GatewayElectionDeps = {
		isRealDevice: async () => true,
		resolve: async () => ({ addrs: ["203.0.113.10"], fromCache: true }),
		validateDns: () => undefined,
		checkConnectivity: async () => false,
		interfaces: () => ({}),
		eligible: () => true,
		defaultInterface: async () => undefined,
		installRoute: async () => undefined,
		probes: {
			probeRepository: async () => deriveVerdict([]),
			probeViaDevice: async () => false,
			probeViaSourceIp: async () => false,
		},
	};
	let nested: Promise<boolean> | undefined;
	setEventSink((event) => {
		if (event.code === "internet_lost") {
			nested = updateGw({ ...deps, checkConnectivity: async () => true });
		}
	});
	expect(await updateGw(deps)).toBe(false);
	expect(await nested).toBe(true);
	h.advance();
	expect(h.calls).toEqual([
		{ code: "internet_lost", params: {} },
		{ code: "internet_restored", params: {} },
	]);
});
