import { beforeEach, describe, expect, test } from "bun:test";
import {
	CerastreamConnectionError,
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import {
	type CapabilitiesLogger,
	type CapabilitiesResult,
	clearCapabilitiesCache,
	getCachedCapabilities,
	getCapabilities,
	MINIMAL_SAFE_CAPABILITIES,
} from "../modules/streaming/capabilities.ts";

// A realistic, NON-minimal engine snapshot whose source ids are distinguishable
// from the TestPattern-only floor, so a cached/live result is never mistaken for
// the minimal safe set.
function makeCaps(): GetCapabilitiesResult {
	return {
		platform: {
			supports_h265: true,
			hardware_accelerated: true,
			max_resolution: "3840x2160",
		},
		encoder: {
			codecs: ["H264", "H265"],
			bitrate_range: { min: 1000, max: 12000, unit: "kbps" },
		},
		sources: [
			{
				id: "hdmi",
				supports_audio: true,
				supports_resolution_override: true,
				supports_framerate_override: true,
				default_resolution: "1920x1080",
				default_framerate: 60,
			},
		],
	};
}

interface LogSpy {
	logger: CapabilitiesLogger;
	warns: Array<{ msg: string; meta?: unknown }>;
	infos: Array<{ msg: string; meta?: unknown }>;
	errors: Array<{ msg: string; meta?: unknown }>;
}

function logSpy(): LogSpy {
	const warns: Array<{ msg: string; meta?: unknown }> = [];
	const infos: Array<{ msg: string; meta?: unknown }> = [];
	const errors: Array<{ msg: string; meta?: unknown }> = [];
	return {
		warns,
		infos,
		errors,
		logger: {
			debug: () => {},
			info: (msg, meta) => infos.push({ msg, meta }),
			warn: (msg, meta) => warns.push({ msg, meta }),
			error: (msg, meta) => errors.push({ msg, meta }),
		},
	};
}

const silent: CapabilitiesLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

// The cache is process-wide; reset it before every case so ladder rungs are
// exercised deterministically regardless of test order.
beforeEach(() => {
	clearCapabilitiesCache();
});

describe("getCapabilities — live", () => {
	test("a live engine fetch returns the caps and populates the cache", async () => {
		const caps = makeCaps();

		const result: CapabilitiesResult = await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps,
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => ({ devices: [] }),
			logger: silent,
		});

		expect(result.engineUnavailable).toBe(false);
		expect(result.engineStarting).toBeUndefined();
		expect(result.schemaVersionMismatch).toBeUndefined();
		expect(result.sources).toEqual(caps.sources);
		expect(result.encoder).toEqual(caps.encoder);
		expect(result.platform).toEqual(caps.platform);
		// last-known-good is the live snapshot, without the UI freshness flags.
		expect(getCachedCapabilities()).toEqual(caps);
	});
});

describe("getCapabilities — cached fallback", () => {
	test("an engine error after a good fetch serves the cached snapshot", async () => {
		const caps = makeCaps();

		await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps,
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => ({ devices: [] }),
			logger: silent,
		});

		const result = await getCapabilities({
			fetchEngineCapabilities: async () => {
				throw new Error("engine down mid-session");
			},
			logger: silent,
		});

		expect(result.engineUnavailable).toBe(true);
		// served from cache, NOT the minimal floor.
		expect(result.engineStarting).toBeUndefined();
		expect(result.sources).toEqual(caps.sources);
		expect(result.sources.some((s) => s.id === "hdmi")).toBe(true);
	});
});

describe("getCapabilities — minimal safe set", () => {
	test("an engine error with an empty cache serves the TestPattern-only floor", async () => {
		const spy = logSpy();

		const result = await getCapabilities({
			fetchEngineCapabilities: async () => {
				throw new CerastreamConnectionError("no control socket");
			},
			logger: spy.logger,
		});

		expect(result.engineUnavailable).toBe(true);
		expect(result.engineStarting).toBe(true);
		// NEVER empty — exactly the single TestPattern source.
		expect(result.sources.length).toBeGreaterThan(0);
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]?.id).toBe("test");
		expect(result).toMatchObject({
			platform: MINIMAL_SAFE_CAPABILITIES.platform,
			encoder: MINIMAL_SAFE_CAPABILITIES.encoder,
		});
		expect(spy.warns.length).toBeGreaterThan(0);
		// a failed engine fetch must not leave a poisoned cache.
		expect(getCachedCapabilities()).toBeUndefined();
	});

	test("the returned minimal set is a copy — mutating it never poisons the constant", async () => {
		const result = await getCapabilities({
			fetchEngineCapabilities: async () => {
				throw new Error("engine down");
			},
			logger: silent,
		});

		result.sources.push({
			id: "tampered",
			supports_audio: false,
			supports_resolution_override: false,
			supports_framerate_override: false,
			default_resolution: "0x0",
			default_framerate: 0,
		});

		expect(MINIMAL_SAFE_CAPABILITIES.sources).toHaveLength(1);
		expect(MINIMAL_SAFE_CAPABILITIES.sources[0]?.id).toBe("test");
	});
});

describe("getCapabilities — schema_version skew", () => {
	test("an older engine schema_version warns and still returns a safe response", async () => {
		const caps = makeCaps();
		const spy = logSpy();

		const result = await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps,
				schemaVersion: "0.0.1-older",
			}),
			fetchEngineDevices: async () => ({ devices: [] }),
			bindingsSchemaVersion: SCHEMA_VERSION,
			logger: spy.logger,
		});

		// degrade, never crash: a warning is logged and a usable response returns.
		expect(spy.warns.some((w) => w.msg.includes("schema_version"))).toBe(true);
		expect(result.schemaVersionMismatch).toBe(true);
		expect(result.engineUnavailable).toBe(false);
		expect(result.sources).toEqual(caps.sources);
	});

	test("a matching schema_version does not warn and sets no mismatch flag", async () => {
		const caps = makeCaps();
		const spy = logSpy();

		const result = await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps,
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => ({ devices: [] }),
			bindingsSchemaVersion: SCHEMA_VERSION,
			logger: spy.logger,
		});

		expect(spy.warns.some((w) => w.msg.includes("schema_version"))).toBe(false);
		expect(result.schemaVersionMismatch).toBeUndefined();
	});
});
