import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ListDevicesResult } from "@ceralive/cerastream";
import { logger } from "../helpers/logger.ts";
import { resetMockState } from "../mocks/mock-service.ts";
import { deriveAudioSources } from "../modules/streaming/audio.ts";
import {
	type EngineAudioDevice,
	isHumanAudioName,
	parseAsoundCards,
	resetAudioNamingDiagnostics,
	resolveAudioIdentities,
	resolveAudioLabels,
} from "../modules/streaming/audio-naming.ts";
import {
	getEngineAudioDevices,
	getEngineDeviceCache,
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";

function engineAudio(
	alsa_card_id: string,
	display_name: string,
): EngineAudioDevice {
	return { input_id: `audio:${alsa_card_id}`, display_name, alsa_card_id };
}

describe("resolveAudioLabels — 3-tier fallback (engine-join → longname → alias)", () => {
	test("tier 1: engine-join wins over the longname for a human-quality name", () => {
		const labels = resolveAudioLabels(
			{ Micro: "Micro" },
			[engineAudio("Micro", "RØDE AI-Micro")],
			new Map([["Micro", "USB-Audio generic longname"]]),
		);
		expect(labels.get("Micro")).toBe("RØDE AI-Micro");
	});

	test("tier 2: a path-like engine display_name is REJECTED and the longname wins", () => {
		const labels = resolveAudioLabels(
			{ Micro: "Micro" },
			[engineAudio("Micro", "hw:1,0")],
			new Map([["Micro", "RØDE AI-Micro USB"]]),
		);
		expect(labels.get("Micro")).toBe("RØDE AI-Micro USB");
	});

	test("tier 2: an engine display_name byte-equal to the card id is REJECTED and the longname wins", () => {
		const labels = resolveAudioLabels(
			{ "USB audio": "usbaudio" },
			[engineAudio("usbaudio", "usbaudio")],
			new Map([["usbaudio", "Generic USB Audio Device"]]),
		);
		expect(labels.get("USB audio")).toBe("Generic USB Audio Device");
	});

	test("tier 2: longname fallback when the engine cache is empty", () => {
		const labels = resolveAudioLabels(
			{ "USB audio": "usbaudio" },
			[],
			new Map([["usbaudio", "Generic USB Audio Device"]]),
		);
		expect(labels.get("USB audio")).toBe("Generic USB Audio Device");
	});

	test("tier 3: empty longname map → falls back to the current alias name with NO throw", () => {
		let labels: Map<string, string> | undefined;
		expect(() => {
			labels = resolveAudioLabels(
				{ "USB audio": "usbaudio", HDMI: "rockchiphdmiin" },
				[],
				new Map(),
			);
		}).not.toThrow();
		expect(labels?.get("USB audio")).toBe("USB audio");
		expect(labels?.get("HDMI")).toBe("HDMI");
	});

	test("two identical labels dedupe with ' (2)' in stable card order", () => {
		const labels = resolveAudioLabels(
			{ Micro1: "Micro1", Micro2: "Micro2" },
			[
				engineAudio("Micro1", "RØDE AI-Micro"),
				engineAudio("Micro2", "RØDE AI-Micro"),
			],
			new Map(),
		);
		expect(labels.get("Micro1")).toBe("RØDE AI-Micro");
		expect(labels.get("Micro2")).toBe("RØDE AI-Micro (2)");
	});

	test("three identical labels dedupe ' (2)' then ' (3)' deterministically", () => {
		const cards = { A: "A", B: "B", C: "C" };
		const engine = [
			engineAudio("A", "Elgato Wave:3"),
			engineAudio("B", "Elgato Wave:3"),
			engineAudio("C", "Elgato Wave:3"),
		];
		const first = resolveAudioLabels(cards, engine, new Map());
		const second = resolveAudioLabels(cards, engine, new Map());
		expect([...first.values()]).toEqual([
			"Elgato Wave:3",
			"Elgato Wave:3 (2)",
			"Elgato Wave:3 (3)",
		]);
		expect([...second.entries()]).toEqual([...first.entries()]);
	});

	test("config.asrc keys never change and the input map is not mutated", () => {
		const cards = {
			HDMI: "rockchiphdmiin",
			"USB audio": "usbaudio",
			"No audio": "No audio",
			"Pipeline default": "Pipeline default",
		};
		const snapshot = structuredClone(cards);
		const labels = resolveAudioLabels(
			cards,
			[engineAudio("usbaudio", "RØDE AI-Micro")],
			new Map(),
		);
		expect(cards).toEqual(snapshot);
		for (const key of labels.keys()) {
			expect(Object.keys(cards)).toContain(key);
		}
	});

	test("pseudo-sources are never labeled", () => {
		const labels = resolveAudioLabels(
			{
				"USB audio": "usbaudio",
				"No audio": "No audio",
				"Pipeline default": "Pipeline default",
			},
			[],
			new Map(),
		);
		expect(labels.has("No audio")).toBe(false);
		expect(labels.has("Pipeline default")).toBe(false);
		expect([...labels.keys()]).toEqual(["USB audio"]);
	});

	test("QA failure: an engine alsa_card_id matching NO scanned card yields no phantom entry", () => {
		const labels = resolveAudioLabels(
			{ "USB audio": "usbaudio" },
			[engineAudio("GhostCard", "Ghost Mic")],
			new Map(),
		);
		expect(labels.has("GhostCard")).toBe(false);
		expect([...labels.keys()]).toEqual(["USB audio"]);
		expect(labels.get("USB audio")).toBe("USB audio");
	});

	test("undefined alsa_card_id (pre-T18 pin) never joins — degrades to longname", () => {
		const labels = resolveAudioLabels(
			{ Micro: "Micro" },
			[{ input_id: "audio:Micro", display_name: "RØDE AI-Micro" }],
			new Map([["Micro", "RØDE longname"]]),
		);
		expect(labels.get("Micro")).toBe("RØDE longname");
	});
});

describe("isHumanAudioName — the tier-1 quality heuristic", () => {
	test("accepts a real hardware name", () => {
		expect(isHumanAudioName("RØDE AI-Micro", "Micro")).toBe(true);
		expect(isHumanAudioName("Elgato Wave:3", "Wave3")).toBe(true);
	});

	test("rejects a value with no letters", () => {
		expect(isHumanAudioName("0", "0")).toBe(false);
		expect(isHumanAudioName("   ", "Micro")).toBe(false);
		expect(isHumanAudioName("", "Micro")).toBe(false);
	});

	test("rejects path-like /dev/… and ALSA hw:… values", () => {
		expect(isHumanAudioName("/dev/snd/pcmC1D0c", "Micro")).toBe(false);
		expect(isHumanAudioName("hw:1,0", "Micro")).toBe(false);
		expect(isHumanAudioName("HW:CARD=Micro", "Micro")).toBe(false);
	});

	test("rejects a value byte-identical to the card id", () => {
		expect(isHumanAudioName("usbaudio", "usbaudio")).toBe(false);
	});
});

describe("parseAsoundCards — /proc/asound/cards longname map", () => {
	test("parses card id → longname (second continuation line)", () => {
		const text = [
			" 0 [rockchiphdmiin ]: rockchip_hdmirx - rockchip,hdmirx-controller",
			"                      rockchip,hdmirx-controller",
			" 1 [Micro          ]: USB-Audio - RØDE AI-Micro",
			"                      RØDE RØDE AI-Micro at usb-xhci-hcd.9.auto-1.4, high speed",
		].join("\n");
		const longnames = parseAsoundCards(text);
		expect(longnames.get("rockchiphdmiin")).toBe("rockchip,hdmirx-controller");
		expect(longnames.get("Micro")).toBe(
			"RØDE RØDE AI-Micro at usb-xhci-hcd.9.auto-1.4, high speed",
		);
	});

	test("garbled / empty input degrades to an empty map with NO throw", () => {
		expect(() => parseAsoundCards("")).not.toThrow();
		expect(parseAsoundCards("").size).toBe(0);
		expect(() => parseAsoundCards("--- no sound cards ---")).not.toThrow();
		expect(parseAsoundCards("--- no sound cards ---").size).toBe(0);
		expect(() =>
			parseAsoundCards("garbage\nwith\nno\nbracket\nheaders"),
		).not.toThrow();
		expect(parseAsoundCards("garbage\nwith\nno\nbracket\nheaders").size).toBe(
			0,
		);
	});

	test("a header line with no following longname is skipped", () => {
		const longnames = parseAsoundCards(" 0 [Micro          ]: USB-Audio");
		expect(longnames.size).toBe(0);
	});
});

describe("refreshEngineDeviceCache — audio join key survives into getEngineAudioDevices", () => {
	beforeEach(() => {
		resetEngineDeviceCache();
	});

	test("REGRESSION: a mixed video+audio list-devices result caches audio entries with alsa_card_id intact", async () => {
		const live = {
			devices: [
				{
					input_id: "video0",
					device_path: "/dev/video0",
					display_name: "HDMI Capture",
					media_class: "video",
					kind: "hdmi",
				},
				{
					input_id: "audio:Micro",
					device_path: "alsa:Micro",
					display_name: "RØDE AI-Micro",
					media_class: "audio",
					kind: "audio",
					alsa_card_id: "Micro",
				},
			],
		} as unknown as ListDevicesResult;

		await refreshEngineDeviceCache({ fetchEngineDevices: async () => live });

		const audio = getEngineAudioDevices();
		expect(audio).toHaveLength(1);
		expect(audio[0]).toEqual({
			input_id: "audio:Micro",
			display_name: "RØDE AI-Micro",
			alsa_card_id: "Micro",
		});

		// The video cache mapping is byte-unchanged: it still maps ALL devices via
		// fromEngineDevice (the media_class filter lives in buildSources' overlay,
		// not in the cache), so the parallel audio cache addition affects nothing.
		const video = getEngineDeviceCache();
		expect(video.map((d) => d.input_id)).toEqual(["video0", "audio:Micro"]);

		// End-to-end: the preserved join key labels the scanned card by name.
		const labels = resolveAudioLabels(
			{ Micro: "Micro" },
			getEngineAudioDevices(),
			new Map(),
		);
		expect(labels.get("Micro")).toBe("RØDE AI-Micro");
	});

	test("an audio entry without alsa_card_id caches display_name with the key omitted", async () => {
		const live = {
			devices: [
				{
					input_id: "audio:Micro",
					device_path: "alsa:Micro",
					display_name: "RØDE AI-Micro",
					media_class: "audio",
					kind: "audio",
				},
			],
		} as unknown as ListDevicesResult;

		await refreshEngineDeviceCache({ fetchEngineDevices: async () => live });
		const audio = getEngineAudioDevices();
		expect(audio).toHaveLength(1);
		expect(audio[0]).toEqual({
			input_id: "audio:Micro",
			display_name: "RØDE AI-Micro",
		});
		expect("alsa_card_id" in (audio[0] ?? {})).toBe(false);
	});

	test("a throwing fetch retains the prior audio cache", async () => {
		const live = {
			devices: [
				{
					input_id: "audio:Micro",
					device_path: "alsa:Micro",
					display_name: "RØDE AI-Micro",
					media_class: "audio",
					kind: "audio",
					alsa_card_id: "Micro",
				},
			],
		} as unknown as ListDevicesResult;
		await refreshEngineDeviceCache({ fetchEngineDevices: async () => live });
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => {
				throw new Error("engine unavailable");
			},
		});
		expect(getEngineAudioDevices()).toHaveLength(1);
		expect(getEngineAudioDevices()[0]?.alsa_card_id).toBe("Micro");
	});
});

