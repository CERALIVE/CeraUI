import { describe, expect, test } from "bun:test";
import type { CardAliases } from "../modules/streaming/audio-card-vocabulary.ts";
import {
	buildCardAliases,
	buildCardAliasOwners,
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

// TWO identical-model USB sound cards. The kernel gives each its own card id
// (`snd_usb_audio` suffixes the second), and BOTH report the generic PCM id
// `USB Audio` — so that name is a real alias of two different cards.
const TWIN_PROC_ASOUND_PCM = `01-00: USB Audio : USB Audio : capture 1
02-00: USB Audio : USB Audio : capture 1
`;

const TWIN_CARDS = [
	{ index: 1, id: "usbaudio" },
	{ index: 2, id: "usbaudio_1" },
];

// The PipeWire arm resolves BOTH nodes' join key to that same PCM id.
const TWIN_ENGINE_AUDIO: EngineAudioDevice[] = [
	{
		input_id: "alsa_input.usb-first",
		alsa_card_id: "USB Audio",
		stable_id: "node.first",
	},
	{
		input_id: "alsa_input.usb-second",
		alsa_card_id: "USB Audio",
		stable_id: "node.second",
	},
];

function twinAliases(): CardAliases {
	return buildCardAliases(TWIN_CARDS, parseProcAsoundPcm(TWIN_PROC_ASOUND_PCM));
}

describe("an AMBIGUOUS alias identifies nobody", () => {
	test("the reverse index records the collision instead of a winner", () => {
		const owners = buildCardAliasOwners(twinAliases());
		expect(owners.get("USB Audio")).toBeNull();
		expect(owners.get("usbaudio")).toBe("usbaudio");
		expect(owners.get("usbaudio_1")).toBe("usbaudio_1");
		expect(buildCardAliasOwners(boardAliases()).get("USB Audio")).toBe(
			"usbaudio",
		);
	});

	test("the SECOND twin is never routed to the FIRST one's engine row", () => {
		const aliases = twinAliases();
		// The defect: `USB Audio` is an alias of BOTH cards, so a first-match
		// lookup answered the second card with the first card's node.
		expect(
			engineAudioDeviceForCard("usbaudio_1", TWIN_ENGINE_AUDIO, aliases),
		).toBeUndefined();
		// …and it must not silently claim the first card either — the shared name
		// proves nothing about which unit the engine is describing.
		expect(
			engineAudioDeviceForCard("usbaudio", TWIN_ENGINE_AUDIO, aliases),
		).toBeUndefined();
	});

	test("the unresolved card falls back to the caller's own device string", () => {
		const aliases = twinAliases();
		expect(
			engineAudioDeviceString(
				"usbaudio_1",
				"hw:CARD=usbaudio_1",
				TWIN_ENGINE_AUDIO,
				aliases,
			),
		).toBe("hw:CARD=usbaudio_1");
	});

	test("a meter reading on the shared alias is UNKNOWN, never foreign", () => {
		const aliases = twinAliases();
		// `foreign` asserts a mismatch this board cannot prove and SUPPRESSES the
		// reading; `unknown` is the honest verdict for a genuinely ambiguous name.
		expect(classifyMeterIdentity("usbaudio_1", "USB Audio", aliases)).toBe(
			"unknown",
		);
		expect(classifyMeterIdentity("USB Audio", "usbaudio_1", aliases)).toBe(
			"unknown",
		);
		expect(canonicalCardId("USB Audio", aliases)).toBeUndefined();
	});

	test("each twin still answers to its OWN kernel card id", () => {
		const aliases = twinAliases();
		expect(canonicalCardId("usbaudio_1", aliases)).toBe("usbaudio_1");
		expect(classifyMeterIdentity("usbaudio_1", "usbaudio_1", aliases)).toBe(
			"match",
		);
		// Two DIFFERENT kernel ids are still provably foreign.
		expect(classifyMeterIdentity("usbaudio", "usbaudio_1", aliases)).toBe(
			"foreign",
		);
	});

	test("an ALSA-arm engine names the twins apart, so both still resolve", () => {
		const aliases = twinAliases();
		const alsaArm: EngineAudioDevice[] = [
			{ input_id: "hw:CARD=usbaudio", alsa_card_id: "usbaudio" },
			{ input_id: "hw:CARD=usbaudio_1", alsa_card_id: "usbaudio_1" },
		];
		expect(
			engineAudioDeviceForCard("usbaudio", alsaArm, aliases)?.input_id,
		).toBe("hw:CARD=usbaudio");
		expect(
			engineAudioDeviceForCard("usbaudio_1", alsaArm, aliases)?.input_id,
		).toBe("hw:CARD=usbaudio_1");
	});

	test("a genuinely UNIQUE alias is unaffected — the board's own case", () => {
		const aliases = boardAliases();
		expect(canonicalCardId("USB Audio", aliases)).toBe("usbaudio");
		expect(
			engineAudioDeviceForCard("usbaudio", BOARD_ENGINE_AUDIO, aliases)
				?.stable_id,
		).toBe("card:USB Audio");
		expect(
			engineAudioDeviceForCard("hdmirx", BOARD_ENGINE_AUDIO, aliases)
				?.stable_id,
		).toBe("card:fddf8000.i2s-i2s-hifi i2s-hifi-0");
		expect(classifyMeterIdentity("usbaudio", "USB Audio", aliases)).toBe(
			"match",
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
