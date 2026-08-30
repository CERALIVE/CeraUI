import { describe, expect, test } from "bun:test";
import type { CardAliases } from "../modules/streaming/audio-card-vocabulary.ts";
import {
	buildCardAliases,
	canonicalCardId,
	classifyMeterIdentity,
	engineAudioDeviceForCard,
	engineAudioDeviceString,
	isAliasOfCard,
	parseProcAsoundPcm,
} from "../modules/streaming/audio-card-vocabulary.ts";
import type { EngineAudioDevice } from "../modules/streaming/audio-naming.ts";
import {
	isHumanAudioName,
	resolveAudioIdentities,
} from "../modules/streaming/audio-naming.ts";

// Verbatim from the bench Rock 5B+ (192.168.78.132), kernel 7.2.0-ceralive-rk3588.
const BOARD_PROC_ASOUND_PCM = `00-00: fe470000.i2s-ES8316 HiFi ES8316 HiFi-0 : fe470000.i2s-ES8316 HiFi ES8316 HiFi-0 : playback 1 : capture 1
01-00: USB Audio : USB Audio : capture 1
04-00: fddf8000.i2s-i2s-hifi i2s-hifi-0 : fddf8000.i2s-i2s-hifi i2s-hifi-0 : capture 1
`;

// The same three cards as the engine's `list-devices` reported them on that board
// while running cerastream 2026.8.3 with `[audio] backend = "pipewire"`.
const BOARD_ENGINE_AUDIO: EngineAudioDevice[] = [
	{
		input_id: "hw:CARD=USB Audio",
		alsa_card_id: "USB Audio",
		display_name: "DJI MIC MINI Analog Stereo",
		product_name: "DJI Technology Co., Ltd. DJI MIC MINI",
		transport: "usb",
		stable_id: "card:USB Audio",
	},
	{
		input_id: "hw:CARD=fddf8000.i2s-i2s-hifi i2s-hifi-0",
		alsa_card_id: "fddf8000.i2s-i2s-hifi i2s-hifi-0",
		display_name: "Built-in Audio Stereo",
		stable_id: "card:fddf8000.i2s-i2s-hifi i2s-hifi-0",
	},
];

const BOARD_CARDS = [
	{ index: 0, id: "rk3588es8316" },
	{ index: 1, id: "usbaudio" },
	{ index: 4, id: "hdmirx" },
];

function boardAliases(): CardAliases {
	return buildCardAliases(
		BOARD_CARDS,
		parseProcAsoundPcm(BOARD_PROC_ASOUND_PCM),
	);
}

describe("parseProcAsoundPcm — the PCM id, keyed by card index", () => {
	test("reads the board's own /proc/asound/pcm", () => {
		const parsed = parseProcAsoundPcm(BOARD_PROC_ASOUND_PCM);
		expect([...(parsed.get(0) ?? [])]).toEqual([
			"fe470000.i2s-ES8316 HiFi ES8316 HiFi-0",
		]);
		expect([...(parsed.get(1) ?? [])]).toEqual(["USB Audio"]);
		expect([...(parsed.get(4) ?? [])]).toEqual([
			"fddf8000.i2s-i2s-hifi i2s-hifi-0",
		]);
		expect(parsed.get(2)).toBeUndefined();
	});

	test("collects every device of one card, and skips what it cannot read", () => {
		const parsed = parseProcAsoundPcm(
			[
				"02-00: First : First : capture 1",
				"02-01: Second : Second : capture 1",
				"",
				"garbage",
				"xx-yy: Nope : Nope",
			].join("\n"),
		);
		expect([...(parsed.get(2) ?? [])].sort()).toEqual(["First", "Second"]);
		expect(parsed.size).toBe(1);
	});

	test("an unreadable file is an empty vocabulary, never a throw", () => {
		expect(parseProcAsoundPcm(undefined).size).toBe(0);
		expect(parseProcAsoundPcm("").size).toBe(0);
	});
});

describe("buildCardAliases — a card always answers to its own kernel id", () => {
	test("pairs each kernel card id with the PCM id filed under its index", () => {
		const aliases = boardAliases();
		expect([...(aliases.get("usbaudio") ?? [])].sort()).toEqual([
			"USB Audio",
			"usbaudio",
		]);
		expect([...(aliases.get("hdmirx") ?? [])].sort()).toEqual([
			"fddf8000.i2s-i2s-hifi i2s-hifi-0",
			"hdmirx",
		]);
	});

	test("with no PCM data a card still answers to its own id", () => {
		const aliases = buildCardAliases(BOARD_CARDS, new Map());
		expect([...(aliases.get("usbaudio") ?? [])]).toEqual(["usbaudio"]);
		expect(isAliasOfCard("usbaudio", "usbaudio", aliases)).toBe(true);
		expect(isAliasOfCard("usbaudio", "USB Audio", aliases)).toBe(false);
	});
});

describe("canonicalCardId — which card is this name", () => {
	test("resolves either vocabulary onto the kernel card id", () => {
		const aliases = boardAliases();
		expect(canonicalCardId("usbaudio", aliases)).toBe("usbaudio");
		expect(canonicalCardId("USB Audio", aliases)).toBe("usbaudio");
		expect(canonicalCardId("fddf8000.i2s-i2s-hifi i2s-hifi-0", aliases)).toBe(
			"hdmirx",
		);
	});

	test("a name from no known vocabulary is undefined, never a guess", () => {
		const aliases = boardAliases();
		expect(canonicalCardId("something-else", aliases)).toBeUndefined();
		expect(canonicalCardId(undefined, aliases)).toBeUndefined();
	});
});

