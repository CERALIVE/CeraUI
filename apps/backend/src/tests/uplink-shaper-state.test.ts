import { describe, expect, test } from "bun:test";

import {
	SHAPER_CONFIG,
	type ShaperApplyRequest,
	UplinkShaperCoordinator,
} from "../modules/network/uplink-shaper/index.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";

const shared = [
	{ identity: "a", ifname: "wwan0", mark: stableUplinkMark("a") },
] as const;

describe("UplinkShaperCoordinator edges", () => {
	test("idle to streaming applies bootstrap before any telemetry", async () => {
		const applied: ShaperApplyRequest[] = [];
		const coordinator = new UplinkShaperCoordinator({
			apply: async (request) => applied.push(request),
		});

		await coordinator.update({
			streaming: true,
			sharedUplinks: shared,
			telemetry: [{ iface: "wwan0", rttMs: 400, nakCount: 10, stale: false }],
		});

		expect(applied[0]?.mode).toBe("streaming");
		expect(applied[0]?.uplinks[0]?.capBps).toBe(SHAPER_CONFIG.bootstrapCapBps);
	});

	test("stale telemetry holds the last streaming cap", async () => {
		const applied: ShaperApplyRequest[] = [];
		const coordinator = new UplinkShaperCoordinator({
			apply: async (request) => applied.push(request),
		});
		await coordinator.update({
			streaming: true,
			sharedUplinks: shared,
			telemetry: [],
		});
		await coordinator.update({
			streaming: true,
			sharedUplinks: shared,
			telemetry: [{ iface: "wwan0", rttMs: 50, nakCount: 0, stale: true }],
		});

		expect(applied.at(-1)?.uplinks[0]?.capBps).toBe(
			SHAPER_CONFIG.bootstrapCapBps,
		);
	});

	test("streaming to idle removes caps on the lifecycle edge, not telemetry absence", async () => {
		const applied: ShaperApplyRequest[] = [];
		const coordinator = new UplinkShaperCoordinator({
			apply: async (request) => applied.push(request),
		});
		await coordinator.update({
			streaming: true,
			sharedUplinks: shared,
			telemetry: [],
		});
		await coordinator.update({
			streaming: false,
			sharedUplinks: shared,
			telemetry: [],
		});

		expect(applied.map((request) => request.mode)).toEqual([
			"streaming",
			"idle",
		]);
	});

	test("touches only uplinks supplied by steering's shared set", async () => {
		const applied: ShaperApplyRequest[] = [];
		const coordinator = new UplinkShaperCoordinator({
			apply: async (request) => applied.push(request),
		});
		await coordinator.update({
			streaming: true,
			sharedUplinks: shared,
			telemetry: [
				{ iface: "wwan0", rttMs: 50, nakCount: 0, stale: false },
				{ iface: "eth9", rttMs: 500, nakCount: 99, stale: false },
			],
		});

		expect(applied[0]?.uplinks.map((uplink) => uplink.ifname)).toEqual([
			"wwan0",
		]);
	});
});
