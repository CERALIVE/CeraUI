import { describe, expect, it, mock } from "bun:test";

import {
	NETIF_ERR_SHAREDLAN,
	type NetworkInterface,
} from "../modules/network/network-interfaces.ts";

import {
	setUplinkHealthEngineForTest,
	UPLINK_HEALTH_CONFIG,
	UplinkHealthEngine,
	type UplinkHealthOutcome,
	UplinkHealthRuntime,
} from "../modules/network/uplink-health/index.ts";
import type { UplinkHealthRuntimeDeps } from "../modules/network/uplink-health/runtime.ts";

const IFACE = "wwan0";

describe("uplink health hysteresis", () => {
	it("keeps an uplink up when failed and successful rounds alternate", () => {
		// Given
		const engine = new UplinkHealthEngine();

		// When
		for (const [index, outcome] of (
			[
				"failure",
				"success",
				"failure",
				"success",
				"failure",
			] as const satisfies readonly ("failure" | "success")[]
		).entries()) {
			engine.observe({ iface: IFACE, kind: "cellular", outcome, now: index });
		}

		// Then
		expect(engine.get(IFACE)?.state).toBe("up");
	});

	it("goes down on the third consecutive failure without delaying the transition", () => {
		// Given
		const engine = new UplinkHealthEngine();

		// When
		for (
			let round = 1;
			round <= UPLINK_HEALTH_CONFIG.failedRoundsDown;
			round++
		) {
			engine.observe({
				iface: IFACE,
				kind: "cellular",
				outcome: "failure",
				now: round,
			});
		}

		// Then
		expect(engine.get(IFACE)).toMatchObject({
			state: "down",
			weight: 0,
			lastTransition: UPLINK_HEALTH_CONFIG.failedRoundsDown,
		});
		expect(engine.isClientSteeringEligible(IFACE)).toBe(false);
	});

	it("requires the full hold-down and five successes before returning up", () => {
		// Given
		const engine = new UplinkHealthEngine();
		for (
			let round = 1;
			round <= UPLINK_HEALTH_CONFIG.failedRoundsDown;
			round++
		) {
			engine.observe({
				iface: IFACE,
				kind: "cellular",
				outcome: "failure",
				now: round,
			});
		}

		// When
		const beforeDwell = UPLINK_HEALTH_CONFIG.holdDownMs - 1;
		for (
			let round = 0;
			round < UPLINK_HEALTH_CONFIG.successfulRoundsUp;
			round++
		) {
			engine.observe({
				iface: IFACE,
				kind: "cellular",
				outcome: "success",
				now: beforeDwell,
			});
		}

		// Then
		expect(engine.get(IFACE)?.state).toBe("down");

		// When
		engine.observe({
			iface: IFACE,
			kind: "cellular",
			outcome: "success",
			now: UPLINK_HEALTH_CONFIG.holdDownMs + 3,
		});

		// Then
		expect(engine.get(IFACE)?.state).toBe("up");
	});
});

describe("uplink health exceptional evidence", () => {
	it("degrades a captive portal without removing client-steering eligibility", () => {
		// Given
		const engine = new UplinkHealthEngine();

		// When
		engine.observe({
			iface: IFACE,
			kind: "cellular",
			outcome: "captive_portal",
			now: 10,
		});

		// Then
		expect(engine.get(IFACE)).toMatchObject({
			state: "degraded",
			reason: "captive_portal",
		});
		expect(engine.isClientSteeringEligible(IFACE)).toBe(true);
	});

	it("degrades on passive congestion but removes steering only on definitive loss", () => {
		// Given
		const engine = new UplinkHealthEngine();

		// When
		engine.observe({
			iface: IFACE,
			kind: "cellular",
			outcome: "passive_degraded",
			now: 20,
		});

		// Then
		expect(engine.get(IFACE)?.state).toBe("degraded");
		expect(engine.isClientSteeringEligible(IFACE)).toBe(true);

		// When
		engine.observe({
			iface: IFACE,
			kind: "cellular",
			outcome: "definitive_loss",
			now: 21,
		});

		// Then
		expect(engine.get(IFACE)?.state).toBe("down");
		expect(engine.isClientSteeringEligible(IFACE)).toBe(false);
	});
});