describe("deriveAudioSources — label attachment", () => {
	test("device entries carry the resolved label; pseudo entries stay label-free; ids unchanged", () => {
		const devices = {
			HDMI: "rockchiphdmiin",
			"USB audio": "usbaudio",
			"No audio": "No audio",
			"Pipeline default": "Pipeline default",
		};
		const labels = new Map([
			["HDMI", "Rockchip HDMI In"],
			["USB audio", "RØDE AI-Micro"],
		]);
		const sources = deriveAudioSources(devices, labels);

		expect(sources.map((s) => s.id)).toEqual(Object.keys(devices));
		expect(sources.find((s) => s.id === "HDMI")).toEqual({
			id: "HDMI",
			kind: "device",
			label: "Rockchip HDMI In",
		});
		expect(sources.find((s) => s.id === "USB audio")).toEqual({
			id: "USB audio",
			kind: "device",
			label: "RØDE AI-Micro",
		});
		expect(sources.find((s) => s.id === "No audio")?.label).toBeUndefined();
		expect(
			sources.find((s) => s.id === "Pipeline default")?.label,
		).toBeUndefined();
	});

	test("a device with no resolved label carries no label field", () => {
		const sources = deriveAudioSources({ "USB audio": "usbaudio" }, new Map());
		expect(sources.find((s) => s.id === "USB audio")).toEqual({
			id: "USB audio",
			kind: "device",
		});
	});
});

