import { afterEach, describe, expect, it } from "bun:test";

import { UplinkHealthEngine } from "../modules/network/uplink-health/model.ts";
import { setUplinkHealthEngineForTest } from "../modules/network/uplink-health/state.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";

describe("uplinks post-login hydration", () => {
	afterEach(() => setUplinkHealthEngineForTest(null));

	it("includes the current snapshot without waiting for another health tick", () => {
		// Given
		const engine = new UplinkHealthEngine();
		engine.observe({
			iface: "eth0",
			kind: "ethernet",
			outcome: "captive_portal",
			now: 100,
		});
		setUplinkHealthEngineForTest(engine);

		// When
		const snapshot = buildInitialStatus();

		// Then
		expect(snapshot.uplinks).toEqual([
			expect.objectContaining({
				iface: "eth0",
				state: "degraded",
				reason: "captive_portal",
			}),
		]);
	});
});
