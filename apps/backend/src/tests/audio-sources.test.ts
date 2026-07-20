import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { audioSourceSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";

import { buildMockAudioDevices } from "../mocks/fixture-factory.ts";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { getMockAudioDevices } from "../mocks/providers/streaming.ts";
import {
	deriveAudioSources,
	getAudioDevices,
	setMockAudioDevicesProvider,
	updateAudioDevices,
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

describe("deriveAudioSources — typed audio-source model", () => {
	test("default (pseudo-sources only) → exactly one none + one pipeline_default", () => {
		const sources = deriveAudioSources();

		expect(sources.filter((s) => s.kind === "none")).toHaveLength(1);
		expect(sources.filter((s) => s.kind === "pipeline_default")).toHaveLength(
			1,
		);

		const noAudio = sources.find((s) => s.kind === "none");
		const pipelineDefault = sources.find((s) => s.kind === "pipeline_default");
		expect(noAudio).toEqual({
			id: "No audio",
			kind: "none",
			labelKey: "audio.sources.noAudio",
		});
		expect(pipelineDefault).toEqual({
			id: "Pipeline default",
			kind: "pipeline_default",
			labelKey: "audio.sources.pipelineDefault",
		});
	});

	test("ids are byte-equal to the asrcs entries (config.asrc wire compat)", () => {
		initMockService("caps-full");
		setMockAudioDevicesProvider(getMockAudioDevices);

		const asrcs = Object.keys(getAudioDevices());
		const sources = deriveAudioSources();

		expect(sources.map((s) => s.id)).toEqual(asrcs);
	});

	test("device entries carry kind='device' with NO labelKey (untranslated hardware names)", () => {
		setMockAudioDevicesProvider(() =>
			buildMockAudioDevices({ HDMI: "rockchiphdmiin" }),
		);

		const sources = deriveAudioSources();
		const usb = sources.find((s) => s.id === "RØDE AI-Micro");
		const hdmi = sources.find((s) => s.id === "HDMI");

		expect(usb).toEqual({ id: "RØDE AI-Micro", kind: "device" });
		expect(hdmi).toEqual({ id: "HDMI", kind: "device" });
		for (const device of sources.filter((s) => s.kind === "device")) {
			expect(device.labelKey).toBeUndefined();
		}
		// The two pseudo-sources are still present and unique.
		expect(sources.filter((s) => s.kind === "none")).toHaveLength(1);
		expect(sources.filter((s) => s.kind === "pipeline_default")).toHaveLength(
			1,
		);
	});

	test("every derived entry validates against audioSourceSchema", () => {
		setMockAudioDevicesProvider(() =>
			buildMockAudioDevices({ HDMI: "rockchiphdmiin" }),
		);

		const parsed = z.array(audioSourceSchema).parse(deriveAudioSources());
		expect(parsed).toEqual(deriveAudioSources());
	});
});

describe("updateAudioDevices — sysfs card discovery", () => {
	test("finds card IDs from card*/id files in a sysfs-shaped directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-audio-"));
		try {
			await mkdir(join(root, "card0"));
			await mkdir(join(root, "card5"));
			await Bun.write(join(root, "card0", "id"), "rockchiphdmi0\n");
			await Bun.write(join(root, "card5", "id"), "usbaudio\n");

			await updateAudioDevices(root);

			expect(Object.keys(getAudioDevices())).toContain("USB audio");
			expect(Object.keys(getAudioDevices())).not.toContain("rockchiphdmi0");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