describe("device naming/identity (device-quality-wave2 Todo 22)", () => {
	test("resolveAudioIdentities joins product_name/transport/stable_id on alsa_card_id", () => {
		const engine: EngineAudioDevice[] = [
			{
				input_id: "audio:usbaudio",
				display_name: "USB Audio",
				alsa_card_id: "usbaudio",
				product_name: "RØDE NT-USB",
				transport: "usb",
				stable_id: "card:usbaudio",
			},
		];
		const identities = resolveAudioIdentities(
			{ "USB audio": "usbaudio" },
			engine,
		);
		expect(identities.get("USB audio")).toEqual({
			product_name: "RØDE NT-USB",
			transport: "usb",
			stable_id: "card:usbaudio",
		});
	});

	test("a card with no matching engine entry (or a pre-2026.7.3 pin) yields no identity", () => {
		expect(resolveAudioIdentities({ "USB audio": "usbaudio" }, []).size).toBe(
			0,
		);
		const legacy: EngineAudioDevice[] = [
			{
				input_id: "audio:usbaudio",
				display_name: "USB Audio",
				alsa_card_id: "usbaudio",
			},
		];
		expect(
			resolveAudioIdentities({ "USB audio": "usbaudio" }, legacy).size,
		).toBe(0);
	});

	test("resolveAudioLabels prefers the real product_name over the generic display_name", () => {
		const engine: EngineAudioDevice[] = [
			{
				input_id: "audio:usbaudio",
				display_name: "USB Audio Device",
				alsa_card_id: "usbaudio",
				product_name: "RØDE NT-USB",
			},
		];
		const labels = resolveAudioLabels(
			{ "USB audio": "usbaudio" },
			engine,
			new Map(),
		);
		expect(labels.get("USB audio")).toBe("RØDE NT-USB");
	});

	test("deriveAudioSources attaches the identity fields onto device entries", () => {
		const identities = new Map([
			[
				"USB audio",
				{
					product_name: "RØDE NT-USB",
					transport: "usb" as const,
					stable_id: "card:usbaudio",
				},
			],
		]);
		const sources = deriveAudioSources(
			{ "USB audio": "usbaudio", "No audio": "No audio" },
			new Map([["USB audio", "RØDE NT-USB"]]),
			identities,
		);
		expect(sources.find((s) => s.id === "USB audio")).toEqual({
			id: "USB audio",
			kind: "device",
			label: "RØDE NT-USB",
			product_name: "RØDE NT-USB",
			transport: "usb",
			stable_id: "card:usbaudio",
		});
		// Pseudo-sources never carry identity fields.
		expect(sources.find((s) => s.id === "No audio")?.stable_id).toBeUndefined();
	});
});