describe("engineAudioDeviceString — speak the ENGINE's vocabulary", () => {
	test("translates a kernel card id into the engine's own input_id", () => {
		const aliases = boardAliases();
		expect(
			engineAudioDeviceString(
				"usbaudio",
				"hw:CARD=usbaudio",
				BOARD_ENGINE_AUDIO,
				aliases,
			),
		).toBe("hw:CARD=USB Audio");
		expect(
			engineAudioDeviceString(
				"hdmirx",
				"hw:CARD=hdmirx",
				BOARD_ENGINE_AUDIO,
				aliases,
			),
		).toBe("hw:CARD=fddf8000.i2s-i2s-hifi i2s-hifi-0");
	});

	test("an ALSA-arm engine names the card the same, so this is byte-identical", () => {
		const aliases = boardAliases();
		const alsaArm: EngineAudioDevice[] = [
			{ input_id: "hw:CARD=usbaudio", alsa_card_id: "usbaudio" },
		];
		expect(
			engineAudioDeviceString("usbaudio", "hw:CARD=usbaudio", alsaArm, aliases),
		).toBe("hw:CARD=usbaudio");
	});

	test("a card the engine does not list keeps the caller's own value", () => {
		const aliases = boardAliases();
		expect(
			engineAudioDeviceString(
				"rk3588es8316",
				"hw:CARD=rk3588es8316",
				BOARD_ENGINE_AUDIO,
				aliases,
			),
		).toBe("hw:CARD=rk3588es8316");
		// An engine that has not answered yet invents nothing either.
		expect(
			engineAudioDeviceString("usbaudio", "hw:CARD=usbaudio", [], aliases),
		).toBe("hw:CARD=usbaudio");
		expect(engineAudioDeviceForCard("usbaudio", [], aliases)).toBeUndefined();
	});
});

describe("classifyMeterIdentity — suppress only what is PROVEN foreign", () => {
	test("the board's own cross-vocabulary pairing is a MATCH", () => {
		const aliases = boardAliases();
		expect(classifyMeterIdentity("usbaudio", "USB Audio", aliases)).toBe(
			"match",
		);
		expect(classifyMeterIdentity("USB Audio", "usbaudio", aliases)).toBe(
			"match",
		);
		expect(
			classifyMeterIdentity(
				"hdmirx",
				"fddf8000.i2s-i2s-hifi i2s-hifi-0",
				aliases,
			),
		).toBe("match");
	});

	test("two DIFFERENT known cards are foreign, in either vocabulary", () => {
		const aliases = boardAliases();
		expect(classifyMeterIdentity("usbaudio", "hdmirx", aliases)).toBe(
			"foreign",
		);
		expect(
			classifyMeterIdentity(
				"USB Audio",
				"fddf8000.i2s-i2s-hifi i2s-hifi-0",
				aliases,
			),
		).toBe("foreign");
	});

	test("an unreadable vocabulary is UNKNOWN, which never suppresses", () => {
		const aliases = boardAliases();
		expect(classifyMeterIdentity("usbaudio", "who-knows", aliases)).toBe(
			"unknown",
		);
		expect(classifyMeterIdentity("who-knows", "usbaudio", aliases)).toBe(
			"unknown",
		);
		expect(classifyMeterIdentity(undefined, "usbaudio", aliases)).toBe(
			"unknown",
		);
		expect(classifyMeterIdentity("usbaudio", undefined, aliases)).toBe(
			"unknown",
		);
		expect(classifyMeterIdentity("usbaudio", "hdmirx", new Map())).toBe(
			"unknown",
		);
	});
});

describe("the naming ladder joins on the SAME vocabulary", () => {
	const aliases = boardAliases();

	test("an engine row is found for a card the engine names differently", () => {
		const identities = resolveAudioIdentities(
			{ "USB audio": "usbaudio", hdmirx: "hdmirx" },
			BOARD_ENGINE_AUDIO,
			aliases,
		);
		// Board-measured: without the alias join BOTH rows came back empty, so the
		// frontend had no `stable_id` to bind the meter's device name to.
		expect(identities.get("USB audio")?.stable_id).toBe("card:USB Audio");
		expect(identities.get("hdmirx")?.stable_id).toBe(
			"card:fddf8000.i2s-i2s-hifi i2s-hifi-0",
		);
	});

	test("a card's own PCM id is never surfaced as its product name", () => {
		const identities = resolveAudioIdentities(
			{ "USB audio": "usbaudio", hdmirx: "hdmirx" },
			BOARD_ENGINE_AUDIO,
			aliases,
		);
		// The engine reports `hdmirx`'s product_name AS its PCM id. The frontend
		// prefers product_name over the label, so surfacing it would render the
		// operator's "HDMI Input" row as `fddf8000.i2s-i2s-hifi i2s-hifi-0`.
		expect(identities.get("hdmirx")?.product_name).toBeUndefined();
		// A real product name still rides.
		expect(identities.get("USB audio")?.product_name).toBe(
			"DJI Technology Co., Ltd. DJI MIC MINI",
		);
	});

	test("isHumanAudioName rejects every name the board files under the card", () => {
		expect(isHumanAudioName("USB Audio", "usbaudio", aliases)).toBe(false);
		expect(isHumanAudioName("usbaudio", "usbaudio", aliases)).toBe(false);
		expect(isHumanAudioName("DJI MIC MINI", "usbaudio", aliases)).toBe(true);
		// With no vocabulary the historical card-id-only rule stands.
		expect(isHumanAudioName("USB Audio", "usbaudio")).toBe(true);
	});
});
