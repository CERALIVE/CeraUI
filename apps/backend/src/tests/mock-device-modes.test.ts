import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	buildMockCapsFullDeviceModes,
	buildMockDeviceModes,
} from "../mocks/fixture-factory.ts";
import {
	getMockState,
	initMockService,
	resetMockState,
	shouldUseMocks,
	stopMockService,
} from "../mocks/mock-service.ts";
import { setMockNetworkIngestMediamtxSrt } from "../mocks/providers/network-ingest.ts";
import {
	getMockEngineCapabilities,
	getMockEngineDevices,
	setMockEngineCapabilities,
} from "../mocks/providers/streaming.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
	getLastCapabilities,
} from "../modules/streaming/capabilities.ts";

// The mock provider and the capability cache are process-wide singletons; reset
// both and the env between cases so scenarios are exercised deterministically.
const ENV_KEYS = ["MOCK_MODE", "MOCK_SCENARIO", "NODE_ENV"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
	stopMockService();
	clearCapabilitiesCache();
	for (const k of ENV_KEYS) {
		const v = savedEnv[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function bootMockScenario(scenario: string): void {
	process.env.MOCK_MODE = "true";
	process.env.MOCK_SCENARIO = scenario;
	initMockService(scenario);
	clearCapabilitiesCache();
}

// Mirrors the boot injection (main.ts): the mock snapshot + devices flow through
// the real getCapabilities() fallback ladder, so device_modes is the genuine fold.
async function resolveLikeBoot() {
	return getCapabilities({
		fetchEngineCapabilities: async () => getMockEngineCapabilities(),
		fetchEngineDevices: async () => getMockEngineDevices(),
	});
}

describe("mock device_modes — scenario seeding through the real fold", () => {
	test("caps-full seeds the two-dongle HDMI + dual-uvc device_modes", async () => {
		bootMockScenario("caps-full");
		const result = await resolveLikeBoot();
		expect(result.device_modes).toEqual(buildMockCapsFullDeviceModes());
	});

	test("multi-modem-wifi (dev default) also seeds device_modes", async () => {
		bootMockScenario("multi-modem-wifi");
		const result = await resolveLikeBoot();
		expect(result.device_modes).toEqual(buildMockDeviceModes());
	});

	test("streaming-active seeds device_modes", async () => {
		bootMockScenario("streaming-active");
		const result = await resolveLikeBoot();
		expect(result.device_modes).toEqual(buildMockDeviceModes());
	});

	test("single-modem (no full profile) omits device_modes", async () => {
		bootMockScenario("single-modem");
		expect(getMockEngineDevices()).toEqual({ devices: [] });
		const result = await resolveLikeBoot();
		expect(result.device_modes).toBeUndefined();
	});
});

describe("mock device_modes — getMockEngineDevices expansion", () => {
	test("expands the seeded modes into a foldable list-devices result", () => {
		bootMockScenario("caps-full");
		const { devices } = getMockEngineDevices();
		expect(devices.map((d) => d.input_id)).toEqual(["hdmi", "usb", "usb2"]);
		const hdmi = devices[0];
		expect(hdmi?.kind).toBe("hdmi");
		expect(hdmi?.media_class).toBe("video");
		// 1080p@[30,60] + 2160p@[30] → three CaptureCaps with string-fraction rates.
		expect(hdmi?.caps).toEqual([
			{
				width: 1920,
				height: 1080,
				framerate: "30/1",
				media_type: "video/x-raw",
			},
			{
				width: 1920,
				height: 1080,
				framerate: "60/1",
				media_type: "video/x-raw",
			},
			{
				width: 3840,
				height: 2160,
				framerate: "30/1",
				media_type: "video/x-raw",
			},
		]);
	});

	test("is empty in production (shouldUseMocks() false)", () => {
		stopMockService();
		delete process.env.MOCK_MODE;
		process.env.NODE_ENV = "production";
		expect(shouldUseMocks()).toBe(false);
		expect(getMockEngineDevices()).toEqual({ devices: [] });
	});
});

describe("setMockEngineCapabilities — device_modes override seam", () => {
	test("a device_modes override flows through to the resolved caps", async () => {
		bootMockScenario("multi-modem-wifi");
		await resolveLikeBoot();

		const override = buildMockDeviceModes({
			usb: {
				kind: "mjpeg",
				modes: [{ width: 640, height: 480, framerates: [30] }],
			},
		});
		await setMockEngineCapabilities({ deviceModes: override });

		expect(getLastCapabilities()?.device_modes).toEqual(override);
	});
});

describe("resetMockState — restores device_modes override + topology flag", () => {
	test("clears a device_modes override back to the scenario default", async () => {
		bootMockScenario("multi-modem-wifi");

		await setMockEngineCapabilities({
			deviceModes: buildMockDeviceModes({
				extra: {
					kind: "camlink",
					modes: [{ width: 1, height: 1, framerates: [1] }],
				},
			}),
		});
		expect(getMockState().capabilityOverride?.deviceModes).toBeDefined();

		resetMockState();

		expect(getMockState().capabilityOverride).toBeNull();
		expect(getMockEngineDevices().devices.map((d) => d.input_id)).toEqual([
			"hdmi",
			"usb",
		]);
	});

	test("restores the network-ingest MediaMTX-SRT topology flag", () => {
		bootMockScenario("multi-modem-wifi");
		expect(getMockState().networkIngestMediamtxSrt).toBe(false);

		setMockNetworkIngestMediamtxSrt(true);
		expect(getMockState().networkIngestMediamtxSrt).toBe(true);

		resetMockState();
		expect(getMockState().networkIngestMediamtxSrt).toBe(false);
	});
});