// ─── Tier-3 alias-fallback diagnostic (Task 21) ──────────────────────────────

const USB_CARD = { "USB audio": "usbaudio" } as const;

describe("resolveAudioLabels — tier-3 alias-fallback diagnostic (one-shot per boot)", () => {
	let infoSpy: ReturnType<typeof spyOn<typeof logger, "info">>;

	beforeEach(() => {
		resetAudioNamingDiagnostics();
		infoSpy = spyOn(logger, "info").mockImplementation((() => logger) as never);
	});
	afterEach(() => {
		infoSpy.mockRestore();
		resetAudioNamingDiagnostics();
	});

	function diagnosticRecords(): Array<[string, Record<string, unknown>]> {
		const calls = infoSpy.mock.calls as unknown as unknown[][];
		return calls.filter(
			(call) =>
				(call[1] as { module?: string } | undefined)?.module === "audio-naming",
		) as Array<[string, Record<string, unknown>]>;
	}

	test("emits exactly ONE diagnostic across two resolve ticks (dedup by cardId)", () => {
		resolveAudioLabels({ ...USB_CARD }, [], new Map());
		resolveAudioLabels({ ...USB_CARD }, [], new Map());

		const records = diagnosticRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.[1]).toMatchObject({
			module: "audio-naming",
			cardId: "usbaudio",
			engineEntryPresent: false,
			longnamePresent: false,
		});
	});

	test("resetAudioNamingDiagnostics re-arms the one-shot: 2 ticks → 1, reset, 1 tick → 1 NEW", () => {
		resolveAudioLabels({ ...USB_CARD }, [], new Map());
		resolveAudioLabels({ ...USB_CARD }, [], new Map());
		expect(diagnosticRecords()).toHaveLength(1);

		resetAudioNamingDiagnostics();
		resolveAudioLabels({ ...USB_CARD }, [], new Map());
		expect(diagnosticRecords()).toHaveLength(2);
	});

	test("resetMockState() clears the one-shot (wiring): 2 ticks → 1, resetMockState(), 1 tick → 1 NEW", () => {
		resolveAudioLabels({ ...USB_CARD }, [], new Map());
		resolveAudioLabels({ ...USB_CARD }, [], new Map());
		expect(diagnosticRecords()).toHaveLength(1);

		resetMockState();
		resolveAudioLabels({ ...USB_CARD }, [], new Map());
		expect(diagnosticRecords()).toHaveLength(2);
	});

	test("dongle-miss (engine entry ABSENT + no longname): alias renders AND the diagnostic fires", () => {
		const labels = resolveAudioLabels({ ...USB_CARD }, [], new Map());
		expect(labels.get("USB audio")).toBe("USB audio");

		const records = diagnosticRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.[1]).toMatchObject({
			cardId: "usbaudio",
			engineEntryPresent: false,
			heuristicRejectReason: null,
			longnamePresent: false,
			engineEntriesWithoutJoinKey: 0,
		});
	});

	test("dongle-miss (engine entry FAILS isHumanAudioName + no longname): alias renders, reason named", () => {
		const labels = resolveAudioLabels(
			{ ...USB_CARD },
			[engineAudio("usbaudio", "usbaudio")],
			new Map(),
		);
		expect(labels.get("USB audio")).toBe("USB audio");

		const records = diagnosticRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.[1]).toMatchObject({
			cardId: "usbaudio",
			engineEntryPresent: true,
			heuristicRejectReason: "equals-card-id",
			longnamePresent: false,
		});
	});

	test("dongle-miss (RØDE named entry but alsa_card_id STRIPPED, pre-T18): surfaces engineEntriesWithoutJoinKey", () => {
		const labels = resolveAudioLabels(
			{ ...USB_CARD },
			[{ input_id: "audio:usb", display_name: "RØDE AI-Micro" }],
			new Map(),
		);
		expect(labels.get("USB audio")).toBe("USB audio");

		const records = diagnosticRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.[1]).toMatchObject({
			cardId: "usbaudio",
			engineEntryPresent: false,
			engineEntriesWithoutJoinKey: 1,
		});
	});

	test("no diagnostic when tier 1 (engine join) resolves a usbaudio card", () => {
		const labels = resolveAudioLabels(
			{ ...USB_CARD },
			[engineAudio("usbaudio", "RØDE AI-Micro")],
			new Map(),
		);
		expect(labels.get("USB audio")).toBe("RØDE AI-Micro");
		expect(diagnosticRecords()).toHaveLength(0);
	});

	test("no diagnostic when tier 2 (longname) resolves a usbaudio card", () => {
		const labels = resolveAudioLabels(
			{ ...USB_CARD },
			[],
			new Map([["usbaudio", "Generic USB Audio Device"]]),
		);
		expect(labels.get("USB audio")).toBe("Generic USB Audio Device");
		expect(diagnosticRecords()).toHaveLength(0);
	});

	test("no diagnostic when a NON-usbaudio card hits tier 3 (nameless HDMI is a different story)", () => {
		const labels = resolveAudioLabels(
			{ HDMI: "rockchiphdmiin" },
			[],
			new Map(),
		);
		expect(labels.get("HDMI")).toBe("HDMI");
		expect(diagnosticRecords()).toHaveLength(0);
	});

	test("DJI-style named device renders VERBATIM via tier 2 longname — no false diagnostic", () => {
		const labels = resolveAudioLabels(
			{ ...USB_CARD },
			[],
			new Map([["usbaudio", "DJI MIC MINI"]]),
		);
		expect(labels.get("USB audio")).toBe("DJI MIC MINI");
		expect(diagnosticRecords()).toHaveLength(0);
	});

	test("DJI-style named device renders VERBATIM via tier 1 engine join", () => {
		const labels = resolveAudioLabels(
			{ "DJI Audio": "djireceiver" },
			[engineAudio("djireceiver", "DJI MIC MINI")],
			new Map(),
		);
		expect(labels.get("DJI Audio")).toBe("DJI MIC MINI");
		expect(diagnosticRecords()).toHaveLength(0);
	});
});
