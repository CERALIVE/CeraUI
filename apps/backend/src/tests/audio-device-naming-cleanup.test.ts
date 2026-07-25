/*
 * Operator-facing audio-device naming (device-quality-wave2).
 *
 * The two live-reported regressions this locks, captured verbatim from the
 * reporting board's `/proc/asound/cards` and cerastream `list-devices`:
 *
 *   card 5 usbaudio  "RØDE RØDE HDMI to USB-C at usb-xhci-hcd.17.auto-1, super speed"
 *   card 6 MINI      "DJI Technology Co., Ltd. DJI MIC MINI at usb-fc8c0000.usb-1, full speed"
 *
 * The RØDE leaked through TIER 1 (cerastream sets an audio entry's `display_name`
 * to the ALSA longname verbatim, and its `product_name` was the generic
 * "usbaudio" the human-name heuristic rejects); the DJI leaked through TIER 2
 * (no engine entry at all, so the raw `/proc/asound/cards` longname was used).
 * Both tiers are now cleaned, and the raw string is preserved as `detail`.
 */
import { describe, expect, test } from "bun:test";
import {
	cleanAudioDeviceName,
	type EngineAudioDevice,
	resolveAudioDisplays,
	resolveOnboardDisplayName,
} from "../modules/streaming/audio-naming.ts";

const RODE_LONGNAME =
	"RØDE RØDE HDMI to USB-C at usb-xhci-hcd.17.auto-1, super speed";
const DJI_LONGNAME =
	"DJI Technology Co., Ltd. DJI MIC MINI at usb-fc8c0000.usb-1, full speed";

describe("cleanAudioDeviceName — bus/speed suffix", () => {
	test("strips the kernel `at <bus-path>, <speed> speed` tail and keeps it as detail", () => {
		expect(cleanAudioDeviceName(DJI_LONGNAME)).toEqual({
			name: "DJI MIC MINI",
			detail: DJI_LONGNAME,
		});
	});

	test("handles every USB link speed the kernel emits", () => {
		for (const speed of ["low", "full", "high", "super", "super+"]) {
			expect(
				cleanAudioDeviceName(`Acme Mic at usb-fc8c0000.usb-1, ${speed} speed`)
					.name,
			).toBe("Acme Mic");
		}
	});

	test("leaves a product name that merely CONTAINS ' at ' untouched", () => {
		const raw = "Sound at Work Studio Mic";
		expect(cleanAudioDeviceName(raw)).toEqual({ name: raw });
	});

	test("leaves an ' at <path>' with no trailing speed word untouched", () => {
		const raw = "Acme Mic at usb-fc8c0000.usb-1";
		expect(cleanAudioDeviceName(raw)).toEqual({ name: raw });
	});
});

describe("cleanAudioDeviceName — duplicated manufacturer prefix", () => {
	test("drops an immediately repeated manufacturer token", () => {
		expect(cleanAudioDeviceName(RODE_LONGNAME)).toEqual({
			name: "RØDE HDMI to USB-C",
			detail: RODE_LONGNAME,
		});
	});

	test("drops a repeat bridged only by corporate filler", () => {
		expect(
			cleanAudioDeviceName("DJI Technology Co., Ltd. DJI MIC MINI").name,
		).toBe("DJI MIC MINI");
	});

	test("matches the manufacturer case-insensitively, keeping the survivor's casing", () => {
		expect(cleanAudioDeviceName("Elgato ELGATO Wave XLR").name).toBe(
			"ELGATO Wave XLR",
		);
	});

	test("ignores punctuation when comparing tokens", () => {
		expect(cleanAudioDeviceName("Acme, Acme Studio Mic").name).toBe(
			"Acme Studio Mic",
		);
	});

	// Ø (U+00D8) is a distinct letter, not a decomposable diacritic, so
	// "Rode"/"RØDE" are genuinely different tokens. Collapsing them would need a
	// vendor-specific transliteration table — deliberately out of scope, since a
	// wrong collapse silently mangles a real product name.
	test("does NOT collapse a prefix that differs by more than case", () => {
		const raw = "Rode RØDE NT-USB";
		expect(cleanAudioDeviceName(raw)).toEqual({ name: raw });
	});

	test("does NOT collapse a product name that legitimately repeats a word", () => {
		for (const raw of [
			"Blue Microphones Yeti Blue",
			"Focusrite Scarlett Solo",
			"Elgato Cam Link 4K",
			"Shure MV7 Podcast Microphone",
		]) {
			expect(cleanAudioDeviceName(raw)).toEqual({ name: raw });
		}
	});

	test("never empties a single-token or repeated-only name", () => {
		expect(cleanAudioDeviceName("usbaudio")).toEqual({ name: "usbaudio" });
		expect(cleanAudioDeviceName("RØDE RØDE").name).toBe("RØDE RØDE");
	});

	test("is idempotent — cleaning a cleaned name is a no-op", () => {
		for (const raw of [RODE_LONGNAME, DJI_LONGNAME]) {
			const once = cleanAudioDeviceName(raw).name;
			expect(cleanAudioDeviceName(once)).toEqual({ name: once });
		}
	});
});

