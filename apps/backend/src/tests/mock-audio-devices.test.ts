import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { logger } from "../helpers/logger.ts";
import { buildMockAudioDevices } from "../mocks/fixture-factory.ts";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { getMockAudioDevices } from "../mocks/providers/streaming.ts";
import { getConfig } from "../modules/config.ts";
import {
	getAudioDevices,
	setMockAudioDevicesProvider,
	warnIfConfiguredAudioSourceUnavailable,
} from "../modules/streaming/audio.ts";

const ENV_KEYS = ["MOCK_MODE", "MOCK_SCENARIO", "NODE_ENV"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
	process.env.NODE_ENV = "development";
});

afterEach(() => {
	stopMockService();
	setMockAudioDevicesProvider(undefined);
	for (const k of ENV_KEYS) {
		const v = savedEnv[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("buildMockAudioDevices — fixture-factory builder", () => {
	test("defaults to the USB-audio seed", () => {
		expect(buildMockAudioDevices()).toEqual({ "USB audio": "usbaudio" });
	});

	test("merges overrides onto the default seed", () => {
		expect(buildMockAudioDevices({ HDMI: "rockchiphdmiin" })).toEqual({
			"USB audio": "usbaudio",
			HDMI: "rockchiphdmiin",
		});
	});
});

describe("getMockAudioDevices — scenario seeding", () => {
	test("seeds USB audio for multi-modem-wifi", () => {
		initMockService("multi-modem-wifi");
		expect(getMockAudioDevices()).toEqual({ "USB audio": "usbaudio" });
	});

	test("seeds USB audio for streaming-active", () => {
		initMockService("streaming-active");
		expect(getMockAudioDevices()).toEqual({
			"RØDE AI-Micro": "rode_ai_micro",
			"Elgato Wave:3": "elgato_wave3",
		});
	});

	test("seeds USB audio + HDMI for caps-full", () => {
		initMockService("caps-full");
		expect(getMockAudioDevices()).toEqual({
			"RØDE AI-Micro": "rode_ai_micro",
			"Elgato Wave:3": "elgato_wave3",
		});
	});

	test("seeds nothing for single-modem", () => {
		initMockService("single-modem");
		expect(getMockAudioDevices()).toEqual({});
	});

	test("returns {} when mocks are inactive (production gate)", () => {
		// initMockService not called → mockState uninitialized → shouldUseMocks false.
		expect(getMockAudioDevices()).toEqual({});
	});
});

describe("getAudioDevices — status asrcs coherence", () => {
	test("status asrcs contains USB audio under multi-modem-wifi", () => {
		initMockService("multi-modem-wifi");
		setMockAudioDevicesProvider(getMockAudioDevices);

		const asrcs = Object.keys(getAudioDevices());
		expect(asrcs).toContain("USB audio");
		// The two pseudo-sources are never displaced by the seed.
		expect(asrcs).toContain("No audio");
		expect(asrcs).toContain("Pipeline default");
	});

	test("caps-full status asrcs also contains RØDE AI-Micro and Elgato Wave:3", () => {
		initMockService("caps-full");
		setMockAudioDevicesProvider(getMockAudioDevices);

		const asrcs = Object.keys(getAudioDevices());
		expect(asrcs).toContain("RØDE AI-Micro");
		expect(asrcs).toContain("Elgato Wave:3");
		// The two pseudo-sources are never displaced by the seed.
		expect(asrcs).toContain("No audio");
		expect(asrcs).toContain("Pipeline default");
	});

	test("an empty seed leaves only the pseudo-sources", () => {
		initMockService("single-modem");
		setMockAudioDevicesProvider(getMockAudioDevices);

		const asrcs = Object.keys(getAudioDevices());
		expect(asrcs).not.toContain("USB audio");
		expect(asrcs).toContain("No audio");
		expect(asrcs).toContain("Pipeline default");
	});
});

describe("warnIfConfiguredAudioSourceUnavailable — warn-only invariant", () => {
	test("warns for a bogus asrc without mutating config", () => {
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => logger);
		const before = structuredClone(getConfig());

		try {
			warnIfConfiguredAudioSourceUnavailable("Totally Bogus Device");
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0]?.[0]).toContain("Totally Bogus Device");
		} finally {
			warnSpy.mockRestore();
		}

		expect(getConfig()).toEqual(before);
	});

	test("does not warn for a present source (pseudo-source)", () => {
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			warnIfConfiguredAudioSourceUnavailable("Pipeline default");
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("does not warn for a seeded mock source", () => {
		initMockService("multi-modem-wifi");
		setMockAudioDevicesProvider(getMockAudioDevices);

		const warnSpy = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			warnIfConfiguredAudioSourceUnavailable("USB audio");
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("does not warn when asrc is undefined", () => {
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			warnIfConfiguredAudioSourceUnavailable(undefined);
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});
});
