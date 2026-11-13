import { expect, test } from "bun:test";

import { NETIF_ERR_SHAREDLAN } from "../modules/network/network-interfaces.ts";
import { eventRecoveryFixture } from "./uplink-health-event-recovery-fixture.ts";

for (const change of [
	{
		name: "address",
		update: { ip: "192.0.2.3" },
	},
	{
		name: "eligibility",
		update: { error: NETIF_ERR_SHAREDLAN },
	},
]) {
	test(`${change.name} events restart down recovery immediately and leave up state untouched`, async () => {
		for (const state of ["down", "up"] as const) {
			const h = await eventRecoveryFixture(state);
			const before = h.engine.get("wwan0");
			h.gate.iface = "wwan0";
			h.clock.now += 5_000;
			const older = h.tick();
			await h.entered.promise;
			h.change(() => {
				const current = h.interfaces.wwan0;
				if (!current) throw new Error("missing fixture uplink");
				h.interfaces.wwan0 = { ...current, ...change.update };
			});

			if (state === "down") {
				expect(h.engine.get("wwan0")).toMatchObject({
					state: "down",
					lastTransition: h.clock.now,
					probes: { successes: 0, failures: 0 },
				});
			} else {
				expect(h.engine.get("wwan0")).toEqual(before);
			}
			h.release.resolve();
			await older;
			if (state === "up") expect(h.engine.get("wwan0")).toEqual(before);
		}
	});
}

test("removal and return inside an earlier batch restart the target recovery streak", async () => {
	const h = await eventRecoveryFixture("down", ["eth0", "eth1", "eth2"]);
	h.gate.iface = "eth0";
	h.clock.now += 5_000;
	const older = h.tick();
	await h.entered.promise;
	h.removeReturn();
	h.gate.iface = undefined;
	h.release.resolve();
	await older;
	expect(h.calls.get("wwan0")).toBe(4);
	h.clock.now += 5_000;
	await h.tick();

	expect(await h.selected()).toBe(false);
	expect(h.engine.get("wwan0")?.probes.successes).toBe(1);
});
