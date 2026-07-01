/*
 * T3 — device-stats dev/mock seam (ceraui-experience-hardening).
 *
 * Boots the REAL mock path (`initMockService` under MOCK_MODE) and proves the
 * internal `resolveDeviceStatsDeps()` seam in device-stats.ts drives ALL FIVE
 * signals (disk, cpuLoad1, socTemp, ifaceRxTx, raucSlot) to plausible non-null
 * fixture values instead of the dev-host degradation-to-null — with socTemp
 * supplied DIRECTLY (the sensors broadcast never populates getSensors() in mock
 * mode). Also proves the production path is untouched: with mocks off the seam
 * returns the real `defaultDeviceStatsDeps`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mockDeviceStatsSchema } from "../mocks/mock-schemas.ts";
import {
	initMockService,
	shouldUseMocks,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	getMockDeviceStatsDeps,
	MOCK_DEVICE_STATS,
	shouldMockDeviceStats,
} from "../mocks/providers/device-stats.ts";
import {
	collectDeviceStats,
	createDeviceStatsState,
	defaultDeviceStatsDeps,
	resolveDeviceStatsDeps,
} from "../modules/system/device-stats.ts";

const ORIGINAL_MOCK_MODE = process.env.MOCK_MODE;

describe("device-stats mock seam (shouldUseMocks path)", () => {
	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
	});

	afterAll(() => {
		stopMockService();
		if (ORIGINAL_MOCK_MODE === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
	});

	test("fixture validates against mockDeviceStatsSchema", () => {
		expect(mockDeviceStatsSchema.safeParse(MOCK_DEVICE_STATS).success).toBe(
			true,
		);
	});

	test("the seam selects the mock deps (not the hardware deps) under mocks", () => {
		expect(shouldUseMocks()).toBe(true);
		expect(shouldMockDeviceStats()).toBe(true);
		expect(resolveDeviceStatsDeps()).not.toBe(defaultDeviceStatsDeps);
	});

	test("first tick is the rx/tx baseline — 4 signals already non-null", async () => {
		const payload = await collectDeviceStats(
			getMockDeviceStatsDeps(),
			createDeviceStatsState(),
		);
		expect(payload.disk).not.toBeNull();
		expect(payload.cpuLoad1).not.toBeNull();
		expect(payload.socTemp).not.toBeNull();
		expect(payload.raucSlot).not.toBe("unavailable");
		expect(payload.ifaceRxTx).toBeNull();
	});

	test("steady-state tick drives ALL five signals non-null, fixture-exact", async () => {
		const deps = getMockDeviceStatsDeps();
		const state = createDeviceStatsState();
		await collectDeviceStats(deps, state);
		const payload = await collectDeviceStats(deps, state);

		expect(payload.disk).not.toBeNull();
		expect(payload.cpuLoad1).not.toBeNull();
		expect(payload.socTemp).not.toBeNull();
		expect(payload.ifaceRxTx).not.toBeNull();
		expect(payload.raucSlot).not.toBe("unavailable");

		expect(payload).toEqual(MOCK_DEVICE_STATS);
	});

	test("socTemp is supplied directly despite the empty sensors map", async () => {
		const payload = await collectDeviceStats(
			getMockDeviceStatsDeps(),
			createDeviceStatsState(),
		);
		expect(payload.socTemp).toBe(MOCK_DEVICE_STATS.socTemp);
	});
});

describe("device-stats seam — production path untouched", () => {
	beforeAll(() => {
		stopMockService();
		if (ORIGINAL_MOCK_MODE === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
	});

	test("with mocks off the seam returns the real hardware deps", () => {
		expect(shouldMockDeviceStats()).toBe(false);
		expect(resolveDeviceStatsDeps()).toBe(defaultDeviceStatsDeps);
	});
});
