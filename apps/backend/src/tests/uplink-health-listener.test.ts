import { afterEach, expect, test } from "bun:test";

import {
	onUplinkHealthChange,
	setUplinkHealthEngineForTest,
	UplinkHealthEngine,
	UplinkHealthRuntime,
} from "../modules/network/uplink-health/index.ts";

afterEach(() => setUplinkHealthEngineForTest(null));

test("uplink health publishes a removable in-process change signal", async () => {
	setUplinkHealthEngineForTest(new UplinkHealthEngine());
	let now = 1;
	const events: string[][] = [];
	const unsubscribe = onUplinkHealthChange((records) => {
		events.push(records.map((record) => record.iface));
	});
	const runtime = new UplinkHealthRuntime({
		now: () => now,
		interfaces: () => ({
			wwan0: {
				ip: "100.64.1.2",
				netmask: "255.255.255.0",
				tp: 0,
				txb: 0,
				rxb: 0,
				enabled: true,
				error: 0,
			},
		}),
		streaming: () => false,
		telemetry: () => null,
		resolveTarget: () => Promise.resolve("142.251.133.99"),
		probe: async () => "success",
		publish: () => {},
	});

	await runtime.tick();
	unsubscribe();
	now++;
	await runtime.tick();

	expect(events).toEqual([["wwan0"]]);
});
