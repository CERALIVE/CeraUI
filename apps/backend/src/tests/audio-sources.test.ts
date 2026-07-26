import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUDIO_SOURCE_AUTO, audioSourceSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";

import { buildMockAudioDevices } from "../mocks/fixture-factory.ts";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { getMockAudioDevices } from "../mocks/providers/streaming.ts";
import {
	deriveAudioSources,
	getAudioDevices,
	hasCapturePcmNode,
	isMeterPreferenceDevicePresent,
	resolveMeterPreference,
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

// The idle level meter can only follow the picker if the picker's value is first
// turned into something `alsasrc device=` understands. `null` is the explicit
// "engine, choose for yourself" hand-back — never a silent no-op.
describe("resolveMeterPreference — picker value → idle-meter ALSA device", () => {
	test("an explicit device pick resolves to its hw:CARD= form", () => {
		expect(resolveMeterPreference("USB audio")).toBe("hw:CARD=usbaudio");
	});

	test("a card with no display alias keeps its own id", () => {
		expect(resolveMeterPreference("MINI")).toBe("hw:CARD=MINI");
	});

	test("Auto, the pseudo-sources and an unset pick all hand back to the engine", () => {
		for (const asrc of [
			AUDIO_SOURCE_AUTO,
			"No audio",
			"Pipeline default",
			undefined,
		]) {
			expect(resolveMeterPreference(asrc)).toBeNull();
		}
	});

	test("a value that already names an ALSA selector passes through unchanged", () => {
		expect(resolveMeterPreference("hw:CARD=usbaudio")).toBe("hw:CARD=usbaudio");
		expect(resolveMeterPreference("plughw:1,0")).toBe("plughw:1,0");
	});
});

describe("hasCapturePcmNode — ALSA capture substream detection", () => {
	test("a card exposing a pcmC<N>D<M>c node can be captured from", () => {
		expect(hasCapturePcmNode(["controlC5", "id", "number", "pcmC5D0c"])).toBe(
			true,
		);
		expect(hasCapturePcmNode(["pcmC4D0c", "pcmC4D0p"])).toBe(true);
	});

	test("a playback-only card, and a card with no PCM node at all, cannot", () => {
		expect(hasCapturePcmNode(["controlC0", "id", "pcmC0D0p"])).toBe(false);
		expect(hasCapturePcmNode(["controlC3", "id", "number", "input5"])).toBe(
			false,
		);
		expect(hasCapturePcmNode([])).toBe(false);
	});
});

// Live board bug: with "HDMI Input" selected as the audio source, the meter read
// "Meter unavailable · Not the selected device". The RK3588 HDMI-RX card really
// is listed (`/proc/asound/cards` and the picker both show it), but with no
// signal it exposes NO capture PCM — `/proc/asound/pcm` reports
// "03-00: rockchip,hdmiin i2s-hifi-0 : " with no `capture N` field, and there is
// no `pcmC3D0c` node. Nothing can ever meter it, so the honest reason is
// `no_device`, not a mismatch that does not exist. Device-agnostic: the rule is
// "has a capture PCM", never a driver or card-id test.
describe("isMeterPreferenceDevicePresent — listed is not the same as usable", () => {
	async function scan(
		cards: Array<{ dir: string; id: string; entries?: string[] }>,
	): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "ceraui-capture-"));
		for (const card of cards) {
			await mkdir(join(root, card.dir));
			await Bun.write(join(root, card.dir, "id"), `${card.id}\n`);
			for (const entry of card.entries ?? []) {
				await mkdir(join(root, card.dir, entry));
			}
		}
		await updateAudioDevices(root);
		return root;
	}

	// The picker key for a card is alias-resolved and depends on the resolved
	// hardware kind, so look it up rather than hardcoding a display name.
	function pickerKeyFor(cardId: string): string {
		const entry = Object.entries(getAudioDevices()).find(
			([, id]) => id === cardId,
		);
		if (entry === undefined) throw new Error(`card ${cardId} is not listed`);
		return entry[0];
	}

	test("a listed card with ZERO capture PCM reports absent (→ no_device)", async () => {
		const root = await scan([
			{ dir: "card3", id: "rockchiphdmiin" },
			{ dir: "card5", id: "usbaudio", entries: ["pcmC5D0c"] },
		]);
		try {
			expect(
				isMeterPreferenceDevicePresent(pickerKeyFor("rockchiphdmiin")),
			).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a card that DOES own a capture PCM reports present (→ not_selected_device)", async () => {
		const root = await scan([
			{ dir: "card5", id: "usbaudio", entries: ["pcmC5D0c"] },
		]);
		try {
			expect(isMeterPreferenceDevicePresent(pickerKeyFor("usbaudio"))).toBe(
				true,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	// Device-agnostic: an unaliased third-party card follows the same rule, so the
	// verdict is "has a capture PCM", not anything about HDMI or Rockchip.
	test("the same card becomes present once its capture PCM appears", async () => {
		const without = await scan([{ dir: "card1", id: "MINI" }]);
		expect(isMeterPreferenceDevicePresent(pickerKeyFor("MINI"))).toBe(false);
		await rm(without, { recursive: true, force: true });

		const withCapture = await scan([
			{ dir: "card1", id: "MINI", entries: ["pcmC1D0c"] },
		]);
		try {
			expect(isMeterPreferenceDevicePresent(pickerKeyFor("MINI"))).toBe(true);
		} finally {
			await rm(withCapture, { recursive: true, force: true });
		}
	});

	test("a pick CeraUI does not list at all stays absent", async () => {
		const root = await scan([
			{ dir: "card5", id: "usbaudio", entries: ["pcmC5D0c"] },
		]);
		try {
			expect(isMeterPreferenceDevicePresent("Nonexistent")).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
