import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StreamSource } from "@ceraui/rpc/schemas";
import { streamSourceSchema } from "@ceraui/rpc/schemas";
import { buildMockStreamSource } from "../mocks/fixture-factory.ts";
import {
	getMockState,
	initMockService,
	resetMockState,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	resolveMockNetworkIngestSignals,
	setMockNetworkIngestActive,
} from "../mocks/providers/network-ingest.ts";
import {
	getMockEngineCapabilities,
	getMockEngineDevices,
} from "../mocks/providers/streaming.ts";
import {
	capabilitySourceKinds,
	type NetworkIngestDeps,
	refreshNetworkIngestInfo,
	resetNetworkIngestState,
} from "../modules/network/network-ingest.ts";
import {
	clearCapabilitiesCache,
	getLastCapabilities,
} from "../modules/streaming/capabilities.ts";
import {
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import {
	getSourcesMessage,
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";

const RODE_NAME = "RØDE HDMI to USB-C: RØDE HDMI";

const ENV_KEYS = ["MOCK_MODE", "MOCK_SCENARIO", "NODE_ENV"] as const;
const savedEnv: Record<string, string | undefined> = {};

// A LAN interface with a usable IPv4 so the network-ingest snapshot resolves a
// publish URL deterministically on any CI host (no real /proc network read).
const LAN_NETIF = { eth0: { ip: "192.168.1.50", enabled: true } };

function ingestDeps(): NetworkIngestDeps {
	return {
		isRealDevice: async () => false,
		shouldUseMocks: () => true,
		resolveMockSignals: resolveMockNetworkIngestSignals,
		probeServiceActive: async () => false,
		probeMediamtxSrt: async () => false,
		getNetif: () => LAN_NETIF,
		getSourceKinds: () => capabilitySourceKinds(getLastCapabilities()),
	};
}

// Mirror the boot sequence (main.ts): mock caps + devices flow through the real
// getCapabilities() fold via initPipelines, then the engine-device cache and the
// network-ingest snapshot are refreshed, so getSourcesMessage() reads live caches.
async function bootLikeMain(scenario: string): Promise<void> {
	process.env.MOCK_MODE = "true";
	process.env.MOCK_SCENARIO = scenario;
	initMockService(scenario);
	clearCapabilitiesCache();
	resetEngineDeviceCache();
	resetNetworkIngestState();
	setMockHardware("rk3588");
	await initPipelines({
		fetchEngineCapabilities: async () => getMockEngineCapabilities(),
		fetchEngineDevices: async () => getMockEngineDevices(),
	});
	await refreshEngineDeviceCache({
		fetchEngineDevices: async () => getMockEngineDevices(),
	});
	await refreshNetworkIngestInfo(ingestDeps());
}

function captureOf(sources: StreamSource[], name: string) {
	return sources.find((s) => s.origin === "capture" && s.displayName === name);
}

beforeEach(() => {
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(async () => {
	stopMockService();
	clearCapabilitiesCache();
	resetEngineDeviceCache();
	resetNetworkIngestState();
	setMockHardware("rk3588");
	await initPipelines();
	for (const k of ENV_KEYS) {
		const v = savedEnv[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("buildMockStreamSource", () => {
	test("the default builder yields a schema-valid RØDE capture source", () => {
		const source = buildMockStreamSource();
		expect(streamSourceSchema.safeParse(source).success).toBe(true);
		expect(source.origin).toBe("capture");
		if (source.origin === "capture") {
			expect(source.displayName).toBe(RODE_NAME);
			expect(source.kind).toBe("uvc_h264");
		}
	});

	test("an out-of-contract override throws at the build site", () => {
		const bogus = { kind: "not-a-kind" } as unknown as Partial<StreamSource>;
		expect(() => buildMockStreamSource(bogus)).toThrow();
	});
});

describe("MOCK_SCENARIO=multi-modem-wifi — device-first sources parity", () => {
	test("the sources broadcast carries the RØDE capture, the test pattern, and live rtmp/srt", async () => {
		await bootLikeMain("multi-modem-wifi");

		const { sources } = getSourcesMessage();

		const rode = captureOf(sources, RODE_NAME);
		expect(rode).toBeDefined();
		if (rode?.origin === "capture") {
			// the mislabel regression: a "…HDMI…" USB dongle stays uvc_h264, never hdmi.
			expect(rode.kind).toBe("uvc_h264");
			expect(rode.kind).not.toBe("hdmi");
		}

		const testEntry = sources.find(
			(s) => s.origin === "virtual" && s.id === "test",
		);
		expect(testEntry).toBeDefined();

		const rtmp = sources.find((s) => s.origin === "network" && s.id === "rtmp");
		const srt = sources.find((s) => s.origin === "network" && s.id === "srt");
		expect(rtmp?.available).toBe(true);
		expect(srt?.available).toBe(true);
		if (rtmp?.origin === "network") expect(rtmp.url).not.toBeNull();
		if (srt?.origin === "network") expect(srt.url).not.toBeNull();
	});

	test("resetMockState() restores the seeded network-ingest signals", async () => {
		await bootLikeMain("multi-modem-wifi");

		setMockNetworkIngestActive("rtmp", false);
		expect(getMockState().networkIngestActive.rtmp).toBe(false);

		resetMockState();
		expect(getMockState().networkIngestActive.rtmp).toBe(true);
	});
});

describe("MOCK_SCENARIO=caps-full — two-dongle disambiguation", () => {
	test("two same-kind uvc dongles become two distinct capture entries", async () => {
		await bootLikeMain("caps-full");

		const { sources } = getSourcesMessage();
		const uvcCaptures = sources.filter(
			(s) => s.origin === "capture" && s.kind === "uvc_h264",
		);
		expect(uvcCaptures.length).toBe(2);
		expect(captureOf(sources, RODE_NAME)).toBeDefined();
	});
});

describe("MOCK_SCENARIO=engine-starting — minimal floor", () => {
	test("sources degrades to the test pattern only, without throwing", async () => {
		await bootLikeMain("engine-starting");

		const { sources } = getSourcesMessage();
		expect(sources.map((s) => s.id)).toEqual(["test"]);
		expect(sources[0]?.origin).toBe("virtual");
	});
});
