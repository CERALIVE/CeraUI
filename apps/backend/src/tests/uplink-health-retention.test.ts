import { afterEach, describe, expect, test } from "bun:test";

import type { NetworkInterface } from "../modules/network/network-interfaces.ts";
import { UplinkHealthEngine } from "../modules/network/uplink-health/model.ts";
import {
	UplinkHealthRuntime,
	type UplinkHealthRuntimeDeps,
} from "../modules/network/uplink-health/runtime.ts";
import { setUplinkHealthEngineForTest } from "../modules/network/uplink-health/state.ts";

const day = 24 * 60 * 60 * 1_000;
const uplink: NetworkInterface = {
	ip: "192.0.2.2",
	netmask: "255.255.255.0",
	tp: 0,
	txb: 0,
	rxb: 0,
	enabled: true,
	error: 0,
};

afterEach(() => setUplinkHealthEngineForTest(null));

function fixture(overrides: Partial<UplinkHealthRuntimeDeps> = {}) {
	const clock = { now: 1_000 };
	const interfaces: Record<string, NetworkInterface> = {};
	const engine = new UplinkHealthEngine();
	setUplinkHealthEngineForTest(engine);
	const runtime = new UplinkHealthRuntime({
		now: () => clock.now,
		interfaces: () => interfaces,
		streaming: () => false,
		telemetry: () => null,
		resolveTarget: async () => "198.51.100.1",
		probe: async () => "success",
		publish: () => undefined,
		...overrides,
	});
	return { clock, interfaces, engine, runtime };
}

describe("bounded missing down history (#476 R2)", () => {
	test("caps 1000 disappearing names at 32 missing records and expires them after 30 days", async () => {
		const h = fixture();
		let previous: string | undefined;
		for (let index = 0; index < 1_000; index++) {
			if (previous !== undefined) delete h.interfaces[previous];
			const iface = `wwan${index}`;
			h.interfaces[iface] = { ...uplink, ip: undefined };
			previous = iface;
			h.clock.now += 5_000;
			await h.runtime.tick();
			const missing = h.runtime
				.records()
				.filter(({ iface }) => !h.interfaces[iface]);
			expect(missing.length).toBe(Math.min(index, 32));
		}
		if (previous !== undefined) delete h.interfaces[previous];
		h.clock.now += 5_000;
		await h.runtime.tick();
		expect(h.runtime.records().length).toBe(32);

		h.clock.now += 30 * day;
		await h.runtime.tick();

		expect(h.runtime.records()).toEqual([]);
	});

	test("expires at 24 hours since last seen rather than first missing", async () => {
		const h = fixture();
		h.interfaces.wwan0 = { ...uplink, ip: undefined };
		await h.runtime.tick();
		h.clock.now = 6_000;
		await h.runtime.tick();
		delete h.interfaces.wwan0;
		h.clock.now = 11_000;
		await h.runtime.tick();
		h.clock.now = 6_000 + day - 1;
		await h.runtime.tick();
		expect(h.engine.get("wwan0")?.state).toBe("down");

		h.clock.now++;
		await h.runtime.tick();

		expect(h.engine.get("wwan0")).toBeUndefined();
		h.interfaces.wwan0 = uplink;
		h.clock.now++;
		await h.runtime.tick();
		expect(h.engine.get("wwan0")).toMatchObject({
			state: "up",
			probes: { successes: 1, failures: 0 },
		});
	});

	test("retains the down verdict inside the TTL and requires a fresh recovery streak", async () => {
		const h = fixture();
		h.interfaces.wwan0 = { ...uplink, ip: undefined };
		await h.runtime.tick();
		h.interfaces.wwan0 = uplink;
		for (let round = 1; round <= 2; round++) {
			h.clock.now += 5_000;
			await h.runtime.tick();
		}
		delete h.interfaces.wwan0;
		h.clock.now += 5_000;
		await h.runtime.tick();
		h.clock.now = 11_000 + day - 1;
		h.interfaces.wwan0 = uplink;

		await h.runtime.tick();

		expect(h.engine.get("wwan0")).toMatchObject({
			state: "down",
			weight: 0,
			lastTransition: 1_000,
			probes: { successes: 1, failures: 0 },
		});
		for (let round = 2; round <= 4; round++) {
			h.clock.now += 5_000;
			await h.runtime.tick();
			expect(h.runtime.isClientSteeringEligible("wwan0")).toBe(false);
		}
		h.clock.now += 5_000;
		await h.runtime.tick();
		expect(h.engine.get("wwan0")?.state).toBe("up");
	});

	test("evicts the one missing longest rather than the oldest inserted record", async () => {
		const h = fixture();
		for (let index = 0; index < 33; index++) {
			h.interfaces[`wwan${index}`] = { ...uplink, ip: undefined };
		}
		await h.runtime.tick();
		delete h.interfaces.wwan32;
		h.clock.now += 5_000;
		await h.runtime.tick();
		for (let index = 0; index < 32; index++)
			delete h.interfaces[`wwan${index}`];
		h.clock.now += 5_000;

		await h.runtime.tick();

		expect(new Set(h.runtime.records().map(({ iface }) => iface))).toEqual(
			new Set(Array.from({ length: 32 }, (_, index) => `wwan${index}`)),
		);
		h.interfaces.wwan32 = uplink;
		h.clock.now += 5_000;
		await h.runtime.tick();
		expect(h.engine.get("wwan32")?.state).toBe("up");
	});

	test("keeps never-down behavior unchanged across presence and disappearance", async () => {
		const h = fixture();
		h.interfaces.wwan0 = uplink;
		await h.runtime.tick();
		h.clock.now += 30 * day;
		await h.runtime.tick();
		expect(h.engine.get("wwan0")?.state).toBe("up");
		delete h.interfaces.wwan0;

		await h.runtime.tick();

		expect(h.runtime.records()).toEqual([]);
		h.interfaces.wwan0 = uplink;
		await h.runtime.tick();
		expect(h.engine.get("wwan0")).toMatchObject({
			state: "up",
			probes: { successes: 1, failures: 0 },
		});
	});

	test("does not recreate expired missing history from stale sender telemetry", async () => {
		const h = fixture({
			streaming: () => true,
			telemetry: () => ({
				links: [
					{
						conn_id: "1",
						iface: "wwan0",
						rtt_ms: 1_200,
						nak_count: 0,
						weight_percent: 100,
						bitrate_bps: 0,
						stale: true,
					},
				],
				measured_bps: 0,
				lastReadMs: 1_000,
			}),
		});
		h.interfaces.wwan0 = { ...uplink, ip: undefined };
		await h.runtime.tick();
		delete h.interfaces.wwan0;
		h.clock.now += 5_000;
		await h.runtime.tick();

		h.clock.now = 1_000 + day;
		await h.runtime.tick();

		expect(h.runtime.records()).toEqual([]);
	});
});