describe("uplink health runtime", () => {
	it("uses passive SRTLA telemetry without spawning an active probe while streaming", async () => {
		// Given
		const engine = new UplinkHealthEngine();
		setUplinkHealthEngineForTest(engine);
		let probes = 0;
		const runtime = new UplinkHealthRuntime({
			now: () => 10_000,
			interfaces: () => ({
				wwan0: {
					ip: "10.0.0.2",
					tp: 0,
					txb: 0,
					rxb: 0,
					enabled: true,
					error: 0,
				},
			}),
			streaming: () => true,
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
				lastReadMs: 9_999,
			}),
			resolveTarget: () => Promise.resolve("142.251.133.99"),
			probe: async () => {
				probes++;
				return "success";
			},
			publish: () => undefined,
		});

		// When
		await runtime.tick();

		// Then
		expect(probes).toBe(0);
		expect(runtime.records()[0]).toMatchObject({
			state: "degraded",
			reason: "passive_congestion",
		});
	});

	it("three unreachable rounds drive up to down at the exact threshold, against ONE resolved target", async () => {
		// Given
		const engine = new UplinkHealthEngine();
		setUplinkHealthEngineForTest(engine);
		let now = 0;
		const targets: string[] = [];
		const runtime = new UplinkHealthRuntime({
			now: () => ++now,
			interfaces: () => ({
				eth0: {
					ip: "192.0.2.2",
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
			probe: async (_iface, remoteAddr) => {
				targets.push(remoteAddr);
				return "failure";
			},
			publish: () => undefined,
		});

		// When
		await runtime.tick();
		await runtime.tick();
		await runtime.tick();

		// Then every round aimed at the SAME resolved connectivity-check address:
		// the retired `gateway`/`public_ip`/`https_204` rotation named three
		// target CLASSES that were never three different probes.
		expect(targets).toEqual([
			"142.251.133.99",
			"142.251.133.99",
			"142.251.133.99",
		]);
		expect(runtime.records()[0]).toMatchObject({
			state: "down",
			lastTransition: 3,
		});
	});
});

describe("uplink health asynchronous round ownership", () => {
	const target = "192.0.2.100";
	const netif = (): NetworkInterface => ({
		ip: "192.0.2.2",
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
	});

	function fixture(overrides: Partial<UplinkHealthRuntimeDeps> = {}) {
		const engine = new UplinkHealthEngine();
		setUplinkHealthEngineForTest(engine);
		const interfaces: Record<string, NetworkInterface> = { eth0: netif() };
		const probe = mock(() => Promise.resolve("success" as const));
		const publish = mock(() => undefined);
		const runtime = new UplinkHealthRuntime({
			now: () => 1_000,
			interfaces: () => interfaces,
			streaming: () => false,
			telemetry: () => null,
			resolveTarget: () => Promise.resolve(target),
			probe,
			publish,
			...overrides,
		});
		return { runtime, engine, interfaces, probe, publish };
	}

	const changes: {
		name: string;
		apply: (interfaces: Record<string, NetworkInterface>) => void;
	}[] = [
		{ name: "removed", apply: (interfaces) => delete interfaces.eth0 },
		{
			name: "replaced with another address",
			apply: (interfaces) => {
				interfaces.eth0 = { ...netif(), ip: "192.0.2.3" };
			},
		},
		{
			name: "address mutated in place",
			apply: (interfaces) => {
				const entry = interfaces.eth0;
				if (entry) entry.ip = "192.0.2.3";
			},
		},
		{
			name: "eligibility mutated in place",
			apply: (interfaces) => {
				const entry = interfaces.eth0;
				if (entry) entry.error = NETIF_ERR_SHAREDLAN;
			},
		},
	];

	for (const change of changes) {
		it(`does not start a probe when the link is ${change.name} during target resolution`, async () => {
			const resolution = Promise.withResolvers<string>();
			const h = fixture({ resolveTarget: () => resolution.promise });
			const pending = h.runtime.tick();
			change.apply(h.interfaces);
			resolution.resolve(target);
			await pending;

			expect(h.probe).not.toHaveBeenCalled();
			expect(h.runtime.records()).toEqual([]);
		});

		it(`discards a probe result when the link is ${change.name} during the probe`, async () => {
			const result = Promise.withResolvers<UplinkHealthOutcome>();
			const started = Promise.withResolvers<void>();
			const h = fixture({
				probe: () => {
					started.resolve();
					return result.promise;
				},
			});
			const pending = h.runtime.tick();
			await started.promise;
			change.apply(h.interfaces);
			result.resolve("captive_portal");
			await pending;

			expect(h.runtime.records()).toEqual([]);
		});

		it(`retains a newer sample of a link ${change.name} while that tick waits on a peer`, async () => {
			const result = Promise.withResolvers<UplinkHealthOutcome>();
			const started = Promise.withResolvers<void>();
			const resolution = Promise.withResolvers<string | undefined>();
			let resolutions = 0;
			const h = fixture({
				resolveTarget: () =>
					resolutions++ === 0 ? Promise.resolve(target) : resolution.promise,
				probe: () => {
					started.resolve();
					return result.promise;
				},
			});
			const older = h.runtime.tick();
			await started.promise;
			change.apply(h.interfaces);
			h.interfaces.eth1 = netif();
			const newer = h.runtime.tick();
			h.interfaces.eth0 = netif();
			result.resolve("captive_portal");
			await older;
			expect(h.runtime.records()).toEqual([]);
			resolution.resolve(undefined);
			await newer;
		});
	}

	for (const outcome of ["success", "failure", "captive_portal"] as const) {
		it(`keeps newer loss evidence when an older probe returns ${outcome}`, async () => {
			const result = Promise.withResolvers<UplinkHealthOutcome>();
			const started = Promise.withResolvers<void>();
			let now = 1_000;
			const h = fixture({
				now: () => now,
				probe: () => {
					started.resolve();
					return result.promise;
				},
			});
			const older = h.runtime.tick();
			await started.promise;
			h.interfaces.eth0 = { ...netif(), ip: undefined };
			now = 2_000;
			await h.runtime.tick();
			const newer = h.runtime.records();
			expect(newer[0]).toMatchObject({
				state: "down",
				reason: "definitive_loss",
			});
			const publications = h.publish.mock.calls.length;

			// Restore the sampled address to isolate tick ordering from address checks.
			h.interfaces.eth0 = netif();
			result.resolve(outcome);
			await older;
			expect(h.runtime.records()).toEqual(newer);
			expect(h.publish).toHaveBeenCalledTimes(publications);
		});
	}

	it("does not launch an older target round after a newer loss tick", async () => {
		const resolution = Promise.withResolvers<string>();
		const h = fixture({ resolveTarget: () => resolution.promise });
		const older = h.runtime.tick();
		h.interfaces.eth0 = { ...netif(), ip: undefined };
		await h.runtime.tick();
		const newer = h.runtime.records();
		h.interfaces.eth0 = netif();
		resolution.resolve(target);
		await older;

		expect(h.probe).not.toHaveBeenCalled();
		expect(h.runtime.records()).toEqual(newer);
	});

	it("preserves newer loss before that tick finishes waiting for a peer's target", async () => {
		const result = Promise.withResolvers<UplinkHealthOutcome>();
		const started = Promise.withResolvers<void>();
		const resolution = Promise.withResolvers<string | undefined>();
		let resolutions = 0;
		const h = fixture({
			resolveTarget: () =>
				resolutions++ === 0 ? Promise.resolve(target) : resolution.promise,
			probe: () => {
				started.resolve();
				return result.promise;
			},
		});
		const older = h.runtime.tick();
		await started.promise;
		h.interfaces.eth0 = { ...netif(), ip: undefined };
		h.interfaces.eth1 = netif();
		const newer = h.runtime.tick();
		const loss = h.runtime.records();
		h.interfaces.eth0 = netif();
		result.resolve("captive_portal");
		await older;
		expect(h.runtime.records()).toEqual(loss);
		resolution.resolve(undefined);
		await newer;
	});

	it("keeps valid slow evidence when a newer tick is still awaiting its own probe", async () => {
		const first = Promise.withResolvers<UplinkHealthOutcome>();
		const second = Promise.withResolvers<UplinkHealthOutcome>();
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		let probes = 0;
		const h = fixture({
			probe: () => {
				if (probes++ === 0) {
					firstStarted.resolve();
					return first.promise;
				}
				secondStarted.resolve();
				return second.promise;
			},
		});
		const older = h.runtime.tick();
		await firstStarted.promise;
		const newer = h.runtime.tick();
		await secondStarted.promise;
		first.resolve("success");
		await older;
		expect(h.runtime.records()[0]?.probes.successes).toBe(1);
		second.resolve("failure");
		await newer;
		expect(h.runtime.records()[0]?.probes).toEqual({
			successes: 0,
			failures: 1,
		});
	});

	it("rechecks later batches while retaining current peers' results", async () => {
		const result = Promise.withResolvers<UplinkHealthOutcome>();
		const started = Promise.withResolvers<void>();
		const probe = mock(() => {
			started.resolve();
			return result.promise;
		});
		const h = fixture({ probe });
		for (let i = 1; i <= UPLINK_HEALTH_CONFIG.maxConcurrentProbes; i++) {
			h.interfaces[`eth${i}`] = netif();
		}
		const pending = h.runtime.tick();
		await started.promise;
		h.interfaces[`eth${UPLINK_HEALTH_CONFIG.maxConcurrentProbes}`] = {
			...netif(),
			error: NETIF_ERR_SHAREDLAN,
		};
		result.resolve("success");
		await pending;

		expect(probe).toHaveBeenCalledTimes(
			UPLINK_HEALTH_CONFIG.maxConcurrentProbes,
		);
		expect(h.runtime.records().map((record) => record.iface)).toEqual([
			"eth0",
			"eth1",
			"eth2",
		]);
	});

	it("accepts current deferred evidence despite unrelated counters and bond selection changing", async () => {
		const resolution = Promise.withResolvers<string>();
		const result = Promise.withResolvers<UplinkHealthOutcome>();
		const started = Promise.withResolvers<void>();
		const probe = mock(() => {
			started.resolve();
			return result.promise;
		});
		const h = fixture({ resolveTarget: () => resolution.promise, probe });
		const pending = h.runtime.tick();
		h.interfaces.eth0 = { ...netif(), enabled: false, txb: 100, rxb: 200 };
		resolution.resolve(target);
		await started.promise;
		result.resolve("success");
		await pending;

		expect(probe).toHaveBeenCalledTimes(1);
		expect(probe).toHaveBeenCalledWith("eth0", target);
		expect(h.runtime.records()[0]).toMatchObject({
			state: "up",
			probes: { successes: 1, failures: 0 },
			signals: { activeAt: 1_000 },
		});
	});
});
