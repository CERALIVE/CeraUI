import { describe, expect, it } from "bun:test";

import {
	setUplinkHealthEngineForTest,
	UPLINK_HEALTH_CONFIG,
	UplinkHealthEngine,
	UplinkHealthRuntime,
} from "../modules/network/uplink-health/index.ts";

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
