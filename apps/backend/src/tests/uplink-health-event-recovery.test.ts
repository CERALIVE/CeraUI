import { expect, test } from "bun:test";

import { eventRecoveryFixture } from "./uplink-health-event-recovery-fixture.ts";

test("E4/R3 keeps steering excluded after between-tick removal and one fresh probe", async () => {
	const h = await eventRecoveryFixture();
	h.gate.iface = "wwan0";
	h.clock.now += 5_000;
	const older = h.tick();
	await h.entered.promise;
	h.removeReturn();
	h.gate.iface = undefined;
	h.release.resolve();
	await older;
	h.clock.now += 5_000;
	await h.tick();

	expect(await h.selected()).toBe(false);
	expect(h.engine.get("wwan0")?.probes.successes).toBe(1);
});

test("rejoins only on the fifth fresh success at the restarted hold-down boundary", async () => {
	const h = await eventRecoveryFixture();
	h.gate.iface = "wwan0";
	h.clock.now += 5_000;
	const older = h.tick();
	await h.entered.promise;
	const returnedAt = h.removeReturn();
	h.gate.iface = undefined;
	h.release.resolve();
	await older;

	for (let round = 1; round <= 5; round++) {
		h.clock.now = returnedAt + round * 3_000;
		await h.tick();
		expect(await h.selected()).toBe(round === 5);
		expect(h.engine.get("wwan0")?.probes.successes).toBe(round);
	}
});

test("withholds five early fresh successes until the new 15-second hold-down is met", async () => {
	const h = await eventRecoveryFixture();
	h.gate.iface = "wwan0";
	h.clock.now += 5_000;
	const older = h.tick();
	await h.entered.promise;
	const returnedAt = h.removeReturn();
	h.gate.iface = undefined;
	h.release.resolve();
	await older;

	for (let round = 1; round <= 5; round++) {
		h.clock.now = returnedAt + round;
		await h.tick();
		expect(await h.selected()).toBe(false);
	}
	h.clock.now = returnedAt + 14_999;
	await h.tick();
	expect(await h.selected()).toBe(false);
	h.clock.now = returnedAt + 15_000;
	await h.tick();
	expect(await h.selected()).toBe(true);
});

test("an older in-flight result cannot count after the event and a newer fresh probe", async () => {
	const h = await eventRecoveryFixture();
	h.gate.iface = "wwan0";
	h.clock.now += 5_000;
	const older = h.tick();
	await h.entered.promise;
	h.removeReturn();
	h.gate.iface = undefined;
	h.clock.now += 5_000;
	await h.tick();
	h.release.resolve();
	await older;

	expect(h.engine.get("wwan0")).toMatchObject({
		state: "down",
		probes: { successes: 1, failures: 0 },
	});
	expect(await h.selected()).toBe(false);
});
