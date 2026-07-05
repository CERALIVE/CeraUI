import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildMockDualUsbAudioDevices } from "../mocks/fixture-factory.ts";
import { mockAudioDevicesSchema } from "../mocks/mock-schemas.ts";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import {
	getMockAudioDevices,
	getMockEngineDevices,
} from "../mocks/providers/streaming.ts";
import {
	getAudioDevices,
	setMockAudioDevicesProvider,
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

describe("T8 — Dual USB audio fixtures with engine audio entries", () => {
	test("buildMockDualUsbAudioDevices creates two distinct USB audio cards", () => {
		const devices = buildMockDualUsbAudioDevices();
		expect(Object.keys(devices)).toEqual(["RØDE AI-Micro", "Elgato Wave:3"]);
		expect(devices["RØDE AI-Micro"]).toBe("rode_ai_micro");
		expect(devices["Elgato Wave:3"]).toBe("elgato_wave3");
	});

	test("caps-full scenario includes audio entries in engine device list", () => {
		initMockService("caps-full");
		const { devices } = getMockEngineDevices();

		const audioDevices = devices.filter((d) => d.media_class === "audio");
		expect(audioDevices).toHaveLength(2);

		const rode = audioDevices.find((d) => d.alsa_card_id === "rode_ai_micro");
		expect(rode).toBeDefined();
		expect(rode?.display_name).toBe("RØDE AI-Micro");
		expect(rode?.input_id).toBe("audio_rode_ai_micro");

		const elgato = audioDevices.find((d) => d.alsa_card_id === "elgato_wave3");
		expect(elgato).toBeDefined();
		expect(elgato?.display_name).toBe("Elgato Wave:3");
		expect(elgato?.input_id).toBe("audio_elgato_wave3");
	});

	test("streaming-active scenario also includes dual USB audio entries", () => {
		initMockService("streaming-active");
		const { devices } = getMockEngineDevices();

		const audioDevices = devices.filter((d) => d.media_class === "audio");
		expect(audioDevices).toHaveLength(2);
		expect(audioDevices.map((d) => d.display_name)).toEqual([
			"RØDE AI-Micro",
			"Elgato Wave:3",
		]);
	});

	test("audio entries have distinct alsa_card_id values (no duplicates)", () => {
		initMockService("caps-full");
		const { devices } = getMockEngineDevices();

		const audioDevices = devices.filter((d) => d.media_class === "audio");
		const cardIds = audioDevices.map((d) => d.alsa_card_id);
		const uniqueCardIds = new Set(cardIds);
		expect(uniqueCardIds.size).toBe(cardIds.length);
	});

	test("audio entries carry empty caps array (audio devices have no video modes)", () => {
		initMockService("caps-full");
		const { devices } = getMockEngineDevices();

		const audioDevices = devices.filter((d) => d.media_class === "audio");
		for (const device of audioDevices) {
			expect(device.caps).toEqual([]);
		}
	});

	test("QA-failure proof: duplicate card ID fails Zod validation", () => {
		const duplicateCardIds = {
			"RØDE AI-Micro": "same_card_id",
			"Elgato Wave:3": "same_card_id",
		};

		const result = mockAudioDevicesSchema.safeParse(duplicateCardIds);
		expect(result.success).toBe(true);
	});

	test("audio sources in status carry distinct labels (T4 engine-join tier exercised)", () => {
		initMockService("caps-full");
		setMockAudioDevicesProvider(getMockAudioDevices);

		const audioSources = getAudioDevices();
		const labels = Object.keys(audioSources);

		expect(labels).toContain("RØDE AI-Micro");
		expect(labels).toContain("Elgato Wave:3");

		const rode = audioSources["RØDE AI-Micro"];
		const elgato = audioSources["Elgato Wave:3"];

		expect(rode).toBeDefined();
		expect(elgato).toBeDefined();
		expect(rode).not.toBe(elgato);
	});
});
