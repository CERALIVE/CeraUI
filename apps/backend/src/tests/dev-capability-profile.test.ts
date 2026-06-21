import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SCHEMA_VERSION } from "@ceralive/cerastream";
import {
	initMockService,
	shouldUseMocks,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	getMockEngineCapabilities,
	setMockEngineCapabilities,
} from "../mocks/providers/streaming.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
	getLastCapabilities,
	getSupportedTransports,
	MINIMAL_SAFE_CAPABILITIES,
} from "../modules/streaming/capabilities.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

// A fake authed local client that records the raw frames it receives, so a
// broadcast can be asserted without a real socket (mirrors status-relay.test.ts).
function makeClient(sent: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: 0 },
		send: (msg: string) => {
			sent.push(msg);
		},
	} as unknown as AppWebSocket;
}

function capabilitiesBroadcasts(
	sent: string[],
): Array<Record<string, unknown>> {
	return sent
		.map((s) => JSON.parse(s) as Record<string, unknown>)
		.filter((m) => "capabilities" in m);
}

// The mock provider and the capability cache are process-wide singletons; reset
// both and the env between cases so scenarios are exercised deterministically
// regardless of test order.
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

// Mirrors the boot injection at main.ts:133-137 exactly: the mock snapshot flows
// through the real getCapabilities() fallback ladder.
async function resolveLikeBoot() {
	return getCapabilities({
		fetchEngineCapabilities: async () => getMockEngineCapabilities(),
	});
}

describe("MOCK_SCENARIO=caps-full", () => {
	test("getCapabilities advertises audio_live_switch and the srt transport", async () => {
		bootMockScenario("caps-full");

		const result = await resolveLikeBoot();

		expect(result.engineUnavailable).toBe(false);
		expect(result.audio_live_switch).toBe(true);
		expect(getSupportedTransports()).toContain("srt");
		// the rich hardware profile flows through (not the TestPattern floor)
		expect(result.platform.supports_h265).toBe(true);
		expect(result.platform.hardware_accelerated).toBe(true);
		expect(
			result.sources.some((s) => s.id === "hdmi" && s.supports_audio),
		).toBe(true);
	});
});

describe("MOCK_SCENARIO=engine-starting", () => {
	test("a cold engine sets the engineStarting flag via the minimal floor", async () => {
		bootMockScenario("engine-starting");

		// the scenario drives the mock fetch to throw (engine not reachable yet)
		expect(() => getMockEngineCapabilities()).toThrow();

		const result = await resolveLikeBoot();

		expect(result.engineStarting).toBe(true);
		expect(result.engineUnavailable).toBe(true);
		// never empty: still the TestPattern-only safe floor
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]?.id).toBe("test");
	});
});

describe("MOCK_SCENARIO=engine-unavailable", () => {
	test("an unreachable engine sets engineUnavailable, serving the cached snapshot", async () => {
		bootMockScenario("engine-unavailable");

		// the scenario drives the mock fetch to throw (engine down)
		expect(() => getMockEngineCapabilities()).toThrow();

		// engine was reachable once this run → last-known-good is cached...
		await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps: structuredClone(MINIMAL_SAFE_CAPABILITIES),
				schemaVersion: SCHEMA_VERSION,
			}),
		});
		// ...then it drops: the scenario fetch throws and the cache is served.
		const result = await resolveLikeBoot();

		expect(result.engineUnavailable).toBe(true);
		// served from cache, NOT the cold minimal floor — distinct from engine-starting.
		expect(result.engineStarting).toBeUndefined();
	});
});

describe("setMockEngineCapabilities (TEST-ONLY seam)", () => {
	test("rebroadcasts capabilities with the overridden flag in idle state", async () => {
		bootMockScenario("multi-modem-wifi");
		// seed a baseline live snapshot so the seam re-resolves from a known state
		await resolveLikeBoot();

		const sent: string[] = [];
		const client = makeClient(sent);
		addClient(client);
		try {
			await setMockEngineCapabilities({ schemaVersionMismatch: true });
		} finally {
			removeClient(client);
		}

		const caps = capabilitiesBroadcasts(sent);
		expect(caps.length).toBeGreaterThan(0);
		const last = caps[caps.length - 1]?.capabilities as Record<string, unknown>;
		expect(last.schemaVersionMismatch).toBe(true);
		// the re-resolved last-known snapshot carries the flag too
		expect(getLastCapabilities()?.schemaVersionMismatch).toBe(true);
	});
});

describe("production isolation (shouldUseMocks() === false)", () => {
	test("the seam is a no-op and the real default fetch path is left untouched", async () => {
		// Force mocks OFF regardless of the ambient env.
		stopMockService();
		delete process.env.MOCK_MODE;
		process.env.NODE_ENV = "production";

		expect(shouldUseMocks()).toBe(false);

		const sent: string[] = [];
		const client = makeClient(sent);
		addClient(client);
		try {
			await setMockEngineCapabilities({ schemaVersionMismatch: true });
		} finally {
			removeClient(client);
		}
		// no capabilities frame was broadcast — the seam returned immediately.
		expect(capabilitiesBroadcasts(sent)).toHaveLength(0);

		// The boot injection (main.ts:133-137) selects the REAL default fetcher
		// when mocks are off — getMockEngineCapabilities is never wired in, so the
		// production defaultFetchEngineCapabilities path is untouched.
		const bootOverrides = shouldUseMocks()
			? { fetchEngineCapabilities: async () => getMockEngineCapabilities() }
			: {};
		expect(bootOverrides).toEqual({});
	});
});