describe("resolveOnboardDisplayName — static, code-level rules", () => {
	test("names the RK3588 HDMI-RX card from its ALSA card id", () => {
		expect(resolveOnboardDisplayName("rockchiphdmiin")).toBe("HDMI Input");
	});

	test("matches the same block through its raw driver/longname spelling", () => {
		for (const raw of [
			"rockchip,hdmiin",
			"rockchip_hdmiin",
			"ROCKCHIP-HDMIIN",
		]) {
			expect(resolveOnboardDisplayName("whatever", raw)).toBe("HDMI Input");
		}
	});

	test("names the onboard analog codec", () => {
		expect(resolveOnboardDisplayName("rockchipes8388")).toBe("Onboard Audio");
	});

	test("leaves an external device alone — no rule, no rewrite", () => {
		expect(
			resolveOnboardDisplayName("usbaudio", RODE_LONGNAME),
		).toBeUndefined();
		expect(resolveOnboardDisplayName("MINI", DJI_LONGNAME)).toBeUndefined();
	});
});

describe("resolveAudioDisplays — the live board scenario", () => {
	const cards = {
		HDMI: "rockchiphdmiin",
		"USB audio": "usbaudio",
		MINI: "MINI",
	};
	// The RØDE as cerastream actually reports it: display_name IS the longname,
	// and product_name is the generic card id the heuristic rejects.
	const engine: EngineAudioDevice[] = [
		{
			input_id: RODE_LONGNAME,
			display_name: RODE_LONGNAME,
			alsa_card_id: "usbaudio",
			product_name: "usbaudio",
			transport: "usb",
			stable_id: "card:usbaudio",
		},
	];
	const longnames = new Map([
		["rockchiphdmiin", "rockchip,hdmiin"],
		["usbaudio", RODE_LONGNAME],
		["MINI", DJI_LONGNAME],
	]);

	test("cleans the tier-1 leak (RØDE) and preserves the raw string as detail", () => {
		const display = resolveAudioDisplays(cards, engine, longnames).get(
			"USB audio",
		);
		expect(display?.label).toBe("RØDE HDMI to USB-C");
		expect(display?.detail).toBe(RODE_LONGNAME);
	});

	test("cleans the tier-2 leak (DJI Mic Mini) with no engine entry at all", () => {
		const display = resolveAudioDisplays(cards, engine, longnames).get("MINI");
		expect(display?.label).toBe("DJI MIC MINI");
		expect(display?.detail).toBe(DJI_LONGNAME);
	});

	test("names the onboard HDMI-RX card by rule, keeping the raw id as detail", () => {
		const display = resolveAudioDisplays(cards, engine, longnames).get("HDMI");
		expect(display?.label).toBe("HDMI Input");
		expect(display?.detail).toBe("rockchip,hdmiin");
	});
});

describe("resolveAudioDisplays — onboard rules are code-level, not operator input", () => {
	const cards = {
		HDMI: "rockchiphdmiin",
		"USB audio": "usbaudio",
		MINI: "MINI",
	};
	const longnames = new Map([
		["rockchiphdmiin", "rockchip,hdmiin"],
		["usbaudio", RODE_LONGNAME],
		["MINI", DJI_LONGNAME],
	]);

	test("a rule applies to its own card only — it never bleeds across cards", () => {
		const displays = resolveAudioDisplays(cards, [], longnames);
		expect(displays.get("HDMI")?.label).toBe("HDMI Input");
		expect(displays.get("USB audio")?.label).toBe("RØDE HDMI to USB-C");
		expect(displays.get("MINI")?.label).toBe("DJI MIC MINI");
	});

	test("the rule wins over an engine-supplied name for the same card", () => {
		const engine: EngineAudioDevice[] = [
			{
				input_id: "audio:rockchiphdmiin",
				display_name: "rockchip,hdmiin",
				alsa_card_id: "rockchiphdmiin",
				product_name: "rk_hdmiin",
				transport: "hdmi",
			},
		];
		const display = resolveAudioDisplays(cards, engine, longnames).get("HDMI");
		expect(display?.label).toBe("HDMI Input");
		expect(display?.detail).toBe("rk_hdmiin");
	});

	test("a card with no rule and no cleanable name is passed through verbatim", () => {
		const displays = resolveAudioDisplays({ Odd: "oddcard" }, [], new Map());
		expect(displays.get("Odd")?.label).toBe("Odd");
		expect(displays.get("Odd")?.detail).toBeUndefined();
	});

	test("two cards resolving to the same name still dedupe", () => {
		const displays = resolveAudioDisplays(
			{ A: "rockchiphdmiin", B: "rockchiphdmiind" },
			[],
			new Map(),
		);
		expect(displays.get("A")?.label).toBe("HDMI Input");
		expect(displays.get("B")?.label).toBe("HDMI Input (2)");
	});
});
